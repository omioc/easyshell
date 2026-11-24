/**
 * The loopback door the MCP bridge knocks on.
 *
 * The MCP server is spawned by the *agent*, not by this app, so it cannot be
 * handed an IPC channel or a function. What it can have is a URL: this
 * listener, bound to 127.0.0.1 on a port the operating system picks, guarded by
 * a token generated for this run.
 *
 * It is deliberately separate from the control API. That one is a user-facing
 * surface behind a setting; this one has to exist whenever an agent does,
 * whether or not the user ever turned the API on.
 *
 * Only three routes exist, and `run` is the whole point of them: it asks the
 * permission gate first — the same checkpoint an ACP `terminal/create` passes —
 * and then goes through `SessionManager.runCommand()`, which is the same
 * observable path: tab to the front, command echoed into the terminal, output
 * streamed while it happens.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { matchSession } from '../../shared/agent';
import type { SessionInfo, Settings } from '../../shared/types';
import type { SessionManager } from '../session/manager';

export interface AgentBridgeOptions {
  sessions: SessionManager;
  getSettings: () => Settings;
  /** The terminal the composer points at, used when a tool names none. */
  focused: () => string | null;
  /**
   * The permission gate, consulted before any command runs.
   *
   * An agent is told to prefer this bridge over ACP terminals, so the gate has
   * to live here too; without it the bridge is a way around the permission
   * mode. Leaving it out refuses every run: a bridge that cannot ask is a
   * bridge that may not execute.
   */
  authorize?: (input: {
    taskId: string;
    command: string;
    sessionId: string;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  /**
   * How a run over this bridge ended, for the row the adapter drew.
   *
   * The output goes back to the agent over MCP and never through ACP, so this is
   * the only way the transcript can show what the command answered. Optional: a
   * bridge started without an agent task still runs commands.
   */
  onRun?: (input: {
    taskId: string;
    command: string;
    sessionId: string;
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }) => void;
}

/** What an agent needs to reach the bridge. Passed to the MCP server as env. */
export interface AgentBridgeEndpoint {
  url: string;
  token: string;
}

/** One command's worth of request body; a directory listing is far smaller. */
const MAX_BODY = 1_000_000;

function reply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** The shape a model can act on: enough to pick a terminal, nothing more. */
function summarize(session: SessionInfo, focused: string | null): Record<string, unknown> {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    target: session.metadata.endpoint.displayName,
    status: session.status,
    cwd: session.cwd,
    focused: session.id === focused,
  };
}

export class AgentBridge {
  /** Regenerated on every start: nothing holds a token past a restart. */
  private token = '';
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly options: AgentBridgeOptions) {}

  get endpoint(): AgentBridgeEndpoint | null {
    if (!this.server) return null;
    return { url: `http://127.0.0.1:${this.port}`, token: this.token };
  }

  async start(): Promise<AgentBridgeEndpoint | null> {
    await this.stop();
    this.token = randomBytes(24).toString('hex');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });

    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => {
        server.removeListener('listening', onListening);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Port 0: the OS picks a free one. A fixed port would collide with a
      // second profile, a second install, or whatever else got there first.
      server.listen(0, '127.0.0.1');
    });

    if (!ok) {
      server.close();
      return null;
    }
    const address = server.address();
    this.server = server;
    this.port = typeof address === 'object' && address ? address.port : 0;
    return this.endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.token = '';
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.token) return false;
    const header = req.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${this.token}`;
  }

  /**
   * Which terminal a call is about.
   *
   * A name that matches nothing resolves to nothing: running on a machine the
   * agent did not ask for is worse than refusing. With no name at all the
   * focused terminal wins, and a single tab is unambiguous by itself.
   */
  private resolve(name: unknown): SessionInfo | null {
    const sessions = this.options.sessions.list();
    if (typeof name === 'string' && name.trim()) return matchSession(sessions, name);
    const focused = this.options.focused();
    const pinned = focused ? sessions.find((session) => session.id === focused) : undefined;
    if (pinned) return pinned;
    return sessions.length === 1 ? (sessions[0] ?? null) : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      reply(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && path === '/sessions') {
        const focused = this.options.focused();
        const sessions = this.options.sessions.list();
        reply(res, 200, { sessions: sessions.map((session) => summarize(session, focused)) });
        return;
      }

      if (method === 'POST' && path === '/focus') {
        const body = await readJson(req);
        const session = this.resolve(body['sessionId']);
        if (!session) {
          reply(res, 404, { error: 'terminal not found' });
          return;
        }
        this.options.sessions.focus(session.id);
        reply(res, 200, { ok: true, sessionId: session.id });
        return;
      }

      if (method === 'POST' && path === '/run') {
        const body = await readJson(req);
        const command = typeof body['command'] === 'string' ? body['command'].trim() : '';
        if (!command) {
          reply(res, 400, { error: 'command is required' });
          return;
        }
        const session = this.resolve(body['sessionId']);
        if (!session) {
          reply(res, 409, {
            error: 'no terminal: pass session_id, or open (and focus) a terminal first',
          });
          return;
        }
        const settings = this.options.getSettings();
        const requested = Number(body['timeoutMs']);
        const timeoutMs =
          Number.isFinite(requested) && requested > 0
            ? Math.min(requested, 600_000)
            : settings.agent.commandTimeoutMs;
        // A directory the agent named has to be absolute, so it means the same
        // thing wherever the shell happens to be.
        const cwd =
          typeof body['cwd'] === 'string' && body['cwd'].trim().startsWith('/')
            ? body['cwd'].trim()
            : undefined;
        const verdict = await this.authorize(this.taskOf(req), command, session.id);
        if (!verdict.allowed) {
          reply(res, 403, {
            error: verdict.reason || 'the permission gate refused this command',
          });
          return;
        }
        const result = await this.options.sessions.runCommand(session.id, command, {
          timeoutMs,
          cwd,
        });
        // Hand the ending back before replying: the row shows the answer while
        // the agent is still reading it out of its own tool result.
        this.options.onRun?.({
          taskId: this.taskOf(req),
          command,
          sessionId: session.id,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
          timedOut: result.timedOut === true,
        });
        reply(res, 200, { sessionId: session.id, target: session.metadata.endpoint.displayName, ...result });
        return;
      }

      reply(res, 404, { error: 'not found' });
    } catch (error) {
      reply(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Asks the gate before a command touches a terminal.
   *
   * Anything the gate cannot answer is a refusal: this is the one place where
   * an error must never degrade into running the command anyway.
   */
  private async authorize(
    taskId: string,
    command: string,
    sessionId: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const authorize = this.options.authorize;
    if (!authorize) return { allowed: false, reason: 'the permission gate is not available' };
    try {
      return await authorize({ taskId, command, sessionId });
    } catch (error) {
      return {
        allowed: false,
        reason: `the permission gate failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** The agent task this call came from: one bridge serves every task. */
  private taskOf(req: IncomingMessage): string {
    const value = req.headers['x-easyshell-task'];
    return typeof value === 'string' ? value.trim() : '';
  }
}
