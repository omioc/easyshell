import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, Settings } from '../../src/shared/types';

const shell = vi.hoisted(() => ({
  writes: [] as string[],
  handlers: null as null | {
    onData(chunk: string): void;
    onStatus(status: 'connecting' | 'connected'): void;
    onExit(code: number | null): void;
    onError(message: string): void;
  },
}));

vi.mock('../../src/main/session/local', () => ({
  planSession: () => ({
    kind: 'local', label: 'bash', file: 'bash', args: [], cwd: '/root', env: {}, posix: true,
  }),
  startLocalSession: async (_plan: unknown, handlers: NonNullable<typeof shell.handlers>) => {
    shell.handlers = handlers;
    queueMicrotask(() => handlers.onStatus('connected'));
    return {
      kind: 'local',
      posixShell: true,
      write: (data: string) => shell.writes.push(data),
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

const managers: InstanceType<typeof SessionManager>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  shell.writes = [];
  shell.handlers = null;
});

afterEach(() => {
  for (const manager of managers.splice(0)) {
    for (const session of manager.list()) manager.close(session.id);
  }
  vi.useRealTimers();
});

function output(chunk: string): void {
  shell.handlers?.onData(chunk);
}

function injections(): string[] {
  return shell.writes.filter((line) => line.includes('YSHELL-ESB-'));
}

/** Play the shell's answer, including the prompt that follows its end marker. */
function answer(path: string): void {
  const line = injections().at(-1);
  const token = /YSHELL-ESB-(\w+)/.exec(line ?? '')?.[1];
  expect(token).toBeTruthy();
  output(`\r\nEASYSHELL-ESB-${token}\r\n${path}\r\nEASYSHELL-ESE-${token}:0\r\nroot@outer:~# `);
}

async function open() {
  const events: SessionEvent[] = [];
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: (event) => events.push(event),
  });
  managers.push(manager);
  const session = await manager.create({ kind: 'local', command: 'bash', args: [] } as never);
  output('root@outer:~# ');
  return { manager, id: session.id, events };
}

describe('event-driven terminal directory following', () => {
  it('asks on a returned prompt without waiting 1500 ms after Enter', async () => {
    const { manager, id, events } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'cd /tmp\r');
    output('cd /tmp\r\nroot@outer:/tmp# ');

    await vi.advanceTimersByTimeAsync(599);
    expect(injections()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(injections()).toHaveLength(1);
    expect(injections()[0]).toContain('{ pwd ; }');

    answer('/tmp');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(id)?.cwd).toBe('/tmp');
    expect(events.some((event) => event.type === 'session-updated' && event.session.cwd === '/tmp')).toBe(true);
  });

  it('waits for the remaining chunks of a split prompt', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'cd /tmp\r');
    output('cd /tmp\r\nroot@outer:/');
    await vi.advanceTimersByTimeAsync(400);
    output('tmp# ');

    await vi.advanceTimersByTimeAsync(599);
    expect(injections()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(injections()).toHaveLength(1);
  });

  it('does not reuse the pre-command prompt while a delayed password is pending', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'ssh root@inner\r');

    await vi.advanceTimersByTimeAsync(2000);
    expect(injections()).toHaveLength(0);
    output("root@inner's password: ");
    await vi.advanceTimersByTimeAsync(4000);
    expect(injections()).toHaveLength(0);
  });

  it('does not treat an echoed command ending in a prompt character as a returned prompt', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'echo test#\r');
    output('echo test#');

    await vi.advanceTimersByTimeAsync(2000);
    expect(injections()).toHaveLength(0);
    output('\r\ntest#\r\nroot@outer:~# ');
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(1);
  });

  it('does not query again because its own answer or prompt repaint produced output', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(1);
    answer('/root');
    await vi.advanceTimersByTimeAsync(4000);
    output('\r\nroot@outer:~# ');
    await vi.advanceTimersByTimeAsync(2000);
    expect(injections()).toHaveLength(1);

    manager.write(id, 'cd /tmp\r');
    output('cd /tmp\r\nroot@outer:/tmp# ');
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(2);
    answer('/tmp');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(id)?.cwd).toBe('/tmp');
  });

  it('publishes split OSC directory reports immediately without injecting pwd', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'cd "/tmp/a b"\r');
    output('cd "/tmp/a b"\r\n\x1b]7;file://outer/tmp/a%20');
    expect(manager.get(id)?.cwd).toBeUndefined();
    output('b\x07');
    expect(manager.get(id)?.cwd).toBe('/tmp/a b');
    // The prompt may be delivered in another packet after the OSC report.
    output('root@outer:/tmp/a b# ');
    await vi.advanceTimersByTimeAsync(2000);
    expect(injections()).toHaveLength(0);
  });

  it.each(['disable', 'close', 'input'] as const)('cancels a scheduled query on %s', async (action) => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    await vi.advanceTimersByTimeAsync(300);
    if (action === 'disable') manager.followCwd(id, false);
    else if (action === 'close') manager.close(id);
    else manager.write(id, ' ');

    await vi.advanceTimersByTimeAsync(4000);
    expect(injections()).toHaveLength(0);
  });

  it('preserves a half-typed line through a readline redraw, then recovers after Ctrl-C', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'echo $');
    output('\rroot@outer:~# echo $');

    await vi.advanceTimersByTimeAsync(2000);
    expect(injections()).toHaveLength(0);

    manager.write(id, '\x03');
    output('^C\r\nroot@outer:~# ');
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(1);
    answer('/root');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(id)?.cwd).toBe('/root');
  });

  it.each(['before-timer', 'same-tick'] as const)('retries after a competing metadata probe (%s)', async (timing) => {
    const { manager, id } = await open();
    let metadata: ReturnType<typeof manager.execViaShell>;
    let cwd: ReturnType<typeof manager.refreshCwd> | undefined;
    if (timing === 'before-timer') {
      manager.followCwd(id, true);
      await vi.advanceTimersByTimeAsync(599);
      metadata = manager.execViaShell(id, 'printf metadata');
      await vi.advanceTimersByTimeAsync(1);
    } else {
      await vi.advanceTimersByTimeAsync(600);
      // Both calls see an idle shell before their awaits resume. The metadata
      // call resumes first, so cwd loses the final safety check before writing.
      metadata = manager.execViaShell(id, 'printf metadata');
      manager.followCwd(id, true);
      cwd = manager.refreshCwd(id);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(injections()).toHaveLength(1);
    expect(injections()[0]).toContain('{ printf metadata ; }');

    answer('metadata');
    expect((await metadata).stdout).toContain('metadata');
    await cwd;
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(2);
    expect(injections()[1]).toContain('{ pwd ; }');
    answer('/root');
    await vi.advanceTimersByTimeAsync(4000);
    expect(manager.get(id)?.cwd).toBe('/root');
    expect(injections()).toHaveLength(2);
  });

  it('discards an answer if the user submitted another command before it was applied', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(1);
    answer('/old');
    manager.write(id, 'cd /new\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(id)?.cwd).not.toBe('/old');

    output('cd /new\r\nroot@outer:/new# ');
    await vi.advanceTimersByTimeAsync(600);
    expect(injections()).toHaveLength(2);
    answer('/new');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(id)?.cwd).toBe('/new');
  });

  it('does not inject while a full-screen program owns the terminal', async () => {
    const { manager, id } = await open();
    manager.followCwd(id, true);
    manager.write(id, 'vim\r');
    output('\r\n\x1b[?1049hstatus# ');
    await vi.advanceTimersByTimeAsync(4000);
    expect(injections()).toHaveLength(0);
  });
});
