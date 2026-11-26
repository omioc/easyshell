import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SshCredential, Settings } from '../../src/shared/types';

/**
 * The password vault, driven through a whole session.
 *
 * What this file watches is the conversation a person actually has with a
 * terminal: type `ssh user@host`, answer the password prompt, get it wrong, get
 * it right, and land in the new shell. The question the app asks at the end
 * belongs to that whole sequence, not to any single output chunk — which is why
 * these cases run through the manager instead of the desk alone.
 */
const hoisted = vi.hoisted(() => ({
  events: [] as SessionEvent[],
  writes: [] as string[],
  handlers: null as null | { onData: (chunk: string) => void; onStatus: (status: string) => void },
  /** What the app asked the settings store to remember. */
  saved: [] as SshCredential[],
}));

vi.mock('../../src/main/session/ssh', () => ({
  startSshSession: async (options: {
    handlers: { onData: (chunk: string) => void; onStatus: (status: string) => void };
  }) => {
    hoisted.handlers = options.handlers;
    queueMicrotask(() => options.handlers.onStatus('connected'));
    return {
      kind: 'ssh',
      posixShell: true,
      write: (data: string) => hoisted.writes.push(data),
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
  vault: { credentials: [] },
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT = "\r\nalice@203.0.113.13's password: ";
const BASTION_PROMPT = '\r\n[alice@bastion ~]$ ';
const INNER_PROMPT = '\r\n[alice@203-0-113-13 ~]$ ';

let opened: InstanceType<typeof SessionManager> | null = null;

async function open(
  vault: SshCredential[] = [],
): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  opened?.shutdown();
  hoisted.events = [];
  hoisted.writes = [];
  hoisted.saved = [];
  hoisted.handlers = null;
  settings.vault = { credentials: vault };
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: (event) => hoisted.events.push(event),
    replaceCredentials: (next) => {
      hoisted.saved = next;
    },
  });
  const info = await manager.create({
    kind: 'ssh',
    target: { host: 'bastion', port: 22, username: 'alice', auth: { type: 'agent' } },
  } as never);
  opened = manager;
  return { manager, id: info.id };
}

/** The pty printed something. */
function output(chunk: string): void {
  hoisted.handlers?.onData(chunk);
}

/** The user typed something. */
async function type(manager: InstanceType<typeof SessionManager>, id: string, data: string) {
  manager.write(id, data);
  await sleep(0);
}

/** Every question the app asked the user, in order. */
function questions() {
  return hoisted.events.flatMap((event) =>
    event.type === 'session-credential' && event.request ? [event.request] : [],
  );
}

describe('a password typed at a nested login', () => {
  it('is offered for keeping when the login lands after a refused attempt', async () => {
    const { manager, id } = await open();
    output(BASTION_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    output(PROMPT);
    expect(questions()).toEqual([]);

    // Wrong password: the client says so and asks again.
    await type(manager, id, 'wrong-pass\r');
    output('\r\nPermission denied, please try again.' + PROMPT);
    expect(questions()).toEqual([]);

    // Right password: the login goes through.
    await type(manager, id, 'correct-pass\r');
    output(INNER_PROMPT);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({
      kind: 'save',
      username: 'alice',
      host: '203.0.113.13',
      label: 'alice@203.0.113.13',
    });

    manager.respondCredential(id, 'accept');
    expect(hoisted.saved).toHaveLength(1);
    expect(hoisted.saved[0]).toMatchObject({
      username: 'alice',
      host: '203.0.113.13',
      password: 'correct-pass',
    });
    // Only the password that worked is kept: the refused one never reached here.
    expect(hoisted.writes).toEqual(['ssh alice@203.0.113.13\r', 'wrong-pass\r', 'correct-pass\r']);
  });

  it('is offered after Ctrl-C and a retry recalled from history', async () => {
    const { manager, id } = await open();
    output(BASTION_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    output(PROMPT);

    // Ctrl-C at the prompt: the login is abandoned, the shell comes back.
    await type(manager, id, '\x03');
    output(BASTION_PROMPT + '\r\n[alice@bastion ~]$ ');

    // The retry comes from the history: the app sees `↑` and a line it cannot
    // read back, so nothing tells it where this login is going — the prompt does.
    await type(manager, id, '\x1b[A\r');
    output(PROMPT);
    await type(manager, id, 'correct-pass\r');
    output(INNER_PROMPT);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'save', label: 'alice@203.0.113.13' });
  });

  it('is answered at a sudo prompt with the login it belongs to', async () => {
    // `sudo` authenticates the account that is already logged in, so the
    // password it wants is the one this session's own login has.
    const { manager, id } = await open([
      { id: 'cred-1', username: 'alice', host: 'bastion', password: 'login-pass', createdAt: 1, updatedAt: 1 },
    ]);
    output(BASTION_PROMPT);
    await type(manager, id, 'sudo -i\r');
    output('\r\n[sudo] password for alice: ');
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'fill', label: 'alice@bastion' });

    manager.respondCredential(id, 'accept');
    expect(hoisted.writes).toEqual(['sudo -i\r', 'login-pass\r']);
    expect(hoisted.saved[0]?.lastUsedAt).toBeGreaterThan(0);
  });

  it('is never offered to keep a password typed at a sudo prompt', async () => {
    // The switch did happen — a root prompt is on screen — and still nothing is
    // asked: a refused password leaves the machine carrying on exactly the same.
    const { manager, id } = await open();
    output(BASTION_PROMPT);
    await type(manager, id, 'sudo -i\r');
    output('\r\n[sudo] password for alice: ');
    await type(manager, id, 'root-pass\r');
    output('\r\n[root@bastion ~]# ');
    await sleep(0);

    expect(questions()).toEqual([]);
    expect(hoisted.saved).toEqual([]);
  });
});
