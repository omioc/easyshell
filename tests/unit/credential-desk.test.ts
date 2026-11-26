import { describe, expect, it } from 'vitest';
import { CredentialDesk } from '../../src/main/session/credentials';
import type { CredentialRequest, SessionHop, SshCredential } from '../../src/shared/types';

/**
 * A password prompt, and the two questions it can raise.
 *
 * What this watches is the whole conversation: the prompt appears, the user
 * either answers it or asks the app to, the login lands or it does not, and the
 * question follows from that — never from a guess about what is on screen.
 */
const BASTION: SessionHop = {
  label: 'root@bastion',
  host: 'bastion',
  username: 'root',
  detectedBy: 'session',
  confidence: 'high',
  at: 0,
};

const AIMED: SessionHop = {
  label: 'root@198.51.100.9',
  host: '198.51.100.9',
  username: 'root',
  detectedBy: 'command-line',
  confidence: 'high',
  at: 0,
};

const PASSWORD_PROMPT = "root@198.51.100.9's password: ";

function harness(
  options: {
    vault?: SshCredential[];
    candidate?: SessionHop | null;
    /** The account at this shell's own prompt, and the names of its machine. */
    login?: { username?: string; host?: string; hostname?: string; port?: number };
    /** What the last submitted line says the machine may want a password for. */
    escalation?: { via: 'sudo' | 'su'; account?: string } | null;
  } = {},
) {
  const state = {
    chain: [BASTION],
    candidate: 'candidate' in options ? (options.candidate ?? null) : AIMED,
    login: options.login ?? { username: 'root', host: 'bastion' },
    escalation: options.escalation ?? null,
    tail: '',
    vault: options.vault ?? [],
    /** What the app typed into the pty. */
    typed: [] as string[],
    /** Every question shown to the user, in order. */
    asked: [] as CredentialRequest[],
    /** Every question retracted, in order. */
    retracted: 0,
    saved: [] as string[],
  };
  const desk = new CredentialDesk({
    candidate: () => state.candidate,
    landed: () => state.chain.at(-1) ?? null,
    depth: () => state.chain.length,
    tail: () => state.tail,
    login: () => state.login,
    escalation: () => state.escalation,
    credentials: () => state.vault,
    replaceCredentials: (next) => {
      state.vault = next;
    },
    typeSecret: (password) => state.typed.push(password),
    ask: (request) => {
      if (request) state.asked.push(request);
      else state.retracted += 1;
    },
    saved: (label) => state.saved.push(label),
  });
  return { state, desk };
}

/** The login at the other end of the prompt answers. */
function lands(state: ReturnType<typeof harness>['state']): void {
  state.chain = [...state.chain, { ...AIMED, hostname: 'inner-host' }];
}

function entry(partial: Partial<SshCredential> = {}): SshCredential {
  return {
    id: 'cred-1',
    username: 'root',
    host: '198.51.100.9',
    password: 'hunter2',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe('a password prompt of a login typed in the terminal', () => {
  it('offers to keep the password once the login lands', () => {
    const { state, desk } = harness();
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    expect(state.asked).toHaveLength(0);

    desk.onInput('hunter2');
    desk.onInput('\r');
    expect(state.asked).toHaveLength(0);

    lands(state);
    desk.onLanded();
    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]).toMatchObject({
      kind: 'save',
      label: 'root@198.51.100.9',
      username: 'root',
      host: '198.51.100.9',
    });

    desk.respond('accept');
    expect(state.saved).toEqual(['root@198.51.100.9']);
    expect(state.vault).toHaveLength(1);
    expect(state.vault[0]?.password).toBe('hunter2');
    // Nothing was typed: the user typed this password themselves.
    expect(state.typed).toEqual([]);
  });

  it('forgets a password typed for a login that never landed', () => {
    const { state, desk } = harness();
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter2');
    desk.onInput('\r');

    // "Permission denied, please try again." — the answer was not the password.
    desk.onAttemptFailed();
    lands(state);
    desk.onLanded();
    expect(state.asked).toHaveLength(0);
  });

  it('drops what was typed at Ctrl-C', () => {
    const { state, desk } = harness();
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter');
    desk.onInput('\x03');
    lands(state);
    desk.onLanded();
    expect(state.asked).toHaveLength(0);
  });

  it('does not offer a password it already has', () => {
    const { state, desk } = harness({ vault: [entry()] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter2');
    desk.onInput('\r');
    lands(state);
    desk.onLanded();
    // Only the "use it?" question was ever asked, never "keep it again?".
    expect(state.asked.map((request) => request.kind)).toEqual(['fill']);
  });

  it('remembers a changed password over the stored one', () => {
    const { state, desk } = harness({ vault: [entry({ password: 'old' })] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('new-password');
    desk.onInput('\r');
    lands(state);
    desk.onLanded();
    expect(state.asked.map((request) => request.kind)).toEqual(['fill', 'save']);
    desk.respond('accept');
    expect(state.vault).toHaveLength(1);
    expect(state.vault[0]?.password).toBe('new-password');
  });

  it('believes a changed prompt even when the chain did not follow', () => {
    // The login landed; the chain never picked it up, because the app never saw
    // the command line that got there. The shell on screen is another one, and
    // that is the evidence the question hangs on.
    const { state, desk } = harness({ candidate: null });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter2');
    desk.onInput('\r');

    desk.onLanded({ username: 'root', host: 'inner-host' });
    expect(state.asked.map((request) => request.kind)).toEqual(['save']);
  });

  it('does not take a prompt for another account as the login it asked about', () => {
    const { state, desk } = harness({ candidate: null });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter2');
    desk.onInput('\r');

    // The refused login left it standing where it was, and that prompt belongs
    // to somebody else: this password was never the one for that account.
    desk.onLanded({ username: 'deploy', host: 'bastion' });
    expect(state.asked).toEqual([]);
  });

  it('forgets the question once the user starts typing at the shell', () => {
    const { state, desk } = harness();
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('hunter2');
    desk.onInput('\r');
    lands(state);
    desk.onLanded();
    expect(state.asked).toHaveLength(1);

    // The user ignores the question and types a command instead: the password
    // is not kept, and the next prompt the tab paints must not raise it again.
    desk.onInput('l');
    expect(state.retracted).toBe(1);
    desk.onLanded({ username: 'root', host: 'inner-host' });
    expect(state.asked).toHaveLength(1);
  });

});

describe('a password the app already remembers', () => {
  it('is offered when its prompt appears, and typed only when accepted', () => {
    const { state, desk } = harness({ vault: [entry()] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();

    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'root@198.51.100.9' });
    expect(state.typed).toEqual([]);

    desk.respond('accept');
    expect(state.typed).toEqual(['hunter2']);
    expect(state.vault[0]?.lastUsedAt).toBeGreaterThan(0);
    // Using it is not the same as saving it: nothing new was recorded.
    expect(state.saved).toEqual([]);
  });

  it('is left alone when the user starts typing instead', () => {
    const { state, desk } = harness({ vault: [entry()] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.onInput('t');

    expect(state.retracted).toBe(1);
    expect(state.typed).toEqual([]);
    // The prompt itself is still unanswered and still theirs to answer. The
    // password typed here differs from the stored one, so there is something new
    // to offer once the login lands.
    desk.onInput('yped-by-hand');
    desk.onInput('\r');
    lands(state);
    desk.onLanded();
    expect(state.asked.map((request) => request.kind)).toEqual(['fill', 'save']);
  });

  it('stops asking in this tab once the user says no', () => {
    const { state, desk } = harness({ vault: [entry()] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    desk.respond('dismiss');

    // The prompt comes back (a wrong retry, a second attempt) and is not asked
    // about again.
    desk.onInput('\x03');
    desk.onOutput();
    expect(state.asked).toHaveLength(1);
    expect(state.typed).toEqual([]);
  });

  it('never asks about a question that is not a password', () => {

    // A host-key question is answered with a word, not a password.
    const keyQuestion = harness();
    keyQuestion.state.tail = 'Are you sure you want to continue connecting (yes/no)? ';
    keyQuestion.desk.onOutput();
    expect(keyQuestion.state.asked).toHaveLength(0);

    // A key passphrase belongs to a key, not to the login.
    const passphrase = harness();
    passphrase.state.tail = "Enter passphrase for key '/home/root/.ssh/id_ed25519': ";
    passphrase.desk.onOutput();
    expect(passphrase.state.asked).toHaveLength(0);
  });

  it('reads the login from the prompt when no typed line was seen', () => {
    // A command recalled from history, a line typed while the app was reading
    // something else: nothing classified the command, and the prompt still says
    // who is being asked. Without this, a retried login was never offered.
    const { state, desk } = harness({ candidate: null, vault: [entry()] });
    state.tail = PASSWORD_PROMPT;
    desk.onOutput();
    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'root@198.51.100.9' });

    desk.respond('accept');
    expect(state.typed).toEqual(['hunter2']);
  });

  it('says nothing when neither the prompt nor a typed line names a login', () => {
    const { state, desk } = harness({ candidate: null, vault: [entry()] });
    state.tail = 'Password: ';
    desk.onOutput();
    expect(state.asked).toHaveLength(0);
  });
});

describe('a password prompt of a sudo or a su', () => {
  /** What `sudo -i` / `su -` submit: a switch with no address of its own. */
  const SWITCH: SessionHop = {
    label: 'root (su)',
    sameHost: true,
    username: 'root',
    detectedBy: 'command-line',
    confidence: 'low',
    at: 0,
  };

  it('is answered with the password of the account already logged in', () => {
    const { state, desk } = harness({
      candidate: SWITCH,
      login: { username: 'alice', host: '203.0.113.13' },
      escalation: { via: 'sudo' },
      vault: [entry({ username: 'alice', host: '203.0.113.13' })],
    });
    state.tail = '[sudo] password for alice: ';
    desk.onOutput();
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'alice@203.0.113.13' });

    desk.respond('accept');
    expect(state.typed).toEqual(['hunter2']);
  });

  it('does not hand root the password of the account that escalated', () => {
    // `su -` authenticates root, which is not the account running the switch.
    const { state, desk } = harness({
      candidate: SWITCH,
      login: { username: 'alice', host: '203.0.113.13' },
      escalation: { via: 'su', account: 'root' },
      vault: [entry({ username: 'alice', host: '203.0.113.13' })],
    });
    state.tail = 'Password: ';
    desk.onOutput();
    expect(state.asked).toEqual([]);
  });

  it('is answered for `su` with the account it switches to', () => {
    const { state, desk } = harness({
      candidate: { ...SWITCH, username: 'postgres' },
      login: { username: 'alice', host: '203.0.113.13' },
      escalation: { via: 'su', account: 'postgres' },
      vault: [entry({ username: 'postgres', host: '203.0.113.13', password: 'pg-pass' })],
    });
    state.tail = 'Password: ';
    desk.onOutput();
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'postgres@203.0.113.13' });

    desk.respond('accept');
    expect(state.typed).toEqual(['pg-pass']);
  });

  it('finds the entry under either name of the same machine', () => {
    // Dialed by name and reporting an address, or the other way round: the login
    // was kept under the name the prompt that stored it showed, and the account
    // is the part that has to match either way.
    const { state, desk } = harness({
      candidate: SWITCH,
      login: { username: 'alice', host: '198.51.100.5', hostname: 'node-01' },
      escalation: { via: 'sudo' },
      vault: [entry({ username: 'alice', host: 'node-01' })],
    });
    state.tail = '[sudo] password for alice: ';
    desk.onOutput();
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'alice@node-01' });
  });

  it('is never offered for keeping, whatever was typed at it', () => {
    const { state, desk } = harness({
      candidate: SWITCH,
      login: { username: 'alice', host: '203.0.113.13' },
      escalation: { via: 'sudo' },
    });
    state.tail = '[sudo] password for alice: ';
    desk.onOutput();
    desk.onInput('typed-by-hand');
    desk.onInput('\r');

    // The switch landed — a root prompt — and nothing is asked: a machine whose
    // password was refused carries on exactly the same way.
    state.chain = [...state.chain, { ...SWITCH, host: 'bastion', hostname: 'bastion' }];
    desk.onLanded({ username: 'root', host: 'bastion' });
    expect(state.asked).toEqual([]);
  });

  it('reads the account from the prompt when no command line was seen', () => {
    // A `sudo` recalled from history: nothing classified the line, and the
    // prompt still prints the account whose password it wants.
    const { state, desk } = harness({
      candidate: null,
      login: { username: 'alice', host: '203.0.113.13' },
      vault: [entry({ username: 'alice', host: '203.0.113.13' })],
    });
    state.tail = '[sudo] password for alice: ';
    desk.onOutput();
    expect(state.asked[0]).toMatchObject({ kind: 'fill', label: 'alice@203.0.113.13' });
  });
});
