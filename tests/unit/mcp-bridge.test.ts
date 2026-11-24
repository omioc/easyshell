import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/shared/types';
import { AgentBridge } from '../../src/main/mcp/bridge';

/**
 * The door the MCP server knocks on.
 *
 * The MCP process is a child of the *agent*, so the app cannot hand it a
 * function — only a URL and a token. What matters here is that the URL cannot
 * be used without the token, and that `/run` goes through the observable
 * session path rather than some private shortcut of its own.
 */
const settings = {
  agent: { commandTimeoutMs: 45_000 },
} as unknown as Settings;

function session(id: string, target: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'ssh',
    title: target,
    status: 'connected',
    metadata: { endpoint: { displayName: target } },
    ...extra,
  };
}

const SESSIONS = [session('sess-1', 'root@198.18.0.7'), session('sess-2', 'deploy@198.18.0.9')];

type Authorize = NonNullable<ConstructorParameters<typeof AgentBridge>[0]['authorize']>;

interface Stub {
  bridge: AgentBridge;
  url: string;
  token: string;
  focus: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  authorize: Authorize;
  stop(): Promise<void>;
}

const started: Stub[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop();
});

async function start(options?: {
  sessions?: unknown[];
  focused?: string | null;
  /** Left out on purpose in the test that proves a bridge without a gate refuses. */
  authorize?: Authorize | null;
}): Promise<Stub> {
  const focus = vi.fn();
  const runCommand = vi.fn(async () => ({
    code: 0,
    stdout: 'a\n',
    stderr: '',
    timedOut: false,
  }));
  const authorize = (options?.authorize ?? vi.fn(async () => ({ allowed: true }))) as Authorize;
  const bridge = new AgentBridge({
    sessions: {
      list: () => options?.sessions ?? SESSIONS,
      focus,
      runCommand,
    } as never,
    getSettings: () => settings,
    focused: () => options?.focused ?? null,
    ...(options?.authorize === null ? {} : { authorize }),
  });
  const endpoint = await bridge.start();
  if (!endpoint) throw new Error('the bridge did not start');
  const stub: Stub = {
    bridge,
    url: endpoint.url,
    token: endpoint.token,
    focus,
    runCommand,
    authorize,
    stop: () => bridge.stop(),
  };
  started.push(stub);
  return stub;
}

function call(
  stub: Stub,
  path: string,
  body?: unknown,
  token = stub.token,
  taskId = '',
): Promise<Response> {
  return fetch(`${stub.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(taskId ? { 'x-easyshell-task': taskId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('the agent bridge', () => {
  it('is bound to loopback on a port nobody had to pick', async () => {
    const stub = await start();
    expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stub.token.length).toBeGreaterThan(20);
  });

  it('refuses a call without the token', async () => {
    const stub = await start();
    const response = await call(stub, '/sessions', undefined, '');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses a call with the wrong token', async () => {
    const stub = await start();
    expect((await call(stub, '/sessions', undefined, 'nope')).status).toBe(401);
  });

  it('lists terminals with the focused one marked', async () => {
    const stub = await start({ focused: 'sess-2' });
    const body = (await (await call(stub, '/sessions')).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.sessions.map((item) => item['id'])).toEqual(['sess-1', 'sess-2']);
    expect(body.sessions[0]?.['focused']).toBe(false);
    expect(body.sessions[1]?.['focused']).toBe(true);
    expect(body.sessions[0]?.['target']).toBe('root@198.18.0.7');
  });

  it('runs a command through the observable path', async () => {
    const stub = await start();
    const response = await call(stub, '/run', {
      command: '  ls -la ',
      sessionId: 'sess-2',
      cwd: '/srv',
      timeoutMs: 1000,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessionId: 'sess-2', target: 'deploy@198.18.0.9', code: 0 });
    expect(stub.runCommand).toHaveBeenCalledWith('sess-2', 'ls -la', {
      timeoutMs: 1000,
      cwd: '/srv',
    });
  });

  it('drops a working directory that is not absolute', async () => {
    const stub = await start();
    await call(stub, '/run', { command: 'ls', sessionId: 'sess-1', cwd: '../etc' });
    expect(stub.runCommand).toHaveBeenCalledWith('sess-1', 'ls', {
      timeoutMs: 45_000,
      cwd: undefined,
    });
  });

  it('falls back to the focused terminal when no terminal is named', async () => {
    const stub = await start({ focused: 'sess-2' });
    await call(stub, '/run', { command: 'whoami' });
    expect(stub.runCommand).toHaveBeenCalledWith('sess-2', 'whoami', expect.anything());
  });

  it('refuses a name it cannot resolve instead of running elsewhere', async () => {
    const stub = await start({ focused: 'sess-1' });
    const response = await call(stub, '/run', { command: 'whoami', sessionId: 'ghost' });
    expect(response.status).toBe(409);
    expect(stub.runCommand).not.toHaveBeenCalled();
  });

  it('refuses to guess between several terminals', async () => {
    const stub = await start({ focused: null });
    const response = await call(stub, '/run', { command: 'whoami' });
    expect(response.status).toBe(409);
  });

  it('ignores an empty command', async () => {
    const stub = await start();
    const response = await call(stub, '/run', { command: '   ', sessionId: 'sess-1' });
    expect(response.status).toBe(400);
    expect(stub.runCommand).not.toHaveBeenCalled();
  });

  it('brings a terminal forward', async () => {
    const stub = await start();
    const response = await call(stub, '/focus', { sessionId: 'sess-1' });
    expect(response.status).toBe(200);
    expect(stub.focus).toHaveBeenCalledWith('sess-1');
  });

  it('answers 404 for anything else', async () => {
    const stub = await start();
    expect((await call(stub, '/nothing')).status).toBe(404);
  });

  it('forgets its token when it stops', async () => {
    const stub = await start();
    await stub.stop();
    expect(stub.bridge.endpoint).toBeNull();
    await expect(fetch(`${stub.url}/sessions`)).rejects.toThrow();
  });

  it('asks the permission gate before anything runs', async () => {
    const stub = await start({ focused: 'sess-2' });
    await call(stub, '/run', { command: 'rm -rf /srv/cache' });

    expect(stub.authorize).toHaveBeenCalledWith({
      taskId: '',
      command: 'rm -rf /srv/cache',
      sessionId: 'sess-2',
    });
    expect(stub.runCommand).toHaveBeenCalledTimes(1);
  });

  it('refuses a command the gate turned down, and never runs it', async () => {
    const stub = await start({
      authorize: async () => ({ allowed: false, reason: 'the user denied the command' }),
    });
    const response = await call(stub, '/run', { command: 'rm -rf /srv/cache', sessionId: 'sess-1' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'the user denied the command' });
    expect(stub.runCommand).not.toHaveBeenCalled();
  });

  it('refuses when no gate is wired at all', async () => {
    const stub = await start({ authorize: null });
    const response = await call(stub, '/run', { command: 'whoami', sessionId: 'sess-1' });

    expect(response.status).toBe(403);
    expect(stub.runCommand).not.toHaveBeenCalled();
  });

  it('treats a gate that throws as a refusal, not as permission', async () => {
    const stub = await start({
      authorize: async () => {
        throw new Error('classifier unavailable');
      },
    });
    const response = await call(stub, '/run', { command: 'whoami', sessionId: 'sess-1' });

    expect(response.status).toBe(403);
    expect(stub.runCommand).not.toHaveBeenCalled();
  });

  it('tells the gate which agent task the call belongs to', async () => {
    const stub = await start({ focused: 'sess-1' });
    await call(stub, '/run', { command: 'uptime' }, stub.token, 'task-7');

    expect(stub.authorize).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-7' }));
  });
});
