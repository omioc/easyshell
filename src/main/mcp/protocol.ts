/**
 * The MCP surface: tools, and the JSON-RPC dispatch in front of them.
 *
 * Separate from `server.ts` on purpose. That file owns stdio and environment
 * and nothing else, so this one can be driven by a test with a fake bridge and
 * a captured write sink — the protocol is the part worth getting right, and it
 * should not need a child process to prove it.
 */

/** The server's name in `initialize`; an id, not display copy. */
export const SERVER_NAME = 'easyshell';
export const SERVER_VERSION = '1.0.0';

/** Protocol revisions this server answers; the newest is the fallback. */
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_VERSION = '2025-06-18';

/** One call to the app's bridge, already authorised by the caller. */
export type BridgeCall = (
  path: string,
  init?: { method: 'GET' | 'POST'; body?: unknown },
) => Promise<Record<string, unknown>>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'terminal_list',
    description:
      'List the terminals the user has open in EasyShell: local shells, WSL distributions and SSH sessions. ' +
      'Each entry has an id, the machine it is connected to, and whether it is the focused one. ' +
      'Call this first when you do not know which terminal to use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'terminal_run',
    description:
      "Run a shell command inside one of the user's open terminals, as that terminal's user, on the machine that " +
      'terminal is on right now — including a machine the user reached by typing `ssh`, `su` or `sudo -i` inside it. ' +
      'The command is visible while it runs: the terminal is brought to the front, the command line is written into it, ' +
      'and its output appears there as it arrives. Returns the exit code plus stdout and stderr. ' +
      "Every command passes the user's permission mode first: in manual approval mode it waits " +
      'until the user allows it, and a refusal comes back as an error you cannot work around. ' +
      'Never start an interactive program (vim, top, less, a pager): a terminal that is still on its own machine ' +
      'runs the command without a TTY and it hangs until it is killed, and on a machine reached from inside the ' +
      'terminal the command is typed into that shell, where a full-screen program blocks everything after it. ' +
      'This is the only way to reach a remote machine: your own shell runs on the desktop, not on the target.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The command line to run. It is passed to the remote shell, so pipes and redirections work.',
        },
        session_id: {
          type: 'string',
          description:
            'The terminal to run in, as returned by terminal_list. Omit it to use the focused terminal.',
        },
        cwd: {
          type: 'string',
          description:
            "Absolute directory on the target machine to run from. Omit to use the shell's own directory.",
        },
        timeout_ms: {
          type: 'number',
          description: 'Give up after this many milliseconds. Defaults to the app setting.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_focus',
    description:
      'Bring one terminal to the front so the user can watch it. Useful before a long command, ' +
      'or when you need to tell the user which terminal to look at.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The terminal to bring to the front.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
];

/** A tool result: text the model reads, and whether the call failed. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function describeSessions(payload: Record<string, unknown>): string {
  const sessions = Array.isArray(payload['sessions']) ? payload['sessions'] : [];
  if (sessions.length === 0) {
    return 'No terminals are open. Ask the user to open one before running anything.';
  }
  const lines = sessions.map((raw) => {
    const session = (raw ?? {}) as Record<string, unknown>;
    const parts = [
      `id=${String(session['id'] ?? '')}`,
      `kind=${String(session['kind'] ?? '')}`,
      `target=${String(session['target'] ?? '')}`,
      `status=${String(session['status'] ?? '')}`,
    ];
    if (typeof session['cwd'] === 'string') parts.push(`cwd=${session['cwd']}`);
    if (session['focused'] === true) parts.push('focused');
    return `- ${parts.join(' ')}`;
  });
  return [`Terminals (${sessions.length}):`, ...lines].join('\n');
}

export function describeRun(payload: Record<string, unknown>): ToolResult {
  const code = payload['code'];
  const timedOut = payload['timedOut'] === true;
  const stdout = typeof payload['stdout'] === 'string' ? payload['stdout'] : '';
  const stderr = typeof payload['stderr'] === 'string' ? payload['stderr'] : '';
  const header = [
    `terminal: ${String(payload['target'] ?? payload['sessionId'] ?? '')}`,
    `exit code: ${code === null || code === undefined ? 'none' : String(code)}${
      timedOut ? ' (timed out)' : ''
    }`,
  ];
  const body = ['stdout:', stdout.trimEnd() || '(empty)'];
  if (stderr.trim()) body.push('stderr:', stderr.trimEnd());
  // A non-zero exit is information, not a protocol failure: the tool ran, and
  // the model has to read the code rather than an error object. Marking it as an
  // error made every adapter paint the row "failed", including a command that
  // ended on a deliberate `ls` of a path that no longer exists. Only a run that
  // never finished is a failed call.
  const failed = timedOut;
  return { content: [{ type: 'text', text: [...header, ...body].join('\n') }], isError: failed };
}

export async function callTool(
  call: BridgeCall,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === 'terminal_list') {
    return text(describeSessions(await call('/sessions')));
  }
  if (name === 'terminal_focus') {
    const payload = await call('/focus', { method: 'POST', body: { sessionId: args['session_id'] } });
    return text(`brought terminal ${String(payload['sessionId'] ?? '')} to the front`);
  }
  if (name === 'terminal_run') {
    const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
    if (!command) return { ...text('command is required'), isError: true };
    const payload = await call('/run', {
      method: 'POST',
      body: {
        command,
        sessionId: args['session_id'],
        cwd: args['cwd'],
        timeoutMs: args['timeout_ms'],
      },
    });
    return describeRun(payload);
  }
  return { ...text(`unknown tool: ${name}`), isError: true };
}

/* --------------------------------------------------------------- dispatch */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpHandlerOptions {
  call: BridgeCall;
  /** Writes one message. The stdio transport owns the trailing newline. */
  write(message: Record<string, unknown>): void;
}

/**
 * Builds the line handler for MCP's stdio transport.
 *
 * Two rules the protocol is unforgiving about: a notification carries no id and
 * must never be answered, and a failed *tool call* is a result (`isError`) while
 * a failed *request* is a JSON-RPC error. Getting either wrong hangs or
 * confuses a client, so both are decided here rather than by the caller.
 */
export function createMcpHandler(options: McpHandlerOptions): (line: string) => Promise<void> {
  const { call, write } = options;

  const respond = (id: number | string, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result });
  };

  const dispatch = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = message;
    const notification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested =
          typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        if (notification) return;
        respond(id, {
          protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : LATEST_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return;
      case 'ping':
        if (!notification) respond(id, {});
        return;
      case 'tools/list':
        if (!notification) respond(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? params['name'] : '';
        const args =
          params?.['arguments'] && typeof params['arguments'] === 'object'
            ? (params['arguments'] as Record<string, unknown>)
            : {};
        try {
          const result = await callTool(call, name, args);
          if (!notification) respond(id, result);
        } catch (error) {
          // The model has to be able to read what went wrong and try something
          // else, which is only possible if this arrives as a result.
          const message = error instanceof Error ? error.message : String(error);
          if (!notification) {
            respond(id, { content: [{ type: 'text', text: message }], isError: true });
          }
        }
        return;
      }
      default:
        if (!notification) {
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${String(method ?? '')}` },
          });
        }
    }
  };

  return async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A client that logs to the same pipe is not protocol traffic.
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    await dispatch(parsed as JsonRpcMessage);
  };
}
