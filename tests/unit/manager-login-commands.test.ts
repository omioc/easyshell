import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, Settings } from '../../src/shared/types';

/**
 * Commands a saved host runs once the login is up.
 *
 * They are typed into the interactive shell, one line at a time, because that is
 * where the user would have typed them: after the login, in the same shell, in
 * the same order. The path matters as much as the text — it is what makes the
 * tab show the commands — so what this file watches is what the pty received.
 */
const hoisted = vi.hoisted(() => ({
  events: [] as SessionEvent[],
  /** Everything written into the pty, i.e. everything the shell would read. */
  writes: [] as string[],
  handlers: null as null | { onData: (chunk: string) => void },
}));

const backend = () => ({
  posixShell: true,
  write: (data: string) => {
    hoisted.writes.push(data);
  },
  resize: () => undefined,
  kill: () => undefined,
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
});

vi.mock('../../src/main/session/ssh', () => ({
  startSshSession: async (options: {
    handlers: { onStatus: (status: string) => void; onData: (chunk: string) => void };
  }) => {
    hoisted.handlers = options.handlers;
    queueMicrotask(() => options.handlers.onStatus('connected'));
    return { kind: 'ssh', ...backend() };
  },
}));

const { SessionManager } = await import('../../src/main/session/manager');

const settings = {
  probe: { enabled: false, intervalMs: 60_000, nestedDetection: true },
  ssh: { keepAliveSeconds: 0, hostKeyPolicy: 'accept-new', profiles: [] },
  appearance: {},
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let opened: InstanceType<typeof SessionManager> | null = null;

/** Opens one SSH session carrying `loginCommands`. */
async function open(loginCommands: string[]): Promise<void> {
  opened?.shutdown();
  opened = null;
  hoisted.events = [];
  hoisted.writes = [];
  hoisted.handlers = null;
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: (event) => hoisted.events.push(event),
  });
  await manager.create({
    kind: 'ssh',
    target: { host: '198.18.0.7', port: 22, username: 'root', auth: { type: 'agent' } },
    loginCommands,
  } as never);
  opened = manager;
}

describe('login commands', () => {
  it('types each saved command into the shell, in order', async () => {
    await open(['cd /var/log', 'tail -f syslog']);
    await expect.poll(() => hoisted.writes.length, { timeout: 4000 }).toBe(2);
    expect(hoisted.writes).toEqual(['cd /var/log\r', 'tail -f syslog\r']);
  });

  it('types nothing when the profile has no commands', async () => {
    await open([]);
    await sleep(800);
    expect(hoisted.writes).toEqual([]);
  });

  it('stops when the shell is asking a question nobody typed the answer to', async () => {
    await open(['ssh inner-host', 'rm -rf /tmp/cache']);
    // The first command ran and the login it opened wants a password: the next
    // line would be the answer, and the user did not give it.
    await expect.poll(() => hoisted.writes.length, { timeout: 4000 }).toBe(1);
    hoisted.handlers?.onData("root@inner-host's password: ");
    await sleep(1200);
    expect(hoisted.writes).toEqual(['ssh inner-host\r']);
  });
});
