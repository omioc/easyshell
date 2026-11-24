import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, Settings } from '../../src/shared/types';

/**
 * A command the user is meant to watch.
 *
 * An agent's command changes a machine the user is responsible for, so it has
 * to happen *in front of them*: the tab comes forward, the command line is
 * written into the terminal, and output arrives while it is still running. A
 * local session is the exception — the user is already sitting in front of that
 * machine, and a terminal with no line discipline to protect is not worth the
 * risk of typing into.
 */
const hoisted = vi.hoisted(() => ({
  events: [] as SessionEvent[],
  execCalls: [] as Array<{ command: string; options: Record<string, unknown> | undefined }>,
  sshExec: null as null | ((command: string, options: unknown) => Promise<unknown>),
  /** Everything written into the pty, i.e. everything the shell would read. */
  writes: [] as string[],
  /** Window changes sent to the pty, in order: the shell sees them as SIGWINCH. */
  resizes: [] as Array<{ cols: number; rows: number }>,
  /** The terminal's other side, so a test can play the remote shell. */
  handlers: null as null | { onData: (chunk: string) => void },
}));

const backend = () => ({
  posixShell: true,
  write: (data: string) => {
    hoisted.writes.push(data);
  },
  resize: (cols: number, rows: number) => {
    hoisted.resizes.push({ cols, rows });
  },
  kill: () => undefined,
  exec: (command: string, options: Record<string, unknown> | undefined) => {
    hoisted.execCalls.push({ command, options });
    return (hoisted.sshExec ?? (async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })))(
      command,
      options,
    );
  },
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

vi.mock('../../src/main/session/local', () => ({
  planSession: () => ({ kind: 'local', label: 'bash', file: 'bash', args: [], cwd: '.', env: {}, posix: true }),
  startLocalSession: async (_plan: unknown, handlers: { onStatus: (status: string) => void }) => {
    queueMicrotask(() => handlers.onStatus('connected'));
    return { kind: 'local', ...backend() };
  },
}));

const { SessionManager } = await import('../../src/main/session/manager');

const settings = {
  // The probe types into the shell and runs out-of-band commands of its own;
  // neither belongs in a test about what the *user* sees. The chain still has
  // to be read, though: it is what decides where a command runs.
  probe: { enabled: false, intervalMs: 60_000, nestedDetection: true },
  ssh: { keepAliveSeconds: 0, hostKeyPolicy: 'accept-new', profiles: [] },
  appearance: {},
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The session the previous test opened: its timers must not outlive the test. */
let opened: InstanceType<typeof SessionManager> | null = null;

async function open(kind: 'ssh' | 'local'): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  // A session left behind keeps probing timers alive, and those timers write
  // into the pty through the arrays below — which the next test has just
  // emptied. Shutting it down is what keeps a probe from a finished test from
  // answering for the one that is running.
  opened?.shutdown();
  opened = null;
  hoisted.events = [];
  hoisted.execCalls = [];
  // A previous test's exec stub must not leak into this session.
  hoisted.sshExec = null;
  hoisted.writes = [];
  hoisted.resizes = [];
  hoisted.handlers = null;
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'linux',
    homeDir: '/root',
    knownHosts: {} as never,
    emit: (event) => hoisted.events.push(event),
  });
  const spec =
    kind === 'ssh'
      ? ({
          kind: 'ssh',
          target: { host: '198.18.0.7', port: 22, username: 'root', auth: { type: 'agent' } },
        } as never)
      : ({ kind: 'local', command: 'bash', args: [] } as never);
  const session = await manager.create(spec);
  await sleep(20);
  opened = manager;
  return { manager, id: session.id };
}

/** Everything the renderer was actually shown, in order. */
function shown(): string {
  return hoisted.events
    .filter((event): event is Extract<SessionEvent, { type: 'session-output' }> => event.type === 'session-output')
    .map((event) => event.data)
    .join('');
}

describe('a command the user is meant to watch', () => {
  it('brings the tab forward, echoes the line and streams the output into it', async () => {
    const { manager, id } = await open('ssh');
    hoisted.events = [];
    hoisted.sshExec = async (_command, options) => {
      const push = (options as { onData?: (chunk: string) => void }).onData;
      push?.('total 0\n');
      push?.('drwxr-xr-x 2 root root 4096 .\n');
      return { code: 0, stdout: 'total 0\n', stderr: '', timedOut: false };
    };

    const result = await manager.runCommand(id, 'ls -la', { cwd: '/srv' });

    expect(result.code).toBe(0);
    // 1. The tab comes to the front before anything is typed anywhere.
    const first = hoisted.events[0];
    expect(first).toEqual({ type: 'session-focus', id });

    const display = shown();
    // 2. The command line is in the terminal, and so is its output.
    expect(display).toContain('$ ls -la');
    expect(display).toContain('total 0');
    expect(display).toContain('[exit 0]');
    // Output that arrives in the middle is on screen before the exit line.
    expect(display.indexOf('total 0')).toBeLessThan(display.indexOf('[exit 0]'));

    // 3. The command ran with the directory the caller asked for, and no
    //    display callback of its own is invented by the manager.
    expect(hoisted.execCalls).toHaveLength(1);
    expect(hoisted.execCalls[0]?.command).toBe('ls -la');
    expect(hoisted.execCalls[0]?.options).toMatchObject({ cwd: '/srv' });
  });

  /**
   * The block is an annotation, but it is written where the prompt was, so the
   * prompt ends up above it and the user is left looking at a bare cursor until
   * they press Enter. A window change makes the shell repaint its own prompt at
   * the cursor; nothing is typed into it, so nothing can run twice.
   */
  it('makes the shell repaint its prompt after the block, and restores the pty size', async () => {
    const { manager, id } = await open('ssh');
    // The connect-time wiggle (600 ms plus its restore) is a different nudge
    // with the same shape; let it finish before recording.
    await sleep(900);
    hoisted.resizes = [];

    await manager.runCommand(id, 'ls -la');
    await sleep(260);

    expect(hoisted.resizes).toEqual([
      { cols: 79, rows: 24 },
      { cols: 80, rows: 24 },
    ]);
    // The prompt is the shell's own paint, not a line the app types.
    expect(hoisted.writes).toEqual([]);
  });

  it('reports a failed command the same way, with its exit code on screen', async () => {
    const { manager, id } = await open('ssh');
    hoisted.events = [];
    hoisted.sshExec = async () => ({
      code: 2,
      stdout: '',
      stderr: 'ls: cannot access x\n',
      timedOut: false,
    });

    await manager.runCommand(id, 'ls x');

    const display = shown();
    expect(display).toContain('ls x');
    // Nothing streamed, so the failure reason is what the terminal shows.
    expect(display).toContain('ls: cannot access x');
    expect(display).toContain('[exit 2]');
  });

  it('leaves a local session alone: no tab switch, nothing written into its shell', async () => {
    const { manager, id } = await open('local');
    hoisted.events = [];

    const result = await manager.runCommand(id, 'Get-Date');

    expect(result.code).toBe(0);
    expect(hoisted.events.filter((event) => event.type === 'session-focus')).toHaveLength(0);
    expect(shown()).toBe('');
    expect(hoisted.execCalls).toHaveLength(1);
  });

  it('aborts the command when the caller gives up on it', async () => {
    const { manager, id } = await open('ssh');
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    hoisted.sshExec = (_command, options) =>
      new Promise((resolve) => {
        sawSignal = (options as { signal?: AbortSignal }).signal;
        sawSignal?.addEventListener('abort', () =>
          resolve({ code: null, stdout: '', stderr: '', timedOut: false }),
        );
      });

    const running = manager.runCommand(id, 'sleep 600', { signal: controller.signal });
    await sleep(10);
    controller.abort();
    await running;

    expect(sawSignal?.aborted).toBe(true);
    expect(shown()).toContain('[exit ?]');
  });
});

describe('what the display may say', () => {
  it('never types the command into the shell: only the display sees it', async () => {
    const { manager, id } = await open('ssh');
    hoisted.events = [];
    hoisted.writes = [];

    await manager.runCommand(id, 'echo hi > /tmp/x');

    // The line on screen is an annotation. Anything written into the pty would
    // be read by the shell and run a *second* time, which for a command that
    // writes or deletes is the worst bug this code could have.
    expect(hoisted.writes).toEqual([]);
    expect(shown()).toContain('$ echo hi > /tmp/x');
    // It ran once, out of band.
    expect(hoisted.execCalls).toHaveLength(1);
  });

  it('shows a command without letting it paint the screen', async () => {
    const { manager, id } = await open('ssh');
    hoisted.events = [];
    await manager.runCommand(id, 'echo \u001b[2Kpwned\u0007\necho second');

    const display = shown();
    // The echo is a record the user is asked to trust, so an escape sequence in
    // it must not reach the terminal as a control sequence.
    expect(display).not.toContain('\u001b[2K');
    expect(display).not.toContain('\u0007');
    expect(display).toContain('^[[2Kpwned^G');
    // A multi-line command stays readable as one block.
    expect(display).toContain('\r\n  echo second');
  });

});

describe('focusing a terminal', () => {
  it('announces the tab for callers outside the renderer', async () => {
    const { manager, id } = await open('ssh');
    hoisted.events = [];
    expect(manager.focus(id)).toBe(true);
    expect(hoisted.events).toEqual([{ type: 'session-focus', id }]);
  });

  it('refuses a session that is not there', async () => {
    const { manager } = await open('ssh');
    expect(manager.focus('nope')).toBe(false);
  });
});

/**
 * A command run at a login that was made inside the tab.
 *
 * `ssh` typed in a session moves the user to another machine while the side
 * channel still dials the one the tab was opened on. Running an agent's command
 * over that channel would change a machine the user is not looking at — with the
 * panel naming the other one — so from the second hop on the command is typed
 * into the shell on screen. When that cannot be done nothing runs at all.
 */
describe('a command on a machine reached by a login inside the tab', { timeout: 15_000 }, () => {
  /** Feeds what the remote shell prints. */
  function output(chunk: string): void {
    hoisted.handlers?.onData(chunk);
  }

  /** The tab's own prompt, then `ssh` to a second machine, then its prompt. */
  async function jumpToAnotherHost(manager: InstanceType<typeof SessionManager>, id: string): Promise<void> {
    output('root@198.18.0.7:~# ');
    await sleep(20);
    manager.write(id, 'ssh root@198.18.0.9\r');
    output("\r\nroot@198.18.0.9's password: ");
    manager.write(id, 'secret\r');
    output('\r\nLast login: Mon Nov 16 22:22:52 2026 from 198.18.0.7\r\n');
    output('root@build-host:~# ');
    await sleep(30);
    expect(
      manager.list().find((item) => item.id === id)?.metadata.endpoint.displayName,
    ).toBe('root@build-host');
  }

  /**
   * Waits for the app to type its line into the shell, then answers it the way
   * a shell would: the begin marker, the output, the end marker with the exit
   * code, and the prompt it repaints afterwards.
   */
  async function answerLine(text: string, code: number, mergePrompt = false): Promise<void> {
    for (let attempt = 0; attempt < 60 && hoisted.writes.length === 0; attempt += 1) await sleep(50);
    const typed = hoisted.writes.join('');
    const token = /YSHELL-ESB-([0-9a-f]+)/.exec(typed)?.[1] ?? '';
    expect(token).not.toBe('');
    output(`\r\nEASYSHELL-ESB-${token}`);
    if (mergePrompt) {
      // A fast link batches the marker and the prompt into one chunk.
      output(`\r\n${text}\r\nEASYSHELL-ESE-${token}:${code}\r\nroot@build-host:~# `);
      return;
    }
    output(`\r\n${text}\r\nEASYSHELL-ESE-${token}:${code}\r\n`);
    output('root@build-host:~# ');
  }

  it('types the command into the shell that is on screen', async () => {
    const { manager, id } = await open('ssh');
    await jumpToAnotherHost(manager, id);
    hoisted.events = [];
    hoisted.execCalls = [];
    hoisted.writes = [];

    const running = manager.runCommand(id, 'hostname');
    await answerLine('build-host', 0);
    const result = await running;
    // The prompt the shell paints arrives on its own tick, after the caller's
    // closing line, so the display has to be read once that has landed.
    await sleep(20);

    // Nothing ran on the machine the tab was opened on.
    expect(hoisted.execCalls).toEqual([]);
    // The line went into the shell that is on screen, between the markers.
    const typed = hoisted.writes.join('');
    expect(typed).toContain('YSHELL-ESB');
    expect(typed).toContain('hostname');
    // The answer is the one the inner machine gave, and the user watched it.
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('build-host');
    expect(shown()).toContain('build-host');
    expect(shown()).toContain('[exit 0]');
    // The prompt the shell painted afterwards is back on screen, once: the
    // command block does not leave the tab sitting on its own output, and it
    // does not paint the prompt twice either.
    const display = shown();
    expect(display).toContain('[exit 0]');
    expect(display.indexOf('[exit 0]')).toBeLessThan(display.indexOf('root@build-host:~# '));
    expect(display.split('root@build-host:~# ')).toHaveLength(2);
  });

  it('puts the prompt after the block when it arrives with the marker', async () => {
    const { manager, id } = await open('ssh');
    await jumpToAnotherHost(manager, id);
    hoisted.events = [];
    hoisted.execCalls = [];
    hoisted.writes = [];

    const running = manager.runCommand(id, 'hostname');
    await answerLine('build-host', 0, true);
    await running;
    await sleep(20);

    const display = shown();
    expect(display.indexOf('[exit 0]')).toBeLessThan(display.indexOf('root@build-host:~# '));
    expect(display.split('root@build-host:~# ')).toHaveLength(2);
  });

  it('refuses instead of running it on the machine the tab was opened on', async () => {
    const { manager, id } = await open('ssh');
    await jumpToAnotherHost(manager, id);
    // A pager owns the screen: a line typed now would be read by the pager.
    output('\x1b[?1049h');
    hoisted.events = [];
    hoisted.execCalls = [];
    hoisted.writes = [];

    const result = await manager.runCommand(id, 'rm -rf /srv/cache');

    expect(hoisted.execCalls).toEqual([]);
    expect(hoisted.writes).toEqual([]);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('not run on root@build-host');
    expect(shown()).toContain('not run on root@build-host');
  });

  it('returns to the side channel once the user leaves that machine', async () => {
    const { manager, id } = await open('ssh');
    await jumpToAnotherHost(manager, id);
    manager.write(id, 'exit\r');
    output('\r\nlogout\r\n');
    output('root@198.18.0.7:~# ');
    await sleep(30);
    hoisted.events = [];
    hoisted.execCalls = [];
    hoisted.writes = [];

    const result = await manager.runCommand(id, 'hostname');

    expect(result.code).toBe(0);
    expect(hoisted.execCalls).toHaveLength(1);
    expect(hoisted.writes).toEqual([]);
  });

  it('refuses while a login typed in it has not answered', async () => {
    const { manager, id } = await open('ssh');
    output('root@198.18.0.7:~# ');
    await sleep(20);
    manager.write(id, 'ssh root@198.18.0.9\r');
    output("\r\nroot@198.18.0.9's password: ");
    hoisted.events = [];
    hoisted.execCalls = [];
    hoisted.writes = [];

    const result = await manager.runCommand(id, 'uptime');

    // A line typed at that prompt is a password, and the channel the tab was
    // opened on is a machine the user is no longer looking at.
    expect(hoisted.execCalls).toEqual([]);
    expect(hoisted.writes).toEqual([]);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('has not answered yet');
  });
});
