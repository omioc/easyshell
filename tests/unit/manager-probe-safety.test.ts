import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/shared/types';

/**
 * The shell probe types into the user's terminal, which makes the tty a shared
 * channel: `ssh`, `su`, `sudo` and `passwd` read their answers from exactly the
 * bytes the app writes. These tests pin the rule that came out of that — the
 * app never types while an answer is expected, and it lets go the moment the
 * user takes the line back.
 *
 * There is no pty here: `startLocalSession` is replaced by a backend that
 * records what the manager wrote, so every assertion is about the byte stream
 * the user's shell would receive.
 */
const hoisted = vi.hoisted(() => ({
  writes: [] as string[],
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
    label: 'bash',
    file: 'bash',
    args: [],
    cwd: '.',
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
      write: (data: string) => hoisted.writes.push(data),
      resize: () => undefined,
      kill: () => undefined,
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    };
  },
}));

const { SessionManager } = await import('../../src/main/session/manager');

const settings = {
  probe: { enabled: true, intervalMs: 60_000, nestedDetection: true },
  ssh: { keepAliveSeconds: 0, hostKeyPolicy: 'accept-new', profiles: [] },
  appearance: {},
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function output(chunk: string): void {
  hoisted.handlers?.onData(chunk);
}

/** A manager with one connected session parked at `root@harbor-node:~#`. */
async function openedSession(): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  hoisted.writes = [];
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: () => undefined,
  });
  const session = await manager.create({ kind: 'local', command: 'bash', args: [] } as never);
  await sleep(30);
  output('Last login: Mon Nov 16 22:22:52 2026 from 198.18.16.1\r\nroot@harbor-node:~# ');
  await sleep(20);
  return { manager, id: session.id };
}

describe('a login prompt is never typed into', () => {
  it('leaves the password prompt alone while a nested probe is armed', async () => {
    const { manager, id } = await openedSession();

    // Typed by hand, so the nested hop is known and a probe is armed for it.
    for (const key of 'ssh root@203.0.113.3') manager.write(id, key);
    manager.write(id, '\r');
    const asked = hoisted.writes.length;
    output("root@203.0.113.3's password: ");

    // The probe is armed 1200 ms after the hop, and retries follow.
    await sleep(4500);

    expect(hoisted.writes.slice(asked)).toEqual([]);
  }, 15_000);

  it('stops typing when a line was read as a password', async () => {
    const { manager, id } = await openedSession();
    await sleep(600);

    // The line goes out, and what comes back is not its markers: a nested login
    // read it as the answer to its password prompt. That output is captured, so
    // the tail still ends with the prompt from before the line was typed — the
    // stale prompt that used to make the next attempt type into the same login.
    const first = manager.execViaShell(id, 'echo hi', 900);
    await sleep(120);
    output("root@203.0.113.3's password: ");
    expect((await first).timedOut).toBe(true);
    const asked = hoisted.writes.length;

    const second = await manager.execViaShell(id, 'echo hi', 600);

    expect(second.timedOut).toBe(true);
    expect(second.stderr).toBe('session is busy');
    expect(hoisted.writes.slice(asked)).toEqual([]);
  }, 15_000);
  it('refuses an on-demand probe while a password is being asked for', async () => {
    const { manager, id } = await openedSession();
    await sleep(500);
    output("root@203.0.113.3's password: ");
    const asked = hoisted.writes.length;

    const result = await manager.execViaShell(id, 'echo hi', 400);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe('session is busy');
    expect(hoisted.writes.slice(asked)).toEqual([]);
  }, 15_000);

  it('gives the line back the moment the user types', async () => {
    const { manager, id } = await openedSession();
    await sleep(600);
    const before = hoisted.writes.length;

    const pending = manager.execViaShell(id, 'echo hi', 8000);
    await sleep(120);
    expect(hoisted.writes.length).toBe(before + 1);

    manager.write(id, 'x');
    const result = await pending;

    expect(result.stderr).toBe('interrupted by user input');
    expect(result.timedOut).toBe(true);
    expect(hoisted.writes.slice(before + 1)).toEqual(['x']);
  }, 15_000);
});
