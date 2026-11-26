/**
 * Nested login detection.
 *
 * A session can change location without the app knowing: the user types
 * `ssh inner-host` inside a bastion session, and from that moment the metadata
 * that used to describe the bastion is describing the wrong machine.
 *
 * Two independent signals are used, both cheap and both free of any shell
 * integration on the remote side:
 *
 *   1. the command line the user typed (we own the PTY input stream);
 *   2. terminal titles (`OSC 0` / `OSC 2`) that most shells emit as
 *      `user@host: cwd`.
 *
 * Both are heuristics, so every produced hop carries `confidence` and
 * `detectedBy`, and nothing a typed line produces is a hop on its own: it is a
 * candidate the manager only puts on the chain when the other side confirms it.
 * The UI shows how a hop was found.
 */

import type { SessionHop } from '../../shared/types';

export type NestedSignal =
  /**
   * A submitted line that *aims* at another place. It is a candidate, not a
   * hop: the manager only puts it on the chain once the shell on the other side
   * says the user got there.
   */
  | { type: 'push'; hop: SessionHop }
  /**
   * What the line the user just submitted says the machine may ask a password
   * for: `sudo` authenticates the account running it, `su` the one it switches
   * to. `via: null` is a line that asks for no password at all — which is how a
   * `sudo` stops being believed once the user has moved on to something else.
   */
  | { type: 'escalation'; via: 'sudo' | 'su' | null; account?: string }
  /**
   * One report of leaving a hop. `origin` says whether the user typed it or a
   * layer of the stack printed it, and `host` names the machine a printed
   * report is about (`Connection to 198.18.0.9 closed.`): both are what tells a
   * report that describes a departure already counted from one that does not.
   */
  | { type: 'pop'; origin: 'typed' | 'printed'; host?: string; reason: string }
  | { type: 'title'; host?: string; username?: string; label: string }
  /** The attempt to move reported that it never got there. */
  | { type: 'failed'; reason: string }
  /** The user threw the move away before it happened (`Ctrl-C`). */
  | { type: 'cancelled'; reason: string };

const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Port `ssh` uses when the command line names none. */
export const SSH_DEFAULT_PORT = 22;

const CONNECTION_CLOSED = /(?:Connection to|Shared connection to)\s+(\S+)\s+closed\./g;

/**
 * What may stand in front of a report on the line it is printed on: spacing, the
 * BEL a shell rings as it gives up, and the mode switches it turns off on the
 * way out (`\x1b[?2004l`). A report is never preceded by words.
 */
const REPORT_LEAD =
  '(?:[^\\S\\r\\n]|\\x07|\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\))*';

/**
 * The line a shell prints when it takes itself away because nobody typed
 * anything for too long.
 *
 * `readonly TMOUT=600` in `/etc/profile` is how most servers enforce an idle
 * logout: bash leaves with `timed out waiting for input: auto-logout`, tcsh with
 * `auto-logout`. bash prints no `logout` for this — that line belongs to a shell
 * left by something the user did — so without this report the hop the user was
 * logged out of has nothing to pop it. The prompt of the shell underneath is not
 * a replacement: a plain `PS1` (`$ `, `# `) names no account, and the chain then
 * kept showing the account the user had already been logged out of.
 */
const AUTO_LOGOUT = new RegExp(
  `(?:^|[\\r\\n])${REPORT_LEAD}(?:timed out waiting for input(?:: auto-logout)?|auto-logout)(?=[\\r\\n]|$)`,
  'i',
);

/**
 * Text that ends an attempt to move: the login or the user switch reported
 * that it is over and the user is still where they were.
 *
 * Only terminal reports belong here. Both `sudo` and `ssh` accept a retry, so
 * `Sorry, try again.` and `Permission denied, please try again.` mean "not
 * yet", not "no".
 */
const MOVED_NOWHERE =
  /(?:^|[\r\n])\s*(?:\S+:\s*)?(?:su: Authentication failure|su: user \S+ does not exist|Authentication failure|sudo: \d+ incorrect password attempts|sudo: no password was provided|sudo: a password is required|su: a terminal is required|a terminal is required|\S+ is not in the sudoers file|\S+ is not allowed to execute|Permission denied \(|Connection refused|Connection timed out|Connection closed by|No route to host|Could not resolve hostname|Could not resolve host|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Name or service not known)/;

/**
 * One logout is reported three times — the typed `exit`, the shell's `logout`
 * and the client's `Connection to … closed.` — and all three describe the same
 * hop. They arrive together, so a printed pop that follows another within this
 * window only names what was already counted. A typed line is never folded:
 * a second `exit` still ends a second hop.
 */
const POP_EPISODE_MS = 5000;

/** Output kept between chunks so a line split across two of them still reads once. */
const POP_TAIL = 256;

function splitHostUser(target: string): { host: string; username?: string } {
  const at = target.lastIndexOf('@');
  if (at < 0) return { host: target };
  return { host: target.slice(at + 1), username: target.slice(0, at) || undefined };
}

/** Extracts `host`, `user`, `port` from the arguments of an ssh/mosh command. */
export function parseSshTarget(args: string): { host: string; username?: string; port?: number } | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let port: number | undefined;
  let username: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === '-p' || token === '--port') {
      const value = Number(tokens[i + 1]);
      if (Number.isFinite(value) && value > 0) port = value;
      i += 1;
      continue;
    }
    if (token === '-l' || token === '--user') {
      username = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === '-i' || token === '-o' || token === '-F' || token === '-J') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!target) {
      target = token;
      continue;
    }
    // First non-flag token is the destination; anything after it is a remote
    // command and must not be mistaken for a second host.
    break;
  }

  if (!target) return null;
  const parsed = splitHostUser(target);
  if (!parsed.host) return null;
  return { host: parsed.host, username: username ?? parsed.username, port };
}

/**
 * The line the user is on, built the way the shell's own line editor builds it.
 *
 * The app reads the keystroke stream, not the line: `ssh root@203.0.113.4`
 * arrives after somebody typed `… .3`, pressed backspace and then `4`. Treating
 * those bytes as text — deleting the control character and keeping the `3` —
 * is what once produced a hop to `203.0.113.34`, a machine nobody typed.
 *
 * Keys whose effect cannot be modelled from this side (history recall, tab
 * completion, a search, an unmodelled escape sequence) mark the line
 * `doubtful`: the line is still read, but nothing is classified from it,
 * because a wrong host in the chain is worse than a missing one.
 */
class CommandLine {
  private text = '';
  private cursor = 0;
  private doubtful = false;

  get length(): number {
    return this.text.length;
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  get isDoubtful(): boolean {
    return this.doubtful;
  }

  get value(): string {
    return this.text;
  }

  reset(): void {
    this.text = '';
    this.cursor = 0;
    this.doubtful = false;
  }

  /** Something the app cannot follow happened to this line. */
  doubt(): void {
    this.doubtful = true;
  }

  type(text: string): void {
    this.text = `${this.text.slice(0, this.cursor)}${text}${this.text.slice(this.cursor)}`;
    this.cursor += text.length;
  }

  /** Backspace: the character before the cursor goes. */
  backspace(): void {
    if (this.cursor === 0) return;
    this.text = `${this.text.slice(0, this.cursor - 1)}${this.text.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  /** Delete: the character under the cursor goes. */
  delete(): void {
    this.text = `${this.text.slice(0, this.cursor)}${this.text.slice(this.cursor + 1)}`;
  }

  move(by: number): void {
    this.cursor = Math.min(this.text.length, Math.max(0, this.cursor + by));
  }

  home(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.text.length;
  }

  /** Ctrl-U: everything before the cursor. */
  killToStart(): void {
    this.text = this.text.slice(this.cursor);
    this.cursor = 0;
  }

  /** Ctrl-K: everything from the cursor on. */
  killToEnd(): void {
    this.text = this.text.slice(0, this.cursor);
  }

  /** Ctrl-W: the word before the cursor, and the blanks in front of it. */
  killWord(): void {
    const head = this.text.slice(0, this.cursor).replace(/\S*\s*$/, '');
    this.text = `${head}${this.text.slice(this.cursor)}`;
    this.cursor = head.length;
  }

  /** Applies one escape sequence the terminal sent. */
  applyEscape(sequence: string): void {
    const final = sequence.slice(-1);
    const csi = sequence.startsWith('\x1b[');
    if (csi && (sequence === '\x1b[3~')) return this.delete();
    if (csi && final === 'D') return this.move(-1);
    if (csi && final === 'C') return this.move(1);
    if (csi && (final === 'H' || sequence === '\x1b[1~' || sequence === '\x1b[7~')) return this.home();
    if (csi && (final === 'F' || sequence === '\x1b[4~' || sequence === '\x1b[8~')) return this.end();
    // Focus reports and bracketed-paste markers say nothing about the line.
    if (sequence === '\x1b[I' || sequence === '\x1b[O') return;
    if (sequence === '\x1b[200~' || sequence === '\x1b[201~') return;
    // History recall replaces the line with something the app never saw.
    if (csi && (final === 'A' || final === 'B')) return this.doubt();
    // Any other control sequence is not a line edit the app has to model.
    if (csi) return;
    // A bare `ESC` plus a key (Alt-Backspace, Alt-D): all of them edit.
    this.doubt();
  }
}

/**
 * Reads one escape sequence starting at `at`, and how many characters it took.
 *
 * A sequence that runs off the end of the chunk is returned as far as it goes:
 * the rest arrives with the next chunk, and the line is marked doubtful by
 * whoever ends up classifying something it could not see.
 */
function readEscape(chunk: string, at: number): { sequence: string; length: number } {
  const next = chunk[at + 1];
  if (next === '[') {
    let index = at + 2;
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return { sequence: chunk.slice(at, index), length: index - at };
  }
  if (next !== ']') {
    if (next === undefined) return { sequence: '\x1b', length: 1 };
    return { sequence: chunk.slice(at, at + 2), length: 2 };
  }

  // OSC: `ESC ]` … terminated by BEL or `ESC \`. Titles and CWD reports arrive
  // on the input stream only as focus/paste noise, never as text.
  let index = at + 2;
  while (index < chunk.length) {
    if (chunk[index] === '\x07') {
      index += 1;
      break;
    }
    if (chunk[index] === '\x1b' && chunk[index + 1] === '\\') {
      index += 2;
      break;
    }
    index += 1;
  }
  return { sequence: chunk.slice(at, index), length: index - at };
}

export class NestedDetector {
  private line = new CommandLine();
  /** Output not read yet: the tail of the last chunk, kept for split lines. */
  private pending = '';
  private lastTitleHost: string | undefined;
  private lastPopAt = 0;

  constructor(private enabled = true) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Feed everything the user typed, key by key.
   *
   * Only a submitted line (`Enter`) can move the chain: everything before it is
   * a line being edited, and half a line is not a command.
   */
  feedInput(chunk: string, now = Date.now()): NestedSignal[] {
    if (!this.enabled) return [];
    const signals: NestedSignal[] = [];

    for (let index = 0; index < chunk.length; index += 1) {
      const key = chunk[index] as string;
      switch (key) {
        case '\r':
        case '\n':
          this.submit(now, signals);
          continue;
        case '\x03':
          // Ctrl-C: the shell throws the line away, and so does the app.
          this.line.reset();
          signals.push({ type: 'cancelled', reason: 'interrupted' });
          continue;
        case '\x04':
          // Ctrl-D on an empty line is the shell saying goodbye.
          if (this.line.isEmpty) signals.push({ type: 'pop', origin: 'typed', reason: 'eof' });
          continue;
        case '\x7f':
        case '\x08':
          this.line.backspace();
          continue;
        case '\x15':
          this.line.killToStart();
          continue;
        case '\x0b':
          this.line.killToEnd();
          continue;
        case '\x17':
          this.line.killWord();
          continue;
        case '\x01':
          this.line.home();
          continue;
        case '\x05':
          this.line.end();
          continue;
        case '\x09':
        case '\x12':
          // Completion and incremental search rewrite the line from the shell's
          // own side: the app stops trusting what it has.
          this.line.doubt();
          continue;
        case '\x1b': {
          const { sequence, length } = readEscape(chunk, index);
          index += length - 1;
          if (length === 1) this.line.doubt();
          else this.line.applyEscape(sequence);
          continue;
        }
        default:
          if (key >= ' ') this.line.type(key);
      }
    }

    // A runaway line means the user is not typing a command (a pasted file, a
    // progress bar, ...). Drop it instead of growing forever.
    if (this.line.length > 4096) this.line.reset();
    return signals;
  }

  /** Classifies the line the user just submitted, then forgets it. */
  private submit(now: number, signals: NestedSignal[]): void {
    const doubtful = this.line.isDoubtful;
    const line = this.line.value;
    this.line.reset();
    if (doubtful) return;
    // Every submitted line is a statement about the next password prompt, and
    // the one it replaces must not survive: a `sudo -i` from two commands ago
    // says nothing about the bare `Password:` on screen now. A bare Enter says
    // nothing either way, so it is left out.
    if (line.trim()) {
      const escalation = parseEscalation(line);
      signals.push(escalation ? { type: 'escalation', ...escalation } : { type: 'escalation', via: null });
    }
    const signal = analyseCommandLine(line, now);
    if (!signal) return;
    // A typed line is the user's own word: it always ends a hop, and it opens
    // the episode the shell's echoes of it belong to.
    if (signal.type === 'pop') this.lastPopAt = now;
    signals.push(signal);
  }

  /** Feed everything the session printed. */
  feedOutput(chunk: string, now = Date.now()): NestedSignal[] {
    if (!this.enabled) return [];
    const signals: NestedSignal[] = [];

    for (const match of chunk.matchAll(OSC_TITLE)) {
      const content = (match[1] ?? '').trim();
      if (!content) continue;
      const parsed = /^(?:([\w.\\-]+)@)?([\w.-]+)[:\s]/.exec(content);
      if (!parsed) continue;
      const username = parsed[1];
      const host = parsed[2];
      if (!host || !/[a-z]/i.test(host)) continue;
      if (host === this.lastTitleHost) continue;
      this.lastTitleHost = host;
      signals.push({ type: 'title', host, username, label: username ? `${username}@${host}` : host });
    }

    // Only text that has not produced a pop yet is read. The tail of the
    // previous chunk is kept so a line split across two of them still matches,
    // and dropped once it has, so one line never counts twice.
    const text = this.pending + chunk;
    let consumed = 0;

    const logout = /(?:^|[\r\n])\s*logout\s*(?:[\r\n]|$)/.exec(text);
    if (logout) {
      consumed = logout.index + logout[0].length;
      if (this.opensPopEpisode(now)) {
        signals.push({ type: 'pop', origin: 'printed', reason: 'logout' });
      }
    }
    // The shell took itself away instead of being left: same departure, printed
    // once, and no `logout` line will ever follow it.
    const timeout = AUTO_LOGOUT.exec(text);
    if (timeout) {
      consumed = Math.max(consumed, timeout.index + timeout[0].length);
      if (this.opensPopEpisode(now)) {
        signals.push({ type: 'pop', origin: 'printed', reason: 'timeout' });
      }
    }
    for (const match of text.matchAll(CONNECTION_CLOSED)) {
      consumed = Math.max(consumed, (match.index ?? 0) + match[0].length);
      if (this.opensPopEpisode(now)) {
        const host = match[1];
        signals.push({ type: 'pop', origin: 'printed', host, reason: `closed:${host ?? ''}` });
      }
    }
    // An attempt that reported it got nowhere: the hop it opened never
    // existed. Matched on what only the final report says — `Sorry, try
    // again.` and `Permission denied, please try again.` are retried by the
    // client itself, and dropping the hop on those would be right about the
    // failed attempt and wrong about the one the user then completes.
    const failed = MOVED_NOWHERE.exec(text);
    if (failed) {
      // Read, and not read again: a failed attempt left in the tail would
      // otherwise be reported against whatever the user tries next.
      consumed = Math.max(consumed, failed.index + failed[0].length);
      signals.push({ type: 'failed', reason: failed[0].trim() });
    }
    this.pending = text.slice(Math.max(consumed, text.length - POP_TAIL));

    return signals;
  }

  /**
   * True when a printed pop describes a logout that has not been counted yet.
   *
   * `exit`, `logout` and `Connection to … closed.` are three reports of one
   * event and land within a few hundred milliseconds of each other. Only the
   * first may take a hop; the other two would take the hop the user is standing
   * on now.
   */
  private opensPopEpisode(now: number): boolean {
    if (now - this.lastPopAt < POP_EPISODE_MS) return false;
    this.lastPopAt = now;
    return true;
  }

  reset(): void {
    this.line.reset();
    this.pending = '';
    this.lastTitleHost = undefined;
    this.lastPopAt = 0;
  }
}

const INPUT_ESCAPE = /\x1b\[[0-9;?]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

/**
 * Terminals report focus, paste and mode changes on the same stream the user
 * types on (`\x1b[I` for focus-in, for example). Those bytes end up glued to the
 * next command line, so they are removed before the line is classified.
 */
export function stripInputNoise(line: string): string {
  return line.replace(INPUT_ESCAPE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Shells a `sudo` may start that hand the user a prompt on another account.
 *
 * `sudo bash` is a root shell; `sudo bash -c 'ls'` is one command, so the
 * arguments decide which one it is.
 */
const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'ksh93',
  'mksh',
  'dash',
  'ash',
  'rbash',
  'tcsh',
  'csh',
]);

/** `sudo` options that take the next token as their value. */
const SUDO_VALUES = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-h',
  '--host',
  '-r',
  '--role',
  '-t',
  '--type',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user',
  '-D',
  '--chdir',
  '-R',
  '--chroot',
]);

/**
 * Reads a line that switches the user and stays there.
 *
 * The account is worth knowing, but the *fact* of the switch is what the chain
 * needs: `su -`, `su - postgres`, `sudo -i`, `sudo su -`, `sudo -s`,
 * `sudo bash` and `sudo -u app -i` all end in a prompt for another user on the
 * machine the user is already on. Recognising only some of them is what left
 * the chain silent after a perfectly ordinary `sudo su -`.
 *
 * A line that runs a command and returns (`su -c`, `sudo bash -c`) changes
 * nothing about where the user is standing, so it is not a switch.
 */
export function parseUserSwitch(command: string): { user: string } | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const head = tokens.shift();
  if (head === 'su') return parseSu(tokens);
  if (head === 'sudo') return parseSudo(tokens);
  return null;
}

/** `su`, `su -`, `su -l`, `su root`, `su - postgres`, `su --login app`. */
function parseSu(tokens: string[]): { user: string } | null {
  let user: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === '-c' || token === '--command' || token === '-s' || token === '--shell') {
      // Runs a command instead of staying in another account's shell.
      return null;
    }
    if (token.startsWith('-')) continue;
    // The first operand is the account; anything after it is passed to the
    // shell it starts (`su - root -c …` already returned above).
    user = token;
    break;
  }
  return { user: user ?? 'root' };
}

/** `sudo -i`, `sudo -s`, `sudo su -`, `sudo bash`, `sudo -u app -i`. */
function parseSudo(tokens: string[]): { user: string } | null {
  let account: string | undefined;
  let wantsShell = false;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === '--') {
      rest.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      // The first operand is the command: everything after it belongs to that
      // command, including flags that are not `sudo`'s own (`sudo bash -c …`).
      rest.push(...tokens.slice(i));
      break;
    }

    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (equals >= 0) {
      if (name === '-u' || name === '--user') account = token.slice(equals + 1);
      continue;
    }
    if (token === '-i' || token === '--login' || token === '-s' || token === '--shell') {
      wantsShell = true;
      continue;
    }
    // Combined short flags: `sudo -iu app`, `sudo -Es`.
    if (/^-[A-Za-z]{2,}$/.test(token)) {
      if (token.includes('i') || token.includes('s')) wantsShell = true;
      if (token.includes('u')) {
        account = tokens[i + 1];
        i += 1;
      }
      continue;
    }
    if (SUDO_VALUES.has(name)) {
      if (name === '-u' || name === '--user') account = tokens[i + 1];
      i += 1;
    }
  }

  // `sudo` on its own prints its usage: nothing moved.
  if (rest.length === 0) return wantsShell ? { user: account ?? 'root' } : null;

  const [command, ...args] = rest as [string, ...string[]];
  if (command === 'su') return parseSu(args);
  if (!SHELLS.has(command)) return null;
  // `sudo bash -c 'systemctl restart nginx'` is a command, not a shell.
  const runsACommand = args.some((arg) => arg === '-c' || arg.startsWith('--command'));
  return runsACommand ? null : { user: account ?? 'root' };
}

/**
 * The password a `sudo` or a `su` is about to ask for.
 *
 * The two are not the same question, and answering one with the other's account
 * is how a saved password ends up typed at the wrong prompt: `sudo`
 * authenticates the account that is already logged in, whatever it goes on to
 * run — `sudo -i`, `sudo su`, `sudo systemctl restart nginx` are all the same
 * password — while `su` authenticates the account it switches to, which is a
 * login of its own on the same machine and can be in the vault on its own too.
 *
 * This says only what the command means. Whether a prompt appears at all is the
 * machine's business: a `sudo` answered from the sudoers cache asks nothing, and
 * a line that asks nothing never looks at this.
 */
export function parseEscalation(command: string): { via: 'sudo' | 'su'; account?: string } | null {
  const tokens = stripInputNoise(command).trim().split(/\s+/).filter(Boolean);
  const head = tokens.shift();
  if (head === 'sudo') return { via: 'sudo' };
  if (head !== 'su') return null;

  // `su`, `su -`, `su - postgres`, `su --login app`: the first operand is the
  // account, and no operand at all means root. `su -c '…'` runs a command as
  // that same account, so what follows `-c` is a command, not an account.
  let account: string | undefined;
  for (const token of tokens) {
    if (token === '-c' || token === '--command') break;
    if (token.startsWith('-')) continue;
    account = token;
    break;
  }
  return { via: 'su', account: account ?? 'root' };
}

/** Classifies one typed command line. Returns a signal for anything that moves the session. */
export function analyseCommandLine(rawLine: string, now = Date.now()): NestedSignal | null {
  const command = stripInputNoise(rawLine).trim();
  if (!command) return null;

  if (/^(?:exit|logout)\s*;?\s*$/.test(command)) {
    return { type: 'pop', origin: 'typed', reason: 'exit' };
  }

  const sshLike = /^(?:ssh|mosh)\s+(.+)$/.exec(command);
  if (sshLike) {
    const target = parseSshTarget(sshLike[1] ?? '');
    if (!target) return null;
    return {
      type: 'push',
      hop: {
        label: target.username ? `${target.username}@${target.host}` : target.host,
        host: target.host,
        username: target.username,
        // `ssh` without `-p` uses 22; a `Port` in the client's ssh_config is the
        // one thing this cannot see, and 22 is what the command line means.
        port: target.port ?? SSH_DEFAULT_PORT,
        detectedBy: 'command-line',
        confidence: 'high',
        at: now,
      },
    };
  }

  const telnet = /^telnet\s+(\S+)(?:\s+(\d+))?/.exec(command);
  if (telnet) {
    const host = telnet[1] as string;
    const port = telnet[2] ? Number(telnet[2]) : undefined;
    return {
      type: 'push',
      hop: { label: host, host, port, detectedBy: 'command-line', confidence: 'medium', at: now },
    };
  }

  const userSwitch = parseUserSwitch(command);
  if (userSwitch) {
    return {
      type: 'push',
      // Still the same machine: the user changes, the host does not. Marking it
      // keeps the address, the port and everything already probed about it.
      hop: {
        label: `${userSwitch.user} (su)`,
        username: userSwitch.user,
        sameHost: true,
        detectedBy: 'command-line',
        confidence: 'low',
        at: now,
      },
    };
  }

  const wsl = /^wsl(?:\.exe)?(?:\s+-d\s+(\S+))?\s*$/.exec(command);
  if (wsl) {
    const distribution = wsl[1] ?? 'WSL';
    return {
      type: 'push',
      hop: { label: distribution, detectedBy: 'command-line', confidence: 'medium', at: now },
    };
  }

  return null;
}