import { describe, expect, it, vi } from 'vitest';
import { createMcpHandler } from '../../src/main/mcp/protocol';

/**
 * The MCP surface an agent CLI sees.
 *
 * Two protocol rules the handler exists to get right: a notification is never
 * answered, and a *tool* failure is a result the model reads (`isError`) while
 * a *request* failure is a JSON-RPC error. Swapping either one hangs or
 * confuses a client.
 */
interface Captured {
  writes: Array<Record<string, unknown>>;
  call: ReturnType<typeof vi.fn>;
  send(line: unknown): Promise<void>;
}

function handler(bridge?: (path: string, init?: unknown) => Promise<Record<string, unknown>>): Captured {
  const writes: Array<Record<string, unknown>> = [];
  const call = vi.fn(
    bridge ??
      (async (path: string) => {
        if (path === '/sessions') {
          return {
            sessions: [
              { id: 'sess-1', kind: 'ssh', target: 'root@198.18.0.7', status: 'connected', focused: true },
            ],
          };
        }
        if (path === '/focus') return { ok: true, sessionId: 'sess-1' };
        return { sessionId: 'sess-1', target: 'root@198.18.0.7', code: 0, stdout: 'a\n', stderr: '', timedOut: false };
      }),
  );
  const send = createMcpHandler({ call, write: (message) => writes.push(message) });
  return {
    writes,
    call,
    send: async (line: unknown) => send(typeof line === 'string' ? line : JSON.stringify(line)),
  };
}

describe('the MCP endpoint', () => {
  it('answers initialize with the revision the client asked for', async () => {
    const mcp = handler();
    await mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    });

    expect(mcp.writes).toHaveLength(1);
    expect(mcp.writes[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'easyshell' },
      },
    });
  });

  it('falls back to the newest revision it knows', async () => {
    const mcp = handler();
    await mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((mcp.writes[0]?.['result'] as Record<string, unknown>)['protocolVersion']).toBe('2025-06-18');
  });

  it('never answers a notification', async () => {
    const mcp = handler();
    await mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await mcp.send({ jsonrpc: '2.0', method: 'tools/list' });
    await mcp.send({ jsonrpc: '2.0', method: 'initialize', params: {} });
    expect(mcp.writes).toHaveLength(0);
  });

  it('lists the three terminal tools with input schemas', async () => {
    const mcp = handler();
    await mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (mcp.writes[0]?.['result'] as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool['name'])).toEqual([
      'terminal_list',
      'terminal_run',
      'terminal_focus',
    ]);
    for (const tool of tools) expect(tool['inputSchema']).toMatchObject({ type: 'object' });
  });

  it('passes a run through to the bridge with every argument', async () => {
    const mcp = handler();
    await mcp.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'terminal_run',
        arguments: { command: ' ls -la ', session_id: 'sess-1', cwd: '/srv', timeout_ms: 5000 },
      },
    });

    expect(mcp.call).toHaveBeenCalledWith('/run', {
      method: 'POST',
      body: { command: 'ls -la', sessionId: 'sess-1', cwd: '/srv', timeoutMs: 5000 },
    });
    const result = mcp.writes[0]?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(false);
    const text = (result['content'] as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('exit code: 0');
    expect(text).toContain('root@198.18.0.7');
  });

  it('reads a non-zero exit as the command answer, not a failed call', async () => {
    const mcp = handler(async () => ({
      sessionId: 'sess-1',
      target: 'root@198.18.0.7',
      code: 2,
      stdout: '',
      stderr: 'no such file\n',
      timedOut: false,
    }));
    await mcp.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'terminal_run', arguments: { command: 'ls x' } },
    });

    // The call worked; the command returned 2 because the last line of it was a
    // check that found nothing. Marking that `isError` made every adapter paint
    // the row "failed", so the code travels as text and the call succeeds.
    expect(mcp.writes[0]?.['error']).toBeUndefined();
    const result = mcp.writes[0]?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(false);
    const text = (result['content'] as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('exit code: 2');
    expect(text).toContain('no such file');
  });

  it('marks a run that never finished as a failed call', async () => {
    const mcp = handler(async () => ({
      sessionId: 'sess-1',
      target: 'root@198.18.0.7',
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    }));
    await mcp.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'terminal_run', arguments: { command: 'sleep 600' } },
    });

    const result = mcp.writes[0]?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    expect((result['content'] as Array<{ text: string }>)[0]?.text).toContain('timed out');
  });

  it('keeps a bridge failure readable instead of turning it into a protocol error', async () => {
    const mcp = handler(async () => {
      throw new Error('no terminal: pass session_id');
    });
    await mcp.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'terminal_run', arguments: { command: 'whoami' } },
    });

    expect(mcp.writes[0]?.['error']).toBeUndefined();
    const result = mcp.writes[0]?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    expect((result['content'] as Array<{ text: string }>)[0]?.text).toContain('no terminal');
  });

  it('lists what is open, and says so when nothing is', async () => {
    const mcp = handler(async () => ({ sessions: [] }));
    await mcp.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'terminal_list' } });
    const result = mcp.writes[0]?.['result'] as Record<string, unknown>;
    expect((result['content'] as Array<{ text: string }>)[0]?.text).toContain('No terminals are open');
  });

  it('brings a terminal forward', async () => {
    const mcp = handler();
    await mcp.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'terminal_focus', arguments: { session_id: 'sess-1' } },
    });
    expect(mcp.call).toHaveBeenCalledWith('/focus', { method: 'POST', body: { sessionId: 'sess-1' } });
  });

  it('refuses a run with no command', async () => {
    const mcp = handler();
    await mcp.send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'terminal_run', arguments: { command: '  ' } },
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect((mcp.writes[0]?.['result'] as Record<string, unknown>)['isError']).toBe(true);
  });

  it('refuses a tool it does not have', async () => {
    const mcp = handler();
    await mcp.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } });
    expect(mcp.writes[0]?.['result']).toMatchObject({ isError: true });
  });

  it('answers an unknown method with a method-not-found error', async () => {
    const mcp = handler();
    await mcp.send({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
    expect(mcp.writes[0]).toMatchObject({ id: 10, error: { code: -32601 } });
  });

  it('ignores a line that is not protocol traffic', async () => {
    const mcp = handler();
    await mcp.send('not json at all');
    await mcp.send('null');
    expect(mcp.writes).toHaveLength(0);
  });
});
