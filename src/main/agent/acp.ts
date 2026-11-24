/**
 * The Agent Client Protocol, spoken from the host side.
 *
 * ACP is JSON-RPC 2.0 with one message per line over the agent's stdio. The
 * host (this app) is the *client*: it creates sessions and sends prompts, while
 * the agent calls back for everything it wants to do — ask permission, run a
 * command, read a file. The terminal callbacks are where this app turns an
 * agent's "run this" into a command inside one of the user's live shells.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { defaultLaunchContext, planLaunch } from './launch';
import type { LaunchContext } from './launch';

export const ACP_PROTOCOL_VERSION = 1;

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** A JSON-RPC level failure: either ours or the agent's. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number = RPC_INTERNAL_ERROR,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/* ------------------------------------------------------------------- types */

/**
 * ACP payloads are read defensively: the protocol is young and every agent
 * fills the optional corners differently. Only the fields this app acts on are
 * named here; everything else is passed through untouched.
 */
export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
  locations?: unknown;
}

export interface AcpRequestPermissionParams {
  sessionId?: string;
  toolCall?: AcpToolCall;
  options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

/**
 * An MCP server the host provides to the agent.
 *
 * `command` has to be an absolute path, so an Electron build relaunches itself
 * as a plain Node process — `ELECTRON_RUN_AS_NODE` in `env` — and runs the
 * bundled bridge script.
 */
export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export type AcpMcpServer = AcpMcpServerStdio;

export interface AcpTerminalCreateParams {
  sessionId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  outputByteLimit?: number;
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  /**
   * Reserved by ACP for implementation extensions. `easyshell.terminal` names
   * the terminal a command is aimed at; `cwd` keeps its own meaning.
   */
  _meta?: Record<string, unknown>;
}

export interface AcpTerminalRef {
  sessionId?: string;
  terminalId?: string;
}

/** One `fs/read_text_file` request: a path, optionally a window of lines. */
export interface AcpReadTextFileParams {
  sessionId?: string;
  path?: string;
  /** 1-based number of the first line to return. */
  line?: number;
  /** How many lines to return at most. */
  limit?: number;
}
export interface AcpTerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
}

export interface AcpSessionUpdate {
  sessionUpdate?: string;
  [key: string]: unknown;
}

/**
 * Everything an agent can ask the host to do. A method that is not implemented
 * must still be answered: a silent ACP request hangs the agent forever.
 */
export interface AcpHostHandlers {
  onUpdate?(sessionId: string, update: AcpSessionUpdate): void;
  requestPermission(params: AcpRequestPermissionParams): Promise<AcpPermissionOutcome>;
  terminalCreate(params: AcpTerminalCreateParams): Promise<{ terminalId: string }>;
  terminalOutput(params: AcpTerminalRef): Promise<AcpTerminalOutput>;
  terminalWaitForExit(params: AcpTerminalRef): Promise<{
    exitCode?: number | null;
    signal?: string | null;
  }>;
  terminalKill(params: AcpTerminalRef): Promise<null>;
  terminalRelease(params: AcpTerminalRef): Promise<null>;

  /**
   * Read one text file the agent asked for. The manager answers only inside the
   * session's working directory; there is no write counterpart on purpose.
   */
  readTextFile(params: AcpReadTextFileParams): Promise<{ content: string }>;
}

export interface AcpLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  host: AcpHostHandlers;
  /** Default timeout for client → agent requests. `0` waits forever. */
  requestTimeoutMs?: number;
  /** Overridden by tests; the real machine by default. */
  launch?: LaunchContext;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* -------------------------------------------------------------- connection */

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  protocolVersion = ACP_PROTOCOL_VERSION;
  agentName = '';
  agentVersion = '';
  /**
   * Whether the agent can reopen a session it created earlier
   * (`agentCapabilities.loadSession`, advertised in `initialize`).
   */
  supportsLoadSession = false;

  constructor(private readonly options: AcpLaunchOptions) {}

  get running(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Last lines of the agent's stderr: the only clue when it dies on startup. */
  get stderrTail(): string {
    return this.stderr.trim().split('\n').slice(-8).join('\n');
  }

  async start(): Promise<void> {
    const { command, args, cwd, env } = this.options;
    if (!command) throw new AcpError('agent command is empty');
    // A Windows npm shim cannot be spawned directly (EINVAL), and routing it
    // through `cmd /c` breaks on paths with spaces. `planLaunch` reads the shim
    // and runs its script with a Node runtime instead.
    const launch = planLaunch(command, args, this.options.launch ?? defaultLaunchContext());
    const child = spawn(launch.command, launch.args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...launch.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.ingest(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.on('error', (error: Error) => {
      this.failAll(new AcpError(`agent process failed: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      const detail = this.stderrTail;
      this.failAll(
        new AcpError(
          `agent exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = asRecord(
      await this.request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // Read-only file access, and only inside the session's own working
          // directory (the manager enforces that): the agent has to be able to
          // read the project it was pointed at, or choosing a directory would
          // mean nothing. Writes stay off — the only way to change anything is a
          // shell command, which is the thing the gate sees.
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: true,
          },
        },
        30_000,
      ),
    );
    if (typeof result.protocolVersion === 'number') this.protocolVersion = result.protocolVersion;
    const info = asRecord(result.agentInfo);
    this.agentName = asString(info.name) || asString(info.title);
    this.agentVersion = asString(info.version);
    this.supportsLoadSession = asRecord(result.agentCapabilities).loadSession === true;
  }

  /**
   * Starts a session, handing the agent the MCP servers this app provides.
   *
   * `mcpServers` is the one channel through which a host can give an agent a
   * capability the agent does not implement: the agent spawns the server and
   * gets a tool. That is how a CLI without ACP terminals still reaches a real
   * terminal, and it costs the agent nothing but MCP, which all of them speak.
   */
  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<string> {
    const result = asRecord(
      await this.request('session/new', { cwd, mcpServers }, 60_000),
    );
    const sessionId = asString(result.sessionId);
    if (!sessionId) throw new AcpError('agent did not return a session id');
    return sessionId;
  }

  /**
   * Reopens a session the agent created earlier, e.g. before a restart.
   *
   * ACP replays the conversation as `session/update` notifications before it
   * answers, so the transcript rebuilds itself through the normal channel. Only
   * call this when `supportsLoadSession` is true: agents that do not implement
   * it answer with a method-not-found error.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AcpMcpServer[] = [],
  ): Promise<void> {
    await this.request('session/load', { sessionId, cwd, mcpServers }, 120_000);
  }

  /** Sends one turn and resolves with the stop reason when the agent is done. */
  async prompt(sessionId: string, text: string, timeoutMs = 0): Promise<string> {
    const result = asRecord(
      await this.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text } as AcpTextContent] },
        timeoutMs,
      ),
    );
    return asString(result.stopReason) || 'end_turn';
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  dispose(): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new AcpError('agent connection closed'));
      this.pending.delete(id);
    }
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* the process is already gone */
      }
    }
  }

  /* ---------------------------------------------------------------- wire */

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
    // A single unterminated message must not grow without bound.
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = '';
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      // Agents sometimes log to stdout; those lines are not protocol traffic.
      return;
    }
    const id = message.id;
    const method = asString(message.method);

    if (typeof method === 'string' && method.length > 0) {
      if (typeof id === 'number' || typeof id === 'string') {
        void this.dispatchRequest(id, method, message.params);
      } else {
        this.dispatchNotification(method, message.params);
      }
      return;
    }

    if (typeof id === 'number') {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      const error = message.error;
      if (error) {
        const record = asRecord(error);
        entry.reject(
          new AcpError(
            asString(record.message) || `${entry.method} failed`,
            typeof record.code === 'number' ? record.code : RPC_INTERNAL_ERROR,
            record.data,
          ),
        );
        return;
      }
      entry.resolve(message.result ?? null);
    }
  }

  private dispatchNotification(method: string, rawParams: unknown): void {
    if (method !== 'session/update') return;
    const params = asRecord(rawParams);
    const sessionId = asString(params.sessionId);
    const update = asRecord(params.update);
    this.options.host.onUpdate?.(sessionId, update as AcpSessionUpdate);
  }

  private async dispatchRequest(
    id: number | string,
    method: string,
    rawParams: unknown,
  ): Promise<void> {
    const params = asRecord(rawParams);
    try {
      const result = await this.routeHostMethod(method, params);
      this.writeMessage({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const failure = error instanceof AcpError ? error : new AcpError(String(error));
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: failure.code, message: failure.message, data: failure.data ?? null },
      });
    }
  }

  private async routeHostMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const host = this.options.host;
    switch (method) {
      case 'session/request_permission':
        return host.requestPermission(params as AcpRequestPermissionParams);
      case 'terminal/create':
        return host.terminalCreate(params as AcpTerminalCreateParams);
      case 'terminal/output':
        return host.terminalOutput(params as AcpTerminalRef);
      case 'terminal/wait_for_exit':
        return host.terminalWaitForExit(params as AcpTerminalRef);
      case 'terminal/kill':
        return host.terminalKill(params as AcpTerminalRef);
      case 'terminal/release':
        return host.terminalRelease(params as AcpTerminalRef);
      case 'fs/read_text_file':
        return host.readTextFile(params as AcpReadTextFileParams);
      case 'fs/write_text_file':
        throw new AcpError(
          'writing files is disabled: leave anything behind with a shell command in a terminal',
          RPC_METHOD_NOT_FOUND,
        );
      default:
        throw new AcpError(`unsupported host method: ${method}`, RPC_METHOD_NOT_FOUND);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.child) {
      return Promise.reject(new AcpError('agent connection is not running'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpError(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* the write failed because the process is gone; exit handles the rest */
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Builds a host handler set that refuses everything: used by the classifier. */
export function denyAllHost(
  onUpdate?: (sessionId: string, update: AcpSessionUpdate) => void,
): AcpHostHandlers {
  const refuse = (method: string) => () =>
    Promise.reject(
      new AcpError(`this session may not call ${method}`, RPC_METHOD_NOT_FOUND),
    );
  return {
    onUpdate,
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    terminalCreate: refuse('terminal/create') as AcpHostHandlers['terminalCreate'],
    terminalOutput: refuse('terminal/output') as AcpHostHandlers['terminalOutput'],
    terminalWaitForExit: refuse(
      'terminal/wait_for_exit',
    ) as AcpHostHandlers['terminalWaitForExit'],
    terminalKill: refuse('terminal/kill') as AcpHostHandlers['terminalKill'],
    terminalRelease: refuse('terminal/release') as AcpHostHandlers['terminalRelease'],
    readTextFile: refuse('fs/read_text_file') as AcpHostHandlers['readTextFile'],
  };
}
