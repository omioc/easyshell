import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo, Settings } from '../../src/shared/types';

/**
 * The location chain has to survive a logout from the innermost hop.
 *
 * Leaving an `ssh` session on the remote side prints three things: the typed
 * `exit`, the shell's `logout`, and the client's `Connection to … closed.`.
 * All three describe the same hop. Counting them as three pops drops the user
 * from the deepest machine straight back to the address the tab was opened on,
 * skipping every hop in between.
 *
 * There is no pty here: `startLocalSession` is replaced by a backend that lets
 * the test play both sides of the terminal, so the assertions are about the
 * chain a real session would report.
 */
const hoisted = vi.hoisted(() => ({
  handlers: null as null | {
    onData: (chunk: string) => void;
    onStatus: (status: 'connecting' | 'connected') => void;
    onExit: (code: number | null) => void;
    onError: (message: string) => void;
  },
}));

vi.mock('../../src/main/session/local', () => ({
  planSession: () => ({
    kind: 'local',
    label: 'bastion',
    file: 'bash',
    args: [],
    cwd: '/root',
    env: {},
    posix: true,
  }),
  startLocalSession: async (_plan: unknown, handlers: unknown) => {
    hoisted.handlers = handlers as never;
    const typed = handlers as { onStatus: (status: 'connected') => void };
    queueMicrotask(() => typed.onStatus('connected'));
    return {
      kind: 'local',
      posixShell: true,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    };
  },
}));

const { SessionManager } = await import('../../src/main/session/manager');

const settings = {
  probe: { enabled: false, intervalMs: 60_000, nestedDetection: true },
  ssh: { keepAliveSeconds: 0, hostKeyPolicy: 'accept-new', profiles: [] },
  appearance: {},
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function output(chunk: string): void {
  hoisted.handlers?.onData(chunk);
}

/** The host addresses on the chain, outermost first. */
function chainHosts(manager: InstanceType<typeof SessionManager>, id: string): Array<string | undefined> {
  const session = manager.list().find((item) => item.id === id);
  return session?.metadata.endpoint.chain.map((hop) => hop.host) ?? [];
}

function session(manager: InstanceType<typeof SessionManager>, id: string): SessionInfo {
  const found = manager.list().find((item) => item.id === id);
  if (!found) throw new Error('session is gone');
  return found;
}

async function openedTab(): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: () => undefined,
  });
  const created = await manager.create({ kind: 'local', command: 'bash', args: [] } as never);
  await sleep(30);
  return { manager, id: created.id };
}

/** Plays the login banner and prompt a remote shell prints after `ssh`. */
function remoteLogin(host: string, username = 'root'): void {
  output(`\r\nLast login: Mon Nov 16 22:22:52 2026 from 198.18.0.1\r\n${username}@${host}:~# `);
}

describe('nested chain across a logout', () => {
  it('keeps the middle hop when the innermost login exits', async () => {
    const { manager, id } = await openedTab();
    output('root@203.0.113.2:~# ');
    await sleep(20);

    manager.write(id, 'ssh root@203.0.113.3\r');
    remoteLogin('203.0.113.3');
    await sleep(20);
    manager.write(id, 'ssh root@203.0.113.4\r');
    remoteLogin('203.0.113.4');
    await sleep(20);
    expect(chainHosts(manager, id).slice(-2)).toEqual(['203.0.113.3', '203.0.113.4']);

    // One logout, reported three times by three different layers.
    manager.write(id, 'exit\r');
    output('\r\nlogout\r\n');
    output('Connection to 203.0.113.4 closed.\r\n');
    output('root@203.0.113.3:~# ');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain.map((hop) => hop.host).slice(-1)).toEqual(['203.0.113.3']);
    expect(after.chain).toHaveLength(chainHosts(manager, id).length);
    expect(after.chain.at(-1)?.host).toBe('203.0.113.3');
    expect(after.host).toBe('203.0.113.3');
    expect(after.displayName).toContain('203.0.113.3');
  });

  it('still pops a second hop when the user exits again', async () => {
    const { manager, id } = await openedTab();
    output('root@203.0.113.2:~# ');
    await sleep(20);
    manager.write(id, 'ssh root@203.0.113.3\r');
    remoteLogin('203.0.113.3');
    await sleep(20);
    manager.write(id, 'ssh root@203.0.113.4\r');
    remoteLogin('203.0.113.4');
    await sleep(20);

    manager.write(id, 'exit\r');
    output('\r\nlogout\r\n');
    output('Connection to 203.0.113.4 closed.\r\n');
    output('root@203.0.113.3:~# ');
    await sleep(20);
    expect(session(manager, id).metadata.endpoint.host).toBe('203.0.113.3');

    manager.write(id, 'exit\r');
    output('\r\nlogout\r\n');
    output('Connection to 203.0.113.3 closed.\r\n');
    output('root@203.0.113.2:~# ');
    await sleep(30);
    expect(session(manager, id).metadata.endpoint.host).not.toBe('203.0.113.3');
  });

  it('gives a hop dialed by name the address the login banner reports', async () => {
    const { manager, id } = await openedTab();
    output('root@203.0.113.2:~# ');
    await sleep(20);

    // Dialed by name: the hop knows where the user is, not what to dial.
    manager.write(id, 'ssh node-01\r');
    output('\r\nWelcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\r\n');
    output(' * IPv4 address for eth0: 203.0.113.3\r\n\r\nroot@node-01:~# ');
    await sleep(30);

    const endpoint = session(manager, id).metadata.endpoint;
    expect(endpoint.chain.at(-1)).toMatchObject({ host: '203.0.113.3', hostname: 'node-01' });
    expect(endpoint.host).toBe('203.0.113.3');
  });
});

/**
 * Becoming another user inside a nested login.
 *
 * `sudo su` on the machine reached by `ssh` is one hop, so leaving it is one
 * pop: the user is back to the account they logged in as, still on that
 * machine. Counting the switch as nothing drops them to the address the tab was
 * opened on; counting the shell's `logout` as a second pop does the same.
 */
describe('a user switch inside a nested login', () => {
  /** `ssh alice@203.0.113.4`, the password, the banner, then the prompt. */
  async function loginTo(manager: InstanceType<typeof SessionManager>, id: string): Promise<void> {
    output('alice@203.0.113.2:~$ ');
    await sleep(20);
    manager.write(id, 'ssh alice@203.0.113.4\r');
    output("\r\nalice@203.0.113.4's password: ");
    manager.write(id, 'secret\r');
    output('\r\nLast login: Mon Nov 16 22:22:52 2026 from 203.0.113.2\r\n');
    // The machine names itself with a hostname, so the prompt is `host4` while
    // the hop was dialed by address.
    output('\x1b]0;alice@host4: ~\x07alice@host4:~$ ');
    await sleep(20);
  }

  it('stays on the machine when the user exits root', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);

    // `sudo su -` is the shape most people type; the `-` is the login shell.
    manager.write(id, 'sudo su -\r');
    output('\r\n[sudo] password for alice: ');
    manager.write(id, 'secret\r');
    output('\r\nroot@host4:/home/alice# ');
    await sleep(20);
    expect(session(manager, id).metadata.endpoint).toMatchObject({
      host: '203.0.113.4',
      username: 'root',
    });

    // The shell of the account being left prints this on its way out.
    manager.write(id, 'exit\r');
    output('\r\nlogout\r\n');
    output('\x1b]0;alice@host4: ~\x07alice@host4:~$ ');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.host).toBe('203.0.113.4');
    expect(after.username).toBe('alice');
  });

  it('counts the switch only after the password was accepted', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);

    manager.write(id, 'sudo su\r');
    output('\r\n[sudo] password for alice: ');
    manager.write(id, 'wrong\r');
    output('\r\nSorry, try again.\r\n[sudo] password for alice: ');

    // sudo itself retries: the attempt is not over yet.
    manager.write(id, 'secret\r');
    output('\r\nroot@host4:/home/alice# ');
    await sleep(20);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(3);
    expect(after.username).toBe('root');
  });

  it('drops the switch when the password was refused for good', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);

    manager.write(id, 'sudo su\r');
    output('\r\n[sudo] password for alice: ');
    manager.write(id, 'one\r');
    output('\r\nSorry, try again.\r\n[sudo] password for alice: ');
    manager.write(id, 'two\r');
    output('\r\nSorry, try again.\r\n[sudo] password for alice: ');
    manager.write(id, 'three\r');
    output('\r\nsudo: 3 incorrect password attempts\r\nalice@host4:~$ ');
    await sleep(20);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.host).toBe('203.0.113.4');
    expect(after.username).toBe('alice');
  });

  it('drops a nested login that was refused', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    manager.write(id, 'ssh alice@203.0.113.9\r');
    output('\r\nalice@203.0.113.9: Permission denied (publickey,password).\r\n');
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(1);
    expect(after.host).toBeUndefined();
  });
  it('steps back on the prompt the shell underneath paints', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);

    manager.write(id, 'sudo su -\r');
    output('\r\n[sudo] password for alice: ');
    manager.write(id, 'secret\r');
    output('\r\nroot@host4:/home/alice# ');
    await sleep(20);
    expect(session(manager, id).metadata.endpoint.chain).toHaveLength(3);

    // No `exit` was seen — a keystroke lost to an injection, a `Ctrl-D`, a
    // wrapper script. The prompt of the account underneath is the step back.
    output('\r\nalice@host4:~$ ');
    await sleep(20);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.host).toBe('203.0.113.4');
    expect(after.username).toBe('alice');
  });
});

/**
 * A line that was typed but never submitted, and a login that never happened.
 *
 * The chain is a record of where the user *is*. Half a line is not a command,
 * and a password that was never accepted — or a `Ctrl-C` at the prompt that
 * asked for it — is not a move.
 */
describe('a move that never happened', () => {
  it('stays put while the line is still being typed', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    for (const key of 'ssh root@203.0.113.4') manager.write(id, key);
    await sleep(20);

    expect(session(manager, id).metadata.endpoint.chain).toHaveLength(1);
  });

  it('reads the line the shell ran, not the keys that typed it', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    // `… .3`, backspace, `4`: the address is `.4`, and `.34` was never typed by
    // anybody — a chain that says `.34` is a chain nobody can act on.
    for (const key of 'ssh root@203.0.113.3') manager.write(id, key);
    manager.write(id, '\x7f');
    manager.write(id, '4');
    manager.write(id, '\r');
    output("\r\nroot@203.0.113.4's password: ");
    manager.write(id, 'secret\r');
    output('\r\nLast login: Mon Nov 16 22:22:52 2026 from 203.0.113.2\r\nroot@203.0.113.4:~# ');
    await sleep(20);

    const endpoint = session(manager, id).metadata.endpoint;
    expect(endpoint.host).toBe('203.0.113.4');
    expect(endpoint.chain.at(-1)?.label).toBe('root@203.0.113.4');
  });

  it('forgets the move when Ctrl-C took the command back', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    manager.write(id, 'ssh root@203.0.113.4\r');
    output("\r\nroot@203.0.113.4's password: ");
    // The user changed their mind: ssh is killed and the shell paints its own
    // prompt again.
    manager.write(id, '\x03');
    output('^C\r\nalice@203.0.113.2:~$ ');
    await sleep(20);

    const endpoint = session(manager, id).metadata.endpoint;
    expect(endpoint.chain).toHaveLength(1);
    expect(endpoint.host).toBeUndefined();
  });

  it('forgets the move when the password was refused', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    manager.write(id, 'ssh root@203.0.113.4\r');
    output('\r\nroot@203.0.113.4: Permission denied (publickey,password).\r\n');
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    expect(session(manager, id).metadata.endpoint.chain).toHaveLength(1);
  });
});

/**
 * A shell that logs itself out because nobody typed anything.
 *
 * Servers enforce this with `readonly TMOUT=600` in `/etc/profile`, and the
 * shell leaves with a timeout report — bash never prints `logout` for it, since
 * that line belongs to a shell left by something the user did. So neither the
 * typed line nor the `logout` line can pop the hop, and the prompt of the shell
 * underneath is only readable when it happens to be `user@host`: on a plain
 * `PS1` the chain used to keep the account the user had already been logged out
 * of for the rest of the tab's life.
 */
describe('a shell that timed itself out', () => {
  /** `ssh alice@203.0.113.4`, the password, the banner, then the prompt. */
  async function loginTo(manager: InstanceType<typeof SessionManager>, id: string): Promise<void> {
    output('alice@203.0.113.2:~$ ');
    await sleep(20);
    manager.write(id, 'ssh alice@203.0.113.4\r');
    output("\r\nalice@203.0.113.4's password: ");
    manager.write(id, 'secret\r');
    output('\r\nLast login: Mon Nov 16 22:22:52 2026 from 203.0.113.2\r\n');
    output('\x1b]0;alice@host4: ~\x07alice@host4:~$ ');
    await sleep(20);
  }

  /** `sudo su -`, then the root prompt: one hop that changes only the account. */
  async function becomeRoot(manager: InstanceType<typeof SessionManager>, id: string): Promise<void> {
    manager.write(id, 'sudo su -\r');
    output('\r\n[sudo] password for alice: ');
    manager.write(id, 'secret\r');
    output('\r\nroot@host4:/home/alice# ');
    await sleep(20);
  }

  it('leaves the root hop when the shell that timed out cannot be read', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);
    await becomeRoot(manager, id);
    expect(session(manager, id).metadata.endpoint.username).toBe('root');

    // The idle timer fires and the root shell exits. Underneath is the account's
    // own shell, with a prompt that names nobody: nothing else is left to read.
    output('\x1b[?2004l\r\x07timed out waiting for input: auto-logout\r');
    output('/home/alice $ ');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.host).toBe('203.0.113.4');
    expect(after.username).toBe('alice');
  });

  it('pops one hop, not two, when the prompt underneath is readable', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);
    await becomeRoot(manager, id);

    output('\x1b[?2004l\r\x07timed out waiting for input: auto-logout\r');
    // The prompt the shell underneath repaints is the same departure, already
    // counted: the machine the tab was opened on must still be there.
    output('alice@host4:~$ ');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.host).toBe('203.0.113.4');
    expect(after.username).toBe('alice');
  });

  it('steps back on a prompt painted over the line the hop stopped on', async () => {
    const { manager, id } = await openedTab();
    await loginTo(manager, id);
    await becomeRoot(manager, id);

    // The way most departures actually look: no `exit`, no report — the shell
    // underneath returns to column 0 with a bare CR and paints its prompt over
    // the line the old one was on. Reading that line from its start finds the
    // prompt that is already gone.
    output('\ralice@host4:~$ ');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(2);
    expect(after.username).toBe('alice');
  });

  it('has nothing to leave when the tab itself times out', async () => {
    const { manager, id } = await openedTab();
    output('alice@203.0.113.2:~$ ');
    await sleep(20);

    // The tab's own login shell: a timeout there ends the connection, and the
    // chain has no hop under this one to fall back to. It must not be emptied.
    output('\x1b[?2004l\r\x07timed out waiting for input: auto-logout\r');
    await sleep(30);

    const after = session(manager, id).metadata.endpoint;
    expect(after.chain).toHaveLength(1);
    expect(after.displayName).toBe('bash');
  });
});
