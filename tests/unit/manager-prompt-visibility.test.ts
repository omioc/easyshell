import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, Settings } from '../../src/shared/types';

/**
 * What the user is allowed to *not* see.
 *
 * The manager swallows output in two situations: while a shell probe is being
 * typed (the probe line and its echo are the app's own noise) and for a moment
 * after it, because a shell that is slow to answer repaints the prompt that is
 * already on screen. Both rules exist to stop one prompt from appearing twice.
 *
 * Neither may hide a prompt the user is not looking at. Leaving a nested login
 * with `exit` is exactly that moment: the prompt that comes back belongs to the
 * machine underneath, and a terminal that swallows it looks hung even though it
 * is listening.
 */
const hoisted = vi.hoisted(() => ({
  writes: [] as string[],
  events: [] as SessionEvent[],
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

/** Everything the renderer was actually shown, in order. */
function shown(): string {
  return hoisted.events
    .filter((event): event is Extract<SessionEvent, { type: 'session-output' }> => event.type === 'session-output')
    .map((event) => event.data)
    .join('');
}

async function openedSession(): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  hoisted.writes = [];
  hoisted.events = [];
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: (event) => hoisted.events.push(event),
  });
  const session = await manager.create({ kind: 'local', command: 'bash', args: [] } as never);
  await sleep(30);
  output('Last login: Mon Nov 16 22:22:52 2026 from 198.18.16.1\r\nroot@outer:~# ');
  await sleep(20);
  return { manager, id: session.id };
}

/** Waits for the probe the manager types after a nested login is detected. */
async function waitForProbeWrite(from: number): Promise<string | null> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const line = hoisted.writes.slice(from).find((entry) => entry.includes('YSHELL-ESB-'));
    if (line) return line;
    await sleep(50);
  }
  return null;
}

describe('a prompt the user is not looking at', () => {
  it('is shown when a nested login ends with exit', async () => {
    const { manager, id } = await openedSession();

    // A hop the detector saw: from here on the prompt on screen is the inner one.
    manager.write(id, 'ssh root@inner');
    manager.write(id, '\r');
    output("\r\nWelcome to Ubuntu 22.04.4 LTS\r\nroot@inner:~# ");

    // The probe the hop arms is the injection this test needs.
    const probe = await waitForProbeWrite(0);
    expect(probe).not.toBeNull();
    const token = /YSHELL-ESB-(\w+)/.exec(probe ?? '')?.[1] ?? '';
    const begin = `EASYSHELL-ESB-${token}`;
    const end = `EASYSHELL-ESE-${token}`;
    expect(begin).not.toBe('');
    output(`\r\n${begin}\r\n/root\r\n${end}:0\r\n`);
    // The drain window closes and the repaint guard starts.
    await sleep(420);

    hoisted.events = [];
    manager.write(id, 'exit');
    manager.write(id, '\r');
    output('logout\r\nConnection to 198.18.0.9 closed.\r\n');
    // The shell under the one that just closed paints its own prompt.
    output('root@outer:~# ');
    await sleep(60);

    expect(shown()).toContain('root@outer:~#');
  }, 15_000);

  it('is shown when the probe never answered and the shell came back', async () => {
    const { manager, id } = await openedSession();

    manager.write(id, 'ssh root@inner');
    manager.write(id, '\r');
    output("\r\nWelcome to Ubuntu 22.04.4 LTS\r\nroot@inner:~# ");
    const probe = await waitForProbeWrite(0);
    expect(probe).not.toBeNull();

    hoisted.events = [];
    // The line was read by a login prompt that is closing the session: the
    // markers never come, and what the shell prints next must not be swallowed
    // until the injection times out.
    output('logout\r\nConnection to 198.18.0.9 closed.\r\nroot@outer:~# ');
    await sleep(120);

    expect(shown()).toContain('Connection to 198.18.0.9 closed.');
    expect(shown()).toContain('root@outer:~#');
  }, 15_000);
});
