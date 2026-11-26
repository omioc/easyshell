/**
 * The password prompt a user should only have to answer once.
 *
 * A login typed into a terminal — `ssh root@198.51.100.9`, and the `ssh` after it —
 * reads its password from the same tty the app types on. That makes two things
 * possible, and this module owns both:
 *
 *   - When the prompt appears, ask whether to use a password the app already
 *     has for exactly this `user@host`, and type it if the user says yes.
 *   - When the user answers the prompt themselves and the login then lands, ask
 *     whether to keep that password for next time.
 *
 * Nothing happens without an answer: no password is typed and nothing is saved
 * until the user confirms in the popover. And nothing is captured that is not a
 * password — a `yes/no` host-key question and a key passphrase are not a login
 * password and are left alone.
 *
 * A `sudo` or a `su` prompt does ask for a password, so the first half above
 * applies to it: `sudo` wants the password of the account already logged in and
 * `su` the one it switches to, and either may be in the vault. The second half
 * does not — nothing is ever offered to keep, because a switch that worked and a
 * switch that did not look the same from here, and remembering a password on
 * that resemblance is a guess.
 */

import {
  credentialKey,
  credentialLabel,
  credentialPort,
  findCredential,
  hasPassword,
  touchCredential,
  upsertCredential,
} from '../../shared/credentials';
import type { CredentialRequest, SessionHop, SshCredential } from '../../shared/types';
import { looksLikePasswordPrompt, passwordPromptTarget, sudoPromptUser, typedAnswer } from './injection';

/** The login a prompt belongs to. */
interface Target {
  username: string;
  host: string;
  port?: number;
  /** The machine's other name, when the vault may have keyed the login on it. */
  alias?: string;
  /** The prompt asks about the account already here, not about a login. */
  escalation?: boolean;
}

/** What this desk needs from the session it watches. */
export interface CredentialDeskHost {
  /** The login a submitted command is aiming at, while it is still in flight. */
  candidate(): SessionHop | null;
  /** The top of the location chain: the login that has landed. */
  landed(): SessionHop | null;
  /** Chain length, so a login that lands can be told from one that has not. */
  depth(): number;
  /** The account standing here now: this shell's own login on this machine. */
  login(): { username?: string; host?: string; hostname?: string; port?: number } | null;
  /** What the last submitted line says the machine may ask a password for. */
  escalation(): { via: 'sudo' | 'su'; account?: string } | null;
  /** The last few hundred characters on screen. */
  tail(): string;
  credentials(): SshCredential[];
  replaceCredentials(next: SshCredential[]): void;
  /** Types an answer into the waiting prompt and submits it. */
  typeSecret(password: string): void;
  /** Asks the terminal's popover a question; `null` retracts it. */
  ask(request: CredentialRequest | null): void;
  /** The password is now in the vault. */
  saved(label: string): void;
}

/** A password the user typed at a prompt, waiting for the login to confirm it. */
interface Pending extends Target {
  password: string;
  /** Chain length when the answer was typed: a landing makes it longer. */
  depth: number;
}

export class CredentialDesk {
  /** The login whose password prompt is on screen and unanswered. */
  private target: Target | null = null;
  /** What has been typed into it since it appeared. */
  private typed = '';
  /** A typed password whose login has not been confirmed yet. */
  private pending: Pending | null = null;
  /** What the renderer is currently asking the user. */
  private request: CredentialRequest | null = null;
  /** Logins the user said "not now" to a fill for, in this tab. */
  private readonly skippedFill = new Set<string>();
  /** Logins whose password the user declined to keep, in this tab. */
  private readonly skippedSave = new Set<string>();

  constructor(private readonly host: CredentialDeskHost) {}

  /**
   * Output arrived: is a password prompt waiting, and for whom?
   *
   * Only a login that was typed here can ask: the session's own password is
   * supplied by the connection before any prompt exists, and `su`/`sudo` answer
   * with the password of the account already in use, which is not the login the
   * chain is about to show.
   */
  onOutput(): void {
    const aiming = this.aimedTarget();
    const asking = aiming !== null && looksLikePasswordPrompt(this.host.tail());
    if (!asking) {
      this.target = null;
      this.typed = '';
      // The prompt went away without an answer (a timeout, a killed login): the
      // question it raised is no longer the question on screen.
      if (this.request?.kind === 'fill') this.ask(null);
      return;
    }

    const appeared = this.target === null || credentialKey(this.target) !== credentialKey(aiming);
    this.target = aiming;
    if (!appeared) return;
    this.typed = '';
    // The question names the entry, not the address it was asked about: two
    // names for one machine are one password, and the popover should say which
    // one it is offering.
    const saved = this.savedFor(aiming);
    if (saved && !this.skippedFill.has(credentialKey(saved))) {
      this.ask({ kind: 'fill', ...this.targetOf(saved), label: credentialLabel(saved) });
      return;
    }
    this.ask(null);
  }

  /** The user typed: a secret, an Enter, or nothing that concerns this desk. */
  onInput(data: string): void {
    // Whatever is being typed, the question has been answered by hand.
    if (this.request) {
      const wasSave = this.request.kind === 'save';
      this.ask(null);
      // Typing at the shell instead of answering means the moment has passed:
      // the password is not kept, and a question about it that came back later
      // — on the next prompt the tab happens to paint — would come out of
      // nowhere.
      if (wasSave) this.pending = null;
    }
    if (!this.target) return;

    if (data.includes('\x03')) {
      // Ctrl-C at the prompt: the line is thrown away, so is the prompt.
      this.target = null;
      this.typed = '';
      return;
    }

    const submitted = data.includes('\r') || data.includes('\n');
    const line = typedAnswer(this.typed, data);
    if (!submitted) {
      this.typed = line;
      return;
    }

    const target = this.target;
    this.target = null;
    this.typed = '';
    if (!line) return;
    // A `sudo` / `su` prompt asks for an account that is not a login of its own:
    // whether the password was right shows up as the machine simply carrying
    // on, which is what a wrong one looks like too. Only a password typed at a
    // login is held for a confirmation that could come.
    if (target.escalation) return;
    // Held until something says this login landed — a prompt for another shell,
    // a deeper chain: a password typed at a prompt that never let anyone in is
    // not worth remembering.
    this.pending = { ...this.targetOf(target), password: line, depth: this.host.depth() };
  }

  /**
   * A login is now on screen that may be the one a password was typed for.
   *
   * `identity` is the `user@host` of a prompt that was not there before: the
   * shell of the login painting, which is evidence on its own — the prompt that
   * was waiting is gone and something got through it. Nothing else has to grow
   * for that to be true, and requiring it is what once swallowed a password that
   * was typed again after a refusal.
   *
   * Without an identity the chain is asked instead, and only a hop it committed
   * counts: that is the path for a login confirmed by a title rather than by a
   * prompt, where the address the machine reports must not be mistaken for a
   * change of login.
   */
  onLanded(identity?: { username: string; host: string }): void {
    const pending = this.pending;
    if (!pending) return;
    const username = identity?.username ?? this.host.landed()?.username;
    if (!username) return;
    if (!identity && this.host.depth() <= pending.depth) return;
    if (username.toLowerCase() !== pending.username.toLowerCase()) return;

    // The password stays here until the question is answered: it is the answer,
    // and asking about it before it is kept would leave nothing to keep.
    const credentials = this.host.credentials();
    if (hasPassword(credentials, pending, pending.password)) {
      this.pending = null;
      return;
    }
    if (this.skippedSave.has(credentialKey(pending))) {
      this.pending = null;
      return;
    }
    this.ask({ kind: 'save', ...this.targetOf(pending), label: credentialLabel(pending) });
  }

  /** The move this password was typed for was refused or abandoned. */
  onAttemptFailed(): void {
    this.pending = null;
    this.target = null;
    this.typed = '';
  }

  /** The popover was answered. */
  respond(decision: 'accept' | 'dismiss'): void {
    const request = this.request;
    if (!request) return;
    this.ask(null);
    const key = credentialKey(request);
    if (decision === 'dismiss') {
      // Two questions, two answers: declining a fill says nothing about keeping
      // the password the user then types by hand, and an outdated entry is
      // exactly how that pair happens.
      if (request.kind === 'fill') {
        this.skippedFill.add(key);
        return;
      }
      this.skippedSave.add(key);
      // "Not now" for a password that was typed means it is not kept either —
      // the answer covers the whole question, not just the popover.
      this.pending = null;
      return;
    }

    if (request.kind === 'fill') {
      const saved = findCredential(this.host.credentials(), request);
      if (!saved) return;
      // The prompt stays where it is: more of it may still arrive in the next
      // chunk, and asking again for the same line would stack popovers. Only the
      // half-typed line is dropped — the app is typing the answer now.
      this.typed = '';
      this.host.replaceCredentials(touchCredential(this.host.credentials(), saved.id));
      this.host.typeSecret(saved.password);
      return;
    }

    const pending = this.pending;
    if (!pending || credentialKey(pending) !== key) return;
    this.pending = null;
    const now = Date.now();
    const entry: SshCredential = {
      id: '',
      username: pending.username,
      host: pending.host,
      port: credentialPort(pending.port),
      password: pending.password,
      createdAt: now,
      updatedAt: now,
    };
    this.host.replaceCredentials(upsertCredential(this.host.credentials(), entry));
    this.host.saved(request.label);
  }

  /** Forget the whole conversation: the tab is going away. */
  reset(): void {
    this.target = null;
    this.typed = '';
    this.pending = null;
    // No question is retracted: the tab is going away, and whoever was drawing
    // the popover drops it with the tab.
    this.request = null;
  }

  /**
   * The login the password prompt on screen belongs to.
   *
   * The prompt answers this itself when it can: `ssh` prints the destination
   * into it, and a prompt names the same login however the command got there —
   * a retry that came from history, a line the app never classified, a login
   * whose typed line a refusal dropped.
   *
   * A prompt that names nobody is left to the typed line: the login it aims at
   * (`ssh host` with no user), and — when the line moves nowhere — the account
   * a `sudo` / `su` is about to authenticate.
   */
  private aimedTarget(): Target | null {
    const named = passwordPromptTarget(this.host.tail());
    const candidate = this.host.candidate();
    if (named) {
      // The port belongs to the typed line: the prompt never names one, and a
      // port from an attempt at another address would key the entry wrongly.
      const port = this.sameHost(candidate?.host, named.host) ? candidate?.port : undefined;
      return { username: named.username, host: named.host, port };
    }
    if (!candidate?.host) return this.escalatedTarget();
    // `ssh host` without a user logs in as the account already in use; that is
    // the name the vault has to key on, so it is the one used here.
    const username = candidate.username ?? this.host.landed()?.username;
    if (!username) return null;
    return { username, host: candidate.host, port: candidate.port };
  }

  /**
   * The account a `sudo` / `su` prompt is asking about.
   *
   * A bare `Password:` names nobody, and `[sudo] password for alice:` names the
   * account already logged in rather than the one being entered. The command is
   * the better witness, because it says which of the two questions is being
   * asked: `sudo` authenticates the account running it, `su` the one it switches
   * to. The prompt is the fallback for when there is no command line to read —
   * a `sudo` recalled from history — and it is enough for `sudo`, whose prompt
   * prints the invoking account. Either way the vault keys the answer by
   * `account@machine`, which is what this hands it.
   *
   * The machine is the hop the user is standing on, and that hop knows two
   * names: the address it was dialed on and the name it calls itself. The entry
   * was keyed on whichever one the login that stored it happened to show, so
   * both are offered to the lookup — the account is the part that has to match.
   */
  private escalatedTarget(): Target | null {
    const here = this.host.login();
    const host = here?.host ?? here?.hostname;
    if (!here || !host) return null;
    const escalation = this.host.escalation();
    const username = escalation
      ? escalation.via === 'su'
        ? escalation.account
        : here.username
      : sudoPromptUser(this.host.tail())?.username;
    if (!username) return null;
    const alias = here.hostname && here.hostname !== host ? here.hostname : undefined;
    // Nothing at this prompt is a login to confirm, so nothing typed at it can
    // be offered for keeping: the machine carries on whether it worked or not.
    return { username, host, port: here.port, alias, escalation: true };
  }

  /** The vault entry a prompt's login can be answered with. */
  private savedFor(target: Target): SshCredential | undefined {
    const credentials = this.host.credentials();
    if (!target.alias) return findCredential(credentials, target);
    return (
      findCredential(credentials, target) ??
      findCredential(credentials, { username: target.username, host: target.alias })
    );
  }

  private sameHost(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.toLowerCase() === b.toLowerCase();
  }

  private targetOf(target: Target): Target {
    return { username: target.username, host: target.host, port: target.port };
  }

  private ask(request: CredentialRequest | null): void {
    if (this.request === null && request === null) return;
    if (
      this.request &&
      request &&
      this.request.kind === request.kind &&
      credentialKey(this.request) === credentialKey(request)
    ) {
      return;
    }
    this.request = request;
    this.host.ask(request);
  }
}
