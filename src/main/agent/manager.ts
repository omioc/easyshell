/**
 * Agent tasks.
 *
 * One task is one ACP session on one agent process. The task is *not* bound to
 * a terminal: every command the agent wants to run names a terminal (or falls
 * back to the focused one), which is what lets a single conversation work
 * across several live tabs.
 *
 * Every path that can execute a command goes through `gate()`:
 *   session/request_permission 鈫?gate 鈫?answer the agent
 *   terminal/create            鈫?gate 鈫?run inside the named session
 * The gate asks the classifier (the agent CLI, second session) for a verdict and
 * then maps mode 脳 verdict onto run / ask / deny. The app itself never decides
 * that a command is safe.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  CONSERVATIVE_VERDICT,
  buildAgentPromptContext,
  commandKey,
  decideAgentAction,
  matchSession,
  stripAnsi,
  tailLines,
  toolCallTarget,
} from '../../shared/agent';
import { translate } from '../../shared/i18n';
import type {
  AgentApprovalRequest,
  AgentEvent,
  AgentPermissionMode,
  AgentRiskState,
  AgentTaskInfo,
  AgentTaskMode,
  AgentTaskOptions,
  AgentToolCallInfo,
  AgentToolCallStatus,
  AgentTranscript,
  Locale,
  Settings,
} from '../../shared/types';
import { AcpConnection, AcpError, RPC_INVALID_PARAMS } from './acp';
import type {
  AcpHostHandlers,
  AcpPermissionOutcome,
  AcpReadTextFileParams,
  AcpRequestPermissionParams,
  AcpSessionUpdate,
  AcpTerminalCreateParams,
  AcpTerminalRef,
} from './acp';
import { CommandClassifier } from './classifier';
import { posixQuote } from '../session/types';
import type { AcpMcpServer } from './acp';
import type { SessionManager } from '../session/manager';

/** One file the agent can ask for; bigger than this belongs to a shell command. */
const MAX_FILE_READ_BYTES = 1_000_000;
/**
 * How long a permission answer stays usable for the execution that follows it.
 *
 * One logical call reaches the gate twice in some adapters (the permission
 * request, then the bridge or `terminal/create`), which is the only thing this
 * window is for: the two gates are milliseconds apart, so anything that asks
 * again seconds later is a new question, not the same one.
 */
const ALLOW_CACHE_MS = 10_000;
const APPROVAL_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
];
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AgentManagerOptions {
  getSettings(): Settings;
  sessions: SessionManager;
  /**
   * Scratch directory for `temp` tasks and for the classifier. Created on demand:
   * ACP refuses an empty `cwd`, so there is no such thing as "no directory".
   */
  tempDir: string;
  /** Where task records are written so a restart can bring them back. */
  tasksFile: string;
  emit(event: AgentEvent): void;
  /**
   * MCP servers handed to every new agent session.
   *
   * This is the door an agent CLI that does not implement ACP terminals walks
   * through: the server answers as a tool, and the tool calls back into the
   * same terminal path an ACP terminal request takes.
   */
  mcpServers?: (taskId: string) => AcpMcpServer[];
  /**
   * Effective UI locale. The classifier writes its one-sentence reason in it,
   * and that sentence is shown verbatim in the approval card.
   */
  getLocale?: () => Locale;
}

/**
 * What survives a restart: the directory and the agent session id, not the
 * conversation itself. The transcript is rebuilt by `session/load` replay.
 */
interface PersistedTask {
  id: string;
  title: string;
  mode: AgentTaskMode;
  cwd: string;
  acpSessionId?: string;
  agentName?: string;
  createdAt: number;
  updatedAt: number;
  commandCount: number;
}

interface PersistedFile {
  version: 1;
  tasks: PersistedTask[];
}

interface TaskRuntime {
  info: AgentTaskInfo;
  connection: AcpConnection | null;
  connecting: Promise<void> | null;
  messages: AgentTranscript['messages'];
  toolCalls: Map<string, AgentToolCallInfo>;
  agentStream: string | null;
  thoughtStream: string | null;
  /** The message the next user chunk extends, while a replay is running. */
  userStream: string | null;
  /**
   * True between `session/load` and its answer: the agent is replaying the
   * conversation, so its `user_message_chunk` updates are the only record of
   * what the user said. Outside a replay those chunks are ignored 鈥?the host
   * already pushed the user's own message when the turn started.
   */
  replaying: boolean;
  /** The last value `stamp()` handed out: it only ever moves forward. */
  lastStamp: number;
  messageSeq: number;
  /** True until the first prompt names the task. */
  autoTitle: boolean;
}

interface TerminalJob {
  id: string;
  taskId: string;
  sessionId: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  limit: number;
  wake: (() => void) | null;
  /** Set by `terminal/kill`: the exit status reports a signal, not a code. */
  killed: boolean;
  abort: AbortController;
}

interface PendingApproval {
  request: AgentApprovalRequest;
  settle(optionId: string | null): void;
}

interface GateResult {
  allowed: boolean;
  risk: AgentRiskState;
  reason: string;
  sessionId: string | null;
  label: string;
}

/** What the gate decided about one command, kept for the row that reports it. */
interface CommandVerdict {
  risk: AgentRiskState;
  reason: string;
  allowed: boolean;
  sessionId: string | null;
}

export class AgentManager {
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly jobs = new Map<string, TerminalJob>();
  /**
   * Commands the user (or the mode) already cleared, keyed by session + command.
   *
   * The whole verdict is kept, not a timestamp: a repeat has to report the same
   * risk and the same sentence as the first run, or the row would read
   * "already approved" instead of what the gate actually decided.
   */
  private readonly cleared = new Map<
    string,
    { until: number; risk: AgentRiskState; reason: string }
  >();
  private readonly pendingByCommand = new Map<string, Promise<boolean>>();
  /**
   * Verdicts keyed by task + tool call, so the row the adapter reports can carry
   * what the gate decided. An adapter may ask for permission first and describe
   * the call afterwards, so the verdict is kept until the row shows up.
   */
  private readonly verdicts = new Map<string, CommandVerdict>();
  private readonly classifier: CommandClassifier;
  private focusedSessionId: string | null = null;
  private taskSeq = 0;

  constructor(private readonly options: AgentManagerOptions) {
    this.classifier = new CommandClassifier({
      getSettings: options.getSettings,
      getLocale: options.getLocale,
      workDir: options.tempDir,
      onDegrade: (reason) => {
        this.emit({
          type: 'agent-notice',
          notice: { level: 'warn', key: 'agent.notice.classifierDown', params: { reason } },
        });
      },
    });
    this.restore();
  }

  /* ------------------------------------------------------- task records */

  /**
   * Writes the task list.
   *
   * Called only when something a restart must remember changes 鈥?creation, the
   * session id, the auto title, closure 鈥?because status and transcript are
   * runtime state, not records.
   */
  private persist(): void {
    const tasks: PersistedTask[] = [...this.tasks.values()].map((task) => ({
      id: task.info.id,
      title: task.info.title,
      mode: task.info.mode,
      cwd: task.info.cwd,
      acpSessionId: task.info.acpSessionId,
      agentName: task.info.agentName,
      createdAt: task.info.createdAt,
      updatedAt: task.info.updatedAt,
      commandCount: task.info.commandCount,
    }));
    const file: PersistedFile = { version: 1, tasks };
    try {
      mkdirSync(dirname(this.options.tasksFile), { recursive: true });
      // Write then rename: a half-written file would lose every task at once.
      const temp = `${this.options.tasksFile}.tmp`;
      writeFileSync(temp, JSON.stringify(file, null, 2), 'utf8');
      renameSync(temp, this.options.tasksFile);
    } catch {
      /* a task list that cannot be written must not break the task itself */
    }
  }

  /**
   * Brings back the records from the last run.
   *
   * Nothing is spawned here: a restored task gets its process and its session
   * back when the user opens it (`resume`), so ten tasks do not cost ten
   * processes at startup. `restored` marks the ones still waiting for that.
   */
  private restore(): void {
    let raw: string;
    try {
      raw = readFileSync(this.options.tasksFile, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const file = (parsed ?? {}) as Partial<PersistedFile>;
    if (!Array.isArray(file.tasks)) return;

    for (const entry of file.tasks) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Partial<PersistedTask>;
      const id = typeof record.id === 'string' ? record.id : '';
      const cwd = typeof record.cwd === 'string' ? record.cwd : '';
      if (!id || !cwd || !isAbsolute(cwd) || this.tasks.has(id)) continue;
      this.taskSeq += 1;
      const now = Date.now();
      const sessionId =
        typeof record.acpSessionId === 'string' && record.acpSessionId
          ? record.acpSessionId
          : undefined;
      const info: AgentTaskInfo = {
        id,
        title:
          typeof record.title === 'string' && record.title.trim()
            ? record.title
            : `#${this.taskSeq}`,
        status: 'idle',
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
        commandCount: typeof record.commandCount === 'number' ? record.commandCount : 0,
        acpSessionId: sessionId,
        agentName:
          typeof record.agentName === 'string' && record.agentName ? record.agentName : undefined,
        mode: record.mode === 'project' ? 'project' : 'temp',
        cwd,
        // Only a task that has a session id has anything to load back.
        restored: Boolean(sessionId),
      };
      this.tasks.set(id, {
        info,
        connection: null,
        connecting: null,
        messages: [],
        toolCalls: new Map(),
        agentStream: null,
        thoughtStream: null,
        userStream: null,
        messageSeq: 0,
        replaying: false,
        lastStamp: 0,
        autoTitle: false,
      });
    }
  }

  /** ACP needs a directory that exists; spawn fails with ENOENT otherwise. */
  private ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Validates the directory the picker returned; the UI is not trusted with it. */
  private projectDir(raw: string | undefined): string {
    const dir = typeof raw === 'string' ? raw.trim() : '';
    if (!dir) throw new Error('a project task needs a directory');
    if (!isAbsolute(dir)) throw new Error(`not an absolute directory: ${dir}`);
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }
    return dir;
  }

  /* ------------------------------------------------------------ public API */

  list(): AgentTaskInfo[] {
    return [...this.tasks.values()].map((task) => ({ ...task.info }));
  }

  /**
   * Creates a task record.
   *
   * `temp` tasks work in the app's scratch directory and need no decision from
   * the user; `project` tasks work in a directory the user picked, which is what
   * gives the agent its project context. The directory is created here rather
   * than at the first prompt, so a bad path fails while the user is still there.
   */
  create(title?: string, options?: AgentTaskOptions): AgentTaskInfo {
    const settings = this.options.getSettings();
    // The switch is a real gate, not a label: with it off nothing may be started.
    if (!settings.agent.enabled) throw new Error('the AI assistant is switched off');
    const mode: AgentTaskMode = options?.mode === 'project' ? 'project' : 'temp';
    const cwd = this.ensureDir(
      mode === 'project' ? this.projectDir(options?.cwd) : this.options.tempDir,
    );
    this.taskSeq += 1;
    const now = Date.now();
    const info: AgentTaskInfo = {
      id: randomUUID(),
      title: title?.trim() || `#${this.taskSeq}`,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      commandCount: 0,
      mode,
      cwd,
    };
    const task: TaskRuntime = {
      info,
      connection: null,
      connecting: null,
      messages: [],
      toolCalls: new Map(),
      agentStream: null,
      thoughtStream: null,
      userStream: null,
      replaying: false,
      lastStamp: 0,
      messageSeq: 0,
      autoTitle: !title?.trim(),
    };
    this.tasks.set(info.id, task);
    this.emit({ type: 'agent-task', task: { ...info } });
    this.persist();
    return { ...info };
  }

  /**
   * Reopens a restored task's agent session without sending a prompt.
   *
   * A no-op when the task has no session to load (a fresh task, or one that was
   * closed before its first prompt), so the renderer can call it on every open.
   */
  async resume(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.connection?.running || !task.info.acpSessionId) return;
    try {
      await this.ensureSession(task);
    } catch (error) {
      this.fail(task, error);
    }
  }

  transcript(taskId: string): AgentTranscript {
    const task = this.tasks.get(taskId);
    if (!task) return { messages: [], toolCalls: [] };
    return {
      messages: task.messages.map((message) => ({ ...message })),
      toolCalls: [...task.toolCalls.values()].map((call) => ({ ...call })),
    };
  }

  setFocus(sessionId: string | null): void {
    this.focusedSessionId = sessionId;
  }

  /** The terminal the composer points at, for callers outside the renderer. */
  focused(): string | null {
    return this.focusedSessionId;
  }

  /** Resolves an approval card. `null` means the user said no. */
  respond(requestId: string, optionId: string | null): void {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    this.approvals.delete(requestId);
    const allowed = optionId !== null && optionId.startsWith('allow');
    this.emit({
      type: 'agent-approval-resolved',
      taskId: pending.request.taskId,
      requestId,
      allowed,
    });
    if (!allowed) {
      this.emit({
        type: 'agent-notice',
        notice: { level: 'info', key: 'agent.notice.denied' },
      });
    }
    pending.settle(allowed ? optionId : null);
  }

  async prompt(taskId: string, text: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const body = text.trim();
    if (!body) return;

    if (task.autoTitle) {
      // Give the task a name the user recognises in the list.
      task.info.title = body.split('\n')[0]?.slice(0, 60) || task.info.title;
      task.autoTitle = false;
      this.persist();
    }
    this.pushMessage(task, 'user', body);
    this.setStatus(task, 'running');

    try {
      await this.ensureSession(task);
      const settings = this.options.getSettings();
      const context = buildAgentPromptContext({
        mode: settings.agent.permissionMode,
        sessions: this.options.sessions.list(),
        focusedSessionId: this.focusedSessionId,
        tails: this.contextTails(settings),
        workDir: task.info.cwd,
      });
      const stopReason = await task.connection!.prompt(
        task.info.acpSessionId!,
        `${context}\n\n${body}`,
      );
      this.endStreams(task);
      if (stopReason === 'refusal') {
        this.emit({
          type: 'agent-notice',
          notice: { level: 'info', key: 'agent.notice.refusal' },
        });
      }
      this.setStatus(task, 'idle');
    } catch (error) {
      this.fail(task, error);
    }
  }

  /**
   * A failed turn or a failed resume.
   *
   * The session id is kept on purpose: the next attempt tries to load it again
   * and, if the agent has forgotten the session, `ensureSession` falls back to a
   * fresh one. Clearing it here would throw away the only way back.
   */
  private fail(task: TaskRuntime, error: unknown): void {
    this.endStreams(task);
    task.connection?.dispose();
    task.connection = null;
    const message = error instanceof Error ? error.message : String(error);
    task.info.error = message;
    this.setStatus(task, 'error');
    this.persist();
    this.emit({
      type: 'agent-notice',
      notice: { level: 'error', key: 'agent.notice.agentFailed', params: { message } },
    });
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task?.connection || !task.info.acpSessionId) return;
    task.connection.cancel(task.info.acpSessionId);
    for (const [requestId, pending] of this.approvals) {
      if (pending.request.taskId !== taskId) continue;
      this.approvals.delete(requestId);
      pending.settle(null);
    }
  }

  close(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.cancel(taskId);
    task.connection?.dispose();
    task.connection = null;
    for (const [jobId, job] of this.jobs) {
      if (job.taskId === taskId) this.jobs.delete(jobId);
    }
    this.tasks.delete(taskId);
    for (const key of this.verdicts.keys()) {
      if (key.startsWith(`${taskId}\u0000`)) this.verdicts.delete(key);
    }
    this.emit({ type: 'agent-task-removed', taskId });
    this.persist();
  }

  /**
   * Quits: kills every agent process but leaves the records on disk.
   *
   * Deliberately not a `close` loop 鈥?that would persist an empty task list and
   * there would be nothing to restore on the next start.
   */
  shutdown(): void {
    for (const task of this.tasks.values()) {
      task.connection?.dispose();
      task.connection = null;
    }
    this.tasks.clear();
    this.approvals.clear();
    this.jobs.clear();
    this.verdicts.clear();
    this.classifier.dispose();
  }

  /* --------------------------------------------------------------- session */

  /**
   * Gets a running agent process with a usable session for this task.
   *
   * The working directory is the task's, not a global setting: `temp` tasks run
   * in the scratch directory, `project` tasks in the directory the user picked.
   *
   * A task that already carries a session id (restored from disk, or one whose
   * process exited) is reopened with `session/load` when the agent supports it 鈥?   * ACP replays the conversation as `session/update`, so the transcript comes
   * back through the normal channel. Everything else starts a fresh session.
   */
  private async ensureSession(task: TaskRuntime): Promise<void> {
    if (task.connection?.running && task.info.acpSessionId) return;
    if (task.connecting) return task.connecting;

    const settings = this.options.getSettings();
    const agent = settings.agent;
    if (!agent.command) throw new Error('agent command is not configured');
    // The scratch directory can be deleted between runs.
    const cwd = this.ensureDir(task.info.cwd);
    const connection = new AcpConnection({
      command: agent.command,
      args: agent.args,
      cwd,
      env: agent.env,
      host: this.hostFor(task),
    });

    // Handed to the agent on every session, not just the first: an adapter may
    // restart its session at any time, and a bridge that only exists on the
    // first one would silently disappear after a reconnect.
    const mcpServers = this.options.mcpServers?.(task.info.id) ?? [];

    task.connecting = (async () => {
      await connection.start();
      const previous = task.info.acpSessionId;
      let sessionId = '';
      if (previous) {
        if (!connection.supportsLoadSession) {
          // The agent cannot reopen a session at all: say so, instead of letting
          // a new session look like the old one silently lost its history.
          this.emit({
            type: 'agent-notice',
            notice: { level: 'info', key: 'agent.notice.sessionReset' },
          });
        } else {
          // While this awaits, the agent replays the whole conversation as
          // `session/update` notifications, user turns included.
          task.replaying = true;
          try {
            await connection.loadSession(previous, cwd, mcpServers);
            sessionId = previous;
          } catch {
            this.emit({
              type: 'agent-notice',
              notice: { level: 'warn', key: 'agent.notice.sessionReset' },
            });
          } finally {
            task.replaying = false;
            // A replay is one long turn that never ends: it writes its answer
            // through the same stream channel a live one uses, and nothing
            // arrives afterwards to close it. Left open, the last replayed
            // block kept the caret of an answer still being typed - forever,
            // with the slot still pointing at it, so the next turn appended to
            // the old message instead of starting its own.
            this.endStreams(task);
          }
        }
      }
      task.connection = connection;
      task.info.acpSessionId = sessionId || (await connection.newSession(cwd, mcpServers));
      task.info.restored = false;
      task.info.agentName =
        [connection.agentName, connection.agentVersion].filter(Boolean).join(' ') || undefined;
      this.emit({ type: 'agent-task', task: { ...task.info } });
      this.persist();
    })().catch((error: unknown) => {
      connection.dispose();
      throw error;
    });
    try {
      await task.connecting;
    } finally {
      task.connecting = null;
    }
  }

  /** Only the focused terminal's last lines ride along: the rest is metadata. */
  private contextTails(settings: Settings): Record<string, string> {
    const tails: Record<string, string> = {};
    const focused = this.focusedSessionId;
    if (!focused || settings.agent.contextTailLines <= 0) return tails;
    const snapshot = this.options.sessions.attach(focused);
    if (!snapshot) return tails;
    const text = tailLines(stripAnsi(snapshot.data), settings.agent.contextTailLines);
    if (text) tails[focused] = text.slice(-2000);
    return tails;
  }

  /* --------------------------------------------------------------- updates */

  private hostFor(task: TaskRuntime): AcpHostHandlers {
    return {
      onUpdate: (_sessionId, update) => this.onUpdate(task, update),
      requestPermission: (params) => this.handleRequestPermission(task, params),
      terminalCreate: (params) => this.terminalCreate(task, params),
      terminalOutput: (params) => this.terminalOutput(params),
      terminalWaitForExit: (params) => this.terminalWaitForExit(params),
      terminalKill: (params) => this.terminalKill(params),
      terminalRelease: (params) => this.terminalRelease(params),
      readTextFile: (params) => this.readTextFile(task, params),
    };
  }

  /**
   * Reads a file for the agent, and only inside the task's own directory.
   *
   * The directory the user picked when the session was created is the contract:
   * the agent may read the project it was pointed at — deployment notes, compose
   * files, a README — and nothing else on the desktop. Every path goes through
   * `realpath` first, so `..` and symlinks cannot walk out of it. There is no
   * write counterpart: anything the agent leaves behind belongs in a terminal,
   * where the gate can see it.
   */
  private async readTextFile(
    task: TaskRuntime,
    params: AcpReadTextFileParams,
  ): Promise<{ content: string }> {
    const requested = typeof params.path === 'string' ? params.path.trim() : '';
    if (!requested) throw new AcpError('fs/read_text_file without a path', RPC_INVALID_PARAMS);

    const root = this.canonicalPath(task.info.cwd);
    const target = this.canonicalPath(requested, true);
    const rel = relative(root, target);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new AcpError(
        `read outside the session working directory: ${requested}`,
        RPC_INVALID_PARAMS,
      );
    }

    let size = 0;
    try {
      const stat = statSync(target);
      if (!stat.isFile()) throw new AcpError(`not a file: ${requested}`, RPC_INVALID_PARAMS);
      size = stat.size;
    } catch (error) {
      if (error instanceof AcpError) throw error;
      throw new AcpError(`cannot read ${requested}: ${describeError(error)}`, RPC_INVALID_PARAMS);
    }
    if (size > MAX_FILE_READ_BYTES) {
      throw new AcpError(
        `${requested} is ${size} bytes; read part of it with a shell command instead`,
        RPC_INVALID_PARAMS,
      );
    }

    const text = readFileSync(target, 'utf8');
    if (text.includes('\u0000')) {
      throw new AcpError(`${requested} is not a text file`, RPC_INVALID_PARAMS);
    }
    const lines = text.split('\n');
    const first = Number.isFinite(params.line) && (params.line ?? 0) > 0 ? (params.line ?? 1) - 1 : 0;
    const count =
      Number.isFinite(params.limit) && (params.limit ?? 0) > 0 ? (params.limit ?? 0) : lines.length;
    return { content: lines.slice(first, first + count).join('\n') };
  }

  /**
   * The real path behind a path (symlinks resolved), or the resolved path when
   * it does not exist yet. `must exist` is for the file the agent named: a
   * missing file is an answer, not something to read.
   */
  private canonicalPath(path: string, mustExist = false): string {
    try {
      return realpathSync(path);
    } catch (error) {
      if (mustExist) {
        throw new AcpError(`cannot resolve ${path}: ${describeError(error)}`, RPC_INVALID_PARAMS);
      }
      return resolve(path);
    }
  }

  private onUpdate(task: TaskRuntime, update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // Only meaningful while the agent is replaying its history: it is the
        // one channel that carries what the user said in earlier turns. In a
        // live turn the host already pushed that message itself, so an echo
        // here would duplicate every prompt.
        if (task.replaying) this.appendStream(task, 'user', textOf(update));
        break;
      case 'agent_message_chunk':
        this.appendStream(task, 'agent', textOf(update));
        break;
      case 'agent_thought_chunk':
        this.appendStream(task, 'thought', textOf(update));
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.upsertToolCall(task, update);
        break;
      default:
        break;
    }
  }

  private appendStream(task: TaskRuntime, role: 'user' | 'agent' | 'thought', chunk: string): void {
    if (!chunk) return;
    const slot = role === 'user' ? 'userStream' : role === 'agent' ? 'agentStream' : 'thoughtStream';
    const currentId = task[slot];
    if (!currentId) {
      // One stream at a time: a chunk of a new kind starts a new block, so a
      // replayed history does not collapse into one long agent message.
      this.endStreams(task);
      const message = this.pushMessage(task, role, chunk, true);
      task[slot] = message.id;
      return;
    }
    const message = task.messages.find((item) => item.id === currentId);
    if (!message) {
      task[slot] = null;
      this.appendStream(task, role, chunk);
      return;
    }
    message.text += chunk;
    // Strip as the block completes rather than when the turn ends: a replay can
    // arrive in pieces, and the first render of a reopened conversation must
    // already show the user's own words.
    if (message.role === 'user') message.text = stripPromptContext(message.text);
    this.emit({ type: 'agent-message', message: { ...message } });
  }

  private endStreams(task: TaskRuntime): void {
    for (const slot of ['userStream', 'agentStream', 'thoughtStream'] as const) {
      const id = task[slot];
      if (!id) continue;
      const message = task.messages.find((item) => item.id === id);
      if (message) {

        message.streaming = false;
        this.emit({ type: 'agent-message', message: { ...message } });
      }
      task[slot] = null;
    }
  }

  private upsertToolCall(task: TaskRuntime, update: AcpSessionUpdate): void {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!toolCallId) return;
    const existing = task.toolCalls.get(toolCallId);
    // A command ends the prose that led to it: whatever the agent writes next
    // belongs after this row, not inside the paragraph that started before it.
    if (!existing) this.endStreams(task);
    const rawStatus = typeof update.status === 'string' ? update.status : undefined;
    const call: AgentToolCallInfo = existing ?? {
      id: toolCallId,
      taskId: task.info.id,
      title: '',
      kind: 'other',
      status: 'pending',
      risk: 'unknown',
      startedAt: this.stamp(task),
    };
    if (typeof update.title === 'string' && update.title) call.title = update.title;
    if (typeof update.kind === 'string' && update.kind) call.kind = update.kind;
    if (rawStatus) call.status = normalizeToolStatus(rawStatus);
    // The command the call will run, wherever the adapter put it - top level or
    // one level down in MCP arguments (`params`, `arguments`). It is on the row
    // before the gate is asked, so the row names the command even while the card
    // is still open.
    const target = toolCallTarget(update.rawInput);
    if (target.command) call.command = target.command;
    // The raw arguments are only a stand-in for a command the adapter has not
    // finished writing, so they are read again whenever an update carries them:
    // CodeBuddy streams a draft (`{params: {command: ""}}`) before the real ones,
    // and keeping the first left that draft on the row for good - under "input",
    // right below the command it was a draft of. An update that carries no
    // arguments at all is a status or a result, and says nothing about them.
    if (update.rawInput !== undefined && update.rawInput !== null) {
      const input = target.command ? '' : toolInputText(update.rawInput);
      if (input) call.input = input;
      else delete call.input;
    }
    // `content` is the tool's answer only once the call has finished. CodeBuddy
    // streams its raw JSON arguments through that same field on every partial
    // update, and taking the first of those painted a lone quote under "output"
    // and then kept the real answer out of the row for good.
    //
    // `rawOutput` is the other half of the same story: it is where an adapter
    // puts the tool's own result when it builds no content block. Codex reports
    // every `terminal_run` call that way, so a row that read only `content` sat
    // on its command forever with nothing under it.
    const answered = toolContentText(update.content) || toolResultText(update.rawOutput);
    const settled = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled';
    // The first real answer wins. A settled update can arrive after the bridge
    // has already written the run's own output, and its wrapper text is the same
    // answer in a worse shape; the drafts that used to poison this field are
    // excluded by requiring either a settled status or no arguments at all.
    if (answered && !call.output && (settled || update.rawInput === undefined)) {
      call.output = answered;
    }
    task.toolCalls.set(toolCallId, call);
    // The gate may have judged this call before the adapter described it.
    const verdict = this.verdicts.get(`${task.info.id}\u0000${toolCallId}`);
    if (verdict) this.applyVerdict(call, verdict);
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
  }

  /* ----------------------------------------------------------------- gate */

  private async handleRequestPermission(
    task: TaskRuntime,
    params: AcpRequestPermissionParams,
  ): Promise<AcpPermissionOutcome> {
    const toolCall = params.toolCall ?? {};
    const options = Array.isArray(params.options) && params.options.length > 0
      ? params.options
      : APPROVAL_OPTIONS;
    const allow = options.find((option) => option.kind === 'allow_once')
      ?? options.find((option) => option.kind === 'allow_always');
    const reject = options.find((option) => option.kind === 'reject_once')
      ?? options.find((option) => option.kind === 'reject_always');

    // Judge the command here when the call names one, wherever the adapter put it:
    // a plain tool puts `command` at the top level, Trae nests it in the MCP
    // arguments of `easyshell/terminal_run`. Judging it now means the card appears
    // while the agent is still waiting for permission, and the row names the
    // command before it runs; the bridge's own gate then reuses this answer.
    //
    // A call that names nothing is answered "allow" and grants nothing by that:
    // execution still has to pass the bridge or the `terminal/create` gate, which
    // is the only place that sees the real command line. Classifying a title like
    // "Tool: easyshell/terminal_run" would judge a string nobody will run.
    const target = toolCallTarget(toolCall.rawInput);
    if (!target.command) {
      return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow' } };
    }

    const result = await this.gate(task, {
      toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
      title: toolCall.title ?? '',
      command: target.command,
      cwd: undefined,
      terminal: this.knownTerminal(target.terminal),
    });

    // The adapter already reported this call; hand it the verdict so the row
    // stops reading "risk unknown" the moment the gate has an answer.
    this.rememberVerdict(
      task,
      typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
      result,
    );

    if (result.allowed) {
      // The one hand-off in the app: the answer covers the execution this same
      // call is about to ask for, and nothing else. Only this path writes it.
      if (result.sessionId) {
        this.cleared.set(commandKey(result.sessionId, target.command), {
          until: Date.now() + ALLOW_CACHE_MS,
          risk: result.risk,
          reason: result.reason,
        });
      }
      return {
        outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow' },
      };
    }
    if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }

  /**
   * Files the gate's answer under the tool call it belongs to.
   *
   * Adapters report their own tool calls with no risk attached, and they may do
   * it before or after asking for permission. Keeping the verdict lets the row
   * carry the classification and the block, whichever arrives first.
   */
  private rememberVerdict(task: TaskRuntime, toolCallId: string | undefined, result: GateResult): void {
    if (!toolCallId) return;
    const verdict: CommandVerdict = {
      risk: result.risk,
      reason: result.reason,
      allowed: result.allowed,
      sessionId: result.sessionId,
    };
    this.verdicts.set(`${task.info.id}\u0000${toolCallId}`, verdict);
    const call = task.toolCalls.get(toolCallId);
    if (!call) return;
    this.applyVerdict(call, verdict);
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
  }

  private applyVerdict(call: AgentToolCallInfo, verdict: CommandVerdict): void {
    call.risk = verdict.risk;
    if (verdict.reason) call.reason = verdict.reason;
    if (verdict.sessionId) call.sessionId = verdict.sessionId;
    // A blocked command never ran: the row has to say so instead of staying at
    // whatever status the adapter left behind.
    if (!verdict.allowed) call.status = 'blocked';
  }

  /**
   * Runs a command in one of the user's live terminals.
   *
   * The command is visible while it runs: the tab comes to the front, the
   * command line is written into the terminal, and output streams in as it
   * arrives. `SessionManager.runCommand()` owns that; this method owns the
   * paperwork the protocol expects 鈥?a terminal id, an output buffer with a
   * byte limit, an exit status, and a way to kill it.
   */
  private async terminalCreate(
    task: TaskRuntime,
    params: AcpTerminalCreateParams,
  ): Promise<{ terminalId: string }> {
    const requested = buildTerminalCommand(params, false);
    if (!requested) throw new AcpError('terminal/create without a command', -32602);

    const cwd = absoluteCwd(params.cwd);
    const result = await this.gate(task, {
      title: params.command ?? requested,
      command: requested,
      cwd,
      terminal: terminalHint(params),
    });
    if (!result.allowed || !result.sessionId) {
      throw new AcpError(`command not run: ${result.reason}`, RPC_BLOCKED, {
        risk: result.risk,
        command: requested,
      });
    }

    // `ssh` and `wsl` talk to a POSIX shell, so argv may be quoted. A local
    // session may be PowerShell, where a POSIX quote is literal text.
    const kind = this.options.sessions.get(result.sessionId)?.kind ?? 'local';
    const command = buildTerminalCommand(params, kind === 'ssh' || kind === 'wsl');

    const job: TerminalJob = {
      id: randomUUID(),
      taskId: task.info.id,
      sessionId: result.sessionId,
      command,
      output: '',
      exitCode: null,
      done: false,
      limit:
        typeof params.outputByteLimit === 'number' && params.outputByteLimit > 0
          ? params.outputByteLimit
          : 64_000,
      wake: null,
      killed: false,
      abort: new AbortController(),
    };
    this.jobs.set(job.id, job);
    task.info.commandCount += 1;
    this.emit({ type: 'agent-task', task: { ...task.info } });

    const runId = `run:${job.id}`;
    const call: AgentToolCallInfo = {
      id: runId,
      taskId: task.info.id,
      title: command.split('\n')[0]?.slice(0, 120) || command,
      kind: 'execute',
      status: 'in_progress',
      command,
      risk: result.risk,
      reason: result.reason,
      sessionId: result.sessionId,
      startedAt: Date.now(),
    };
    task.toolCalls.set(runId, call);
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });

    const timeoutMs = this.options.getSettings().agent.commandTimeoutMs;
    // Only a run that never produced an exit status is a failed call; a non-zero
    // code is the command's own answer and travels in `exitCode`.
    let crashed = false;
    void this.options.sessions
      .runCommand(result.sessionId, command, {
        timeoutMs,
        cwd,
        signal: job.abort.signal,
      })
      .then((exec) => {
        const parts = [exec.stdout, exec.stderr].filter((part) => part.trim().length > 0);
        job.output = parts.join('\n');
        if (exec.timedOut) job.output += `\n[timed out after ${timeoutMs} ms]`;
        job.exitCode = exec.code;
      })
      .catch((error: unknown) => {
        crashed = true;
        job.output = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        job.done = true;
        call.status = crashed || job.killed ? 'failed' : 'completed';
        call.exitCode = job.killed ? null : job.exitCode;
        call.output = job.output.slice(-4000);
        call.finishedAt = Date.now();
        this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
        job.wake?.();
      });

    return { terminalId: job.id };
  }

  private terminalOutput(params: AcpTerminalRef): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
  }> {
    const job = this.job(params.terminalId);
    if (!job) return Promise.reject(new AcpError('unknown terminal', -32602));
    const truncated = job.output.length > job.limit;
    const output = truncated ? job.output.slice(job.output.length - job.limit) : job.output;
    return Promise.resolve({
      output,
      truncated,
      exitStatus: job.done ? { exitCode: job.exitCode, signal: null } : null,
    });
  }

  private terminalWaitForExit(
    params: AcpTerminalRef,
  ): Promise<{ exitCode?: number | null; signal?: string | null }> {
    const job = this.job(params.terminalId);
    if (!job) return Promise.reject(new AcpError('unknown terminal', -32602));
    if (job.done) return Promise.resolve(exitStatusOf(job));
    return new Promise((resolve) => {
      job.wake = () => resolve(exitStatusOf(job));
    });
  }

  private terminalKill(params: AcpTerminalRef): Promise<null> {
    const job = this.job(params.terminalId);
    if (!job) return Promise.reject(new AcpError('unknown terminal', -32602));
    if (!job.done) {
      job.killed = true;
      job.abort.abort();
    }
    return Promise.resolve(null);
  }

  private terminalRelease(params: AcpTerminalRef): Promise<null> {
    const job = this.job(params.terminalId);
    if (job && !job.done) {
      // Releasing a terminal that is still running would leave a command with
      // nowhere to report to; kill it first.
      job.killed = true;
      job.abort.abort();
    }
    if (params.terminalId) this.jobs.delete(params.terminalId);
    return Promise.resolve(null);
  }

  private job(terminalId: string | undefined): TerminalJob | null {
    if (!terminalId) return null;
    return this.jobs.get(terminalId) ?? null;
  }

  /**
   * The gate, for a command that arrives over the MCP bridge.
   *
   * `terminal_run` is the route an agent is told to prefer, and the bridge
   * answers it on its own, so without this the permission mode would only cover
   * adapters that happen to use ACP terminals: the bridge was a way around the
   * gate. Returns the verdict and the sentence the tool result will carry.
   */
  async authorizeBridgeCommand(input: {
    taskId: string;
    command: string;
    sessionId: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    const task = this.taskForBridge(input.taskId);
    if (!task) return { allowed: false, reason: 'no running agent task for this bridge call' };

    const result = await this.gate(
      task,
      { title: input.command, command: input.command, terminal: input.sessionId },
      { record: false },
    );
    // Nothing is cleared here on purpose. The bridge is the only gate this
    // command passes, so writing a clearance would mean the *next* run of the
    // same line went through with no card at all - which is exactly the silent
    // write a user in manual mode is watching for. A clearance only ever travels
    // from a permission request to the execution that same call asks for.
    //
    // The adapter drew a row for this call before the bridge saw the command.
    this.attachToPendingCall(task, input, result);
    return { allowed: result.allowed, reason: result.reason };
  }

  /**
   * The end of a command that ran over the bridge.
   *
   * `terminal_run` answers the agent, not this app: the output goes back over
   * MCP, and an adapter that reports no tool result - Codex sends none through
   * ACP at all - leaves the row holding a command and nothing under it. The
   * bridge is the only party that holds the run, so it hands the ending over.
   */
  recordBridgeRun(input: {
    taskId: string;
    command: string;
    sessionId: string;
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }): void {
    const task = this.taskForBridge(input.taskId);
    if (!task) return;
    const rows = [...task.toolCalls.values()].reverse();
    // The row the adapter drew for this call names the command. A row of this
    // app's own (`run:`) belongs to an ACP terminal and is already complete.
    const call =
      rows.find((row) => row.command === input.command && !row.finishedAt && !row.id.startsWith('run:')) ??
      rows.find((row) => !row.command && /terminal_run/i.test(row.title));
    if (!call) return;
    call.command = input.command;
    call.sessionId = input.sessionId;
    call.status = input.timedOut ? 'failed' : 'completed';
    call.exitCode = input.code;
    const parts = [input.stdout, input.stderr].filter((part) => part.trim().length > 0);
    const output = parts.join('\n').trimEnd();
    if (output) call.output = output.slice(-4000);
    call.finishedAt = Date.now();
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
  }

  /**
   * Puts the real command on the row the adapter drew for `terminal_run`.
   *
   * Adapters that ask about the call with nothing but a title ("Tool:
   * easyshell/terminal_run") leave the row empty, and the approval card is then
   * the only place the command appears. Since the nested arguments are read, such
   * a row usually carries the command already and only lacks the verdict; both
   * shapes are matched here, so the row ends up naming the command, the terminal
   * it ran in, and the sentence the gate reached.
   */
  private attachToPendingCall(
    task: TaskRuntime,
    input: { command: string; sessionId: string },
    result: GateResult,
  ): void {
    const rows = [...task.toolCalls.values()].reverse();
    // A row that already names this command is the same call, unless something
    // else has tied it to a run. The titled-only row is the older shape.
    const call =
      rows.find((row) => !row.sessionId && row.command === input.command) ??
      rows.find((row) => !row.command && /terminal_run/i.test(row.title));
    if (!call) return;
    call.command = input.command;
    call.sessionId = input.sessionId;
    call.risk = result.risk;
    if (result.reason) call.reason = result.reason;
    if (!result.allowed) call.status = 'blocked';
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
  }

  /**
   * A terminal name only counts when it is one of ours.
   *
   * The arguments of a tool call can carry a `session_id` that means something
   * else entirely - some other server's idea of a session. Handing that to the
   * gate would make it refuse the command because "the terminal is gone", a
   * refusal about the wrong thing. An unknown name is dropped instead, so the gate
   * falls back to the terminal in front, exactly as it does for a call that names
   * none.
   */
  private knownTerminal(name: string | undefined): string | undefined {
    if (!name) return undefined;
    return matchSession(this.options.sessions.list(), name) ? name : undefined;
  }

  /**
   * The task a bridge call belongs to.
   *
   * The id travels in the MCP server's environment. A session started before
   * that existed carries none, and then exactly one task can be waiting on the
   * bridge; anything more is ambiguous, and ambiguous is a refusal, not a guess.
   */
  private taskForBridge(taskId: string): TaskRuntime | null {
    const named = this.tasks.get(taskId);
    if (named?.connection) return named;
    const live = [...this.tasks.values()].filter((task) => task.connection);
    return live.length === 1 ? (live[0] ?? null) : null;
  }

  /**
   * The single checkpoint between an agent and a machine.
   *
   * `input` carries everything the gate needs to judge one command: which
   * tool call it belongs to, what it says, where the agent named it, and which
   * terminal it is aimed at.
   */
  private async gate(
    task: TaskRuntime,
    input: {
      toolCallId?: string;
      title: string;
      command: string;
      cwd?: string;
      terminal?: string;
    },
    /**
     * `record: false` keeps a blocked call out of the transcript. A bridge call
     * has no adapter-reported row to attach it to, and the agent's own UI draws
     * the one row that belongs there.
     */
    options: { record?: boolean } = {},
  ): Promise<GateResult> {
    const settings = this.options.getSettings();
    const mode = settings.agent.permissionMode;
    const target = this.resolveTarget(input.cwd, input.terminal);
    const label = target.label;
    const command = input.command.trim();

    if (!target.sessionId) {
      return {
        allowed: false,
        risk: 'unknown',
        reason: this.say('agent.gate.noTerminal'),
        sessionId: null,
        label,
      };
    }
    if (!command) {
      return {
        allowed: false,
        risk: 'unknown',
        reason: this.say('agent.gate.noCommand'),
        sessionId: target.sessionId,
        label,
      };
    }

    // A command the user already cleared repeats the verdict they cleared,
    // sentence included. The mode still has the last word: narrowing it to
    // read-only revokes a clearance made under a looser one.
    const key = commandKey(target.sessionId, command);
    const remembered = this.cleared.get(key);
    const reuse = remembered && remembered.until > Date.now() ? remembered : null;
    if (remembered) this.cleared.delete(key);

    let risk: AgentRiskState = reuse?.risk ?? 'unknown';
    let reason = reuse?.reason ?? '';
    if (!reuse && mode !== 'unrestricted') {
      const verdict = await this.classifier.classify(command, label);
      risk = verdict.risk;
      reason = verdict.reason;
    }

    const action = decideAgentAction(mode, risk);
    // A cleared command runs again without a second question — that is what the
    // window is for — unless the mode was narrowed past what it was cleared under.
    if (action === 'allow' || (reuse && action !== 'deny')) {
      return { allowed: true, risk, reason, sessionId: target.sessionId, label };
    }
    if (action === 'deny') {
      // The row reads "blocked": the classifier's sentence is the reason, and the
      // mode is the fallback when there was no judgement to quote — nothing to
      // classify, or a classifier that degraded to its bare token.
      const judged = reason && reason !== CONSERVATIVE_VERDICT.reason ? reason : '';
      const why = judged || this.say('agent.gate.readOnly');
      if (options.record !== false) {
        this.recordBlocked(task, input, risk, why, target.sessionId);
      }
      this.emit({
        type: 'agent-notice',
        notice: { level: 'warn', key: 'agent.notice.blocked', params: { risk } },
      });
      return { allowed: false, risk, reason: why, sessionId: target.sessionId, label };
    }

    const allowed = await this.askUser(task, input, risk, reason, target, mode);
    return {
      allowed,
      risk,
      reason: allowed ? reason : this.say('agent.gate.denied'),
      sessionId: target.sessionId,
      label,
    };
  }

  /** A sentence the app writes itself, in the language the interface shows. */
  private say(key: string, params?: Record<string, string | number>): string {
    return translate(this.options.getLocale?.() ?? 'en', key, params);
  }

  private recordBlocked(
    task: TaskRuntime,
    input: { toolCallId?: string; title: string; command: string },
    risk: AgentRiskState,
    reason: string,
    sessionId: string,
  ): void {
    const id = input.toolCallId ?? `blocked:${randomUUID()}`;
    const call: AgentToolCallInfo = {
      id,
      taskId: task.info.id,
      title: input.title || input.command,
      kind: 'execute',
      status: 'blocked',
      command: input.command,
      risk,
      reason,
      sessionId,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    task.toolCalls.set(id, call);
    this.emit({ type: 'agent-tool-call', toolCall: { ...call } });
  }

  /** One dialog per command line, even if two paths ask about it at once. */
  private askUser(
    task: TaskRuntime,
    input: { toolCallId?: string; title: string; command: string; cwd?: string },
    risk: AgentRiskState,
    reason: string,
    target: { sessionId: string | null; label: string },
    mode: AgentPermissionMode,
  ): Promise<boolean> {
    const key = commandKey(target.sessionId ?? '', input.command);
    const pending = this.pendingByCommand.get(key);
    if (pending) return pending;

    const request: AgentApprovalRequest = {
      id: randomUUID(),
      taskId: task.info.id,
      toolCallId: input.toolCallId ?? '',
      title: input.title || input.command,
      command: input.command,
      cwd: input.cwd,
      sessionId: target.sessionId ?? undefined,
      sessionLabel: target.label,
      risk,
      reason,
      mode,
      createdAt: Date.now(),
      options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
    };
    this.setStatus(task, 'waiting');

    const promise = new Promise<boolean>((resolve) => {
      this.approvals.set(request.id, {
        request,
        settle: (optionId) => {
          this.pendingByCommand.delete(key);
          this.approvals.delete(request.id);
          this.setStatus(task, 'running');
          resolve(optionId !== null && optionId.startsWith('allow'));
        },
      });
      this.emit({ type: 'agent-approval', request });
    });
    this.pendingByCommand.set(key, promise);
    return promise;
  }

  /**
   * Which terminal a command runs in.
   *
   * Three ways to name one, most explicit first: `_meta.easyshell.terminal`, the
   * `easyshell://<id>` convention an adapter may forward verbatim as `cwd`, and
   * finally "the terminal in front". A plain absolute `cwd` is not a terminal
   * name at all 鈥?it is a directory inside whichever terminal wins.
   *
   * A name that matches nothing never falls back: running an agent's command on
   * a machine it did not ask for is worse than telling it the terminal is gone.
   */
  private resolveTarget(cwd?: string, terminal?: string): { sessionId: string | null; label: string } {
    const sessions = this.options.sessions.list();
    const named = terminal ?? terminalFromCwd(cwd);
    const match = named ? matchSession(sessions, named) : null;
    if (match) return { sessionId: match.id, label: this.labelOf(match.id) };
    if (named) return { sessionId: null, label: named };
    if (this.focusedSessionId && sessions.some((session) => session.id === this.focusedSessionId)) {
      return { sessionId: this.focusedSessionId, label: this.labelOf(this.focusedSessionId) };
    }
    if (sessions.length === 1) {
      const only = sessions[0]!;
      return { sessionId: only.id, label: this.labelOf(only.id) };
    }
    return { sessionId: null, label: '' };
  }

  private labelOf(sessionId: string): string {
    const session = this.options.sessions.list().find((item) => item.id === sessionId);
    if (!session) return sessionId;
    return `${session.metadata.endpoint.displayName} (${session.kind})`;
  }

  /* --------------------------------------------------------------- helpers */

  /**
   * A clock that never repeats inside one task.
   *
   * The transcript is ordered by these stamps, and a replay delivers a whole
   * conversation within a couple of milliseconds: with a plain `Date.now()` a
   * message and the command that followed it share a millisecond, and the sort
   * has no way to put them back in the order they happened. A burst pushes the
   * stamp a few ms ahead; real time catches up by itself.
   */
  private stamp(task: TaskRuntime): number {
    const now = Date.now();
    task.lastStamp = task.lastStamp >= now ? task.lastStamp + 1 : now;
    return task.lastStamp;
  }

  private pushMessage(
    task: TaskRuntime,
    role: 'user' | 'agent' | 'thought' | 'system',
    text: string,
    streaming = false,
  ): AgentTranscript['messages'][number] {
    task.messageSeq += 1;
    const message = {
      id: `m${task.messageSeq}`,
      taskId: task.info.id,
      role,
      // A replayed user turn arrives with the context block the host wrapped
      // the prompt in; the transcript shows what was typed. A block still in
      // flight comes back empty, and `appendStream` fills the message in once
      // the block closes 鈥?an empty user row is dropped by the panel.
      text: role === 'user' ? stripPromptContext(text) : text,
      at: this.stamp(task),
      streaming: streaming || undefined,
    };
    task.messages.push(message);
    this.emit({ type: 'agent-message', message: { ...message } });
    return message;
  }

  private setStatus(task: TaskRuntime, status: AgentTaskInfo['status']): void {
    task.info.status = status;
    task.info.updatedAt = Date.now();
    this.emit({ type: 'agent-task', task: { ...task.info } });
  }

  private emit(event: AgentEvent): void {
    this.options.emit(event);
  }
}

/** JSON-RPC code used when the gate refuses a command. */
const RPC_BLOCKED = -32001;

const PROMPT_CONTEXT_START = '<easyshell_context>';
const PROMPT_CONTEXT_END = '</easyshell_context>';

/**
 * What an agent replays as a user turn is the prompt the host sent it: the
 * context block, then the user's own words. The transcript shows what was
 * typed, so the block is cut out of it.
 *
 * The cut is anchored on the closing tag rather than the opening one, because a
 * replay arrives in chunks and a transport that splits a long prompt can hand
 * the block's tail over without its head. Anchoring on the start tag would then
 * leave either half a block on screen or - the case this exists for - the
 * instructions the user never wrote. Both halves are dropped wherever they
 * arrive, and a block still in flight is hidden instead of shown half-written:
 * what comes back is only ever what the user actually said.
 */
function stripPromptContext(text: string): string {
  const end = text.lastIndexOf(PROMPT_CONTEXT_END);
  if (end >= 0) return text.slice(end + PROMPT_CONTEXT_END.length).trim();
  const start = text.indexOf(PROMPT_CONTEXT_START);
  if (start >= 0) return text.slice(0, start).trim();
  return text;
}

function textOf(update: AcpSessionUpdate): string {
  const content = update.content as { type?: string; text?: unknown } | undefined;
  if (content && content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

/** How much of a tool's arguments a row keeps. Enough to read, short enough to hold. */
const MAX_TOOL_INPUT_CHARS = 2_000;

/**
 * The arguments of a call that runs no command, as text.
 *
 * Every adapter sends them as free-form JSON and every tool shapes them
 * differently, so the only honest rendering is the JSON itself: indented when it
 * is a record, and cut when it is enormous.
 */
function toolInputText(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return '';
  let text = '';
  if (typeof rawInput === 'string') {
    text = rawInput.trim();
  } else if (typeof rawInput === 'object') {
    // An empty record is an agent saying nothing; no details block for that.
    if (Object.keys(rawInput as Record<string, unknown>).length === 0) return '';
    try {
      text = JSON.stringify(rawInput, null, 2);
    } catch {
      return '';
    }
  } else {
    text = String(rawInput);
  }
  if (text.length <= MAX_TOOL_INPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_INPUT_CHARS)}\n…`;
}

/**
 * The text a tool call reported back.
 *
 * ACP carries each result in `content`, either a bare content block or a block
 * wrapping one. Only text is kept: a diff or a terminal id is drawn by the agent
 * itself, or is already a row of its own here.
 */
function toolContentText(content: unknown): string {
  const parts: string[] = [];
  const collect = (block: unknown): void => {
    if (!block || typeof block !== 'object') return;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      if (record.text.trim()) parts.push(record.text);
      return;
    }
    if (record.content !== undefined) collect(record.content);
  };
  if (Array.isArray(content)) {
    for (const item of content) collect(item);
  } else {
    collect(content);
  }
  return parts.join('\n').slice(-4000);
}

/**
 * The text a tool call put in `rawOutput`.
 *
 * Adapters that build no content block report the tool's own result here, in
 * whatever shape the tool chose: Codex wraps an MCP answer as `{result, error}`,
 * and our bridge answers with `{content: [{type: 'text', text}]}` inside that.
 * None of those is a block this app can draw, so the text is dug out here once.
 */
function toolResultText(raw: unknown): string {
  return resultTextOf(raw, 0).slice(-4000);
}

function resultTextOf(value: unknown, depth: number): string {
  // Deep enough for an adapter's wrapper around a tool's answer, shallow enough
  // that a tool echoing its own input cannot spin here.
  if (value === undefined || value === null || depth > 4) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => resultTextOf(item, depth + 1)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  // Codex's wrapper around an MCP tool's answer: exactly one of the two is set.
  const error = resultTextOf(record.error, depth + 1);
  if (error) return error;
  const result = resultTextOf(record.result, depth + 1);
  if (result) return result;
  // A run, described the way the bridge describes one.
  const stdout = typeof record.stdout === 'string' ? record.stdout.trimEnd() : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr.trimEnd() : '';
  if (stdout.trim() || stderr.trim()) {
    return [stdout, stderr].filter((part) => part.trim()).join('\n');
  }
  // A content block, bare or wrapping one.
  if (typeof record.text === 'string') return record.text.trim();
  if (record.content !== undefined) return resultTextOf(record.content, depth + 1);
  return '';
}

function normalizeToolStatus(status: string): AgentToolCallStatus {
  switch (status) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'failed':
      return status;
    default:
      return 'in_progress';
  }
}

/** The URI convention an adapter may forward verbatim in `cwd`. */
const TERMINAL_URI = 'easyshell://';

/**
 * The terminal the agent named through ACP's extension slot.
 *
 * `_meta` is the only place the protocol reserves for information an
 * implementation adds, so this is where a terminal name belongs. `cwd` keeps
 * meaning what the schema says it means.
 */
function terminalHint(params: AcpTerminalCreateParams): string | undefined {
  const meta = params._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const easyshell = (meta as Record<string, unknown>).easyshell;
  if (!easyshell || typeof easyshell !== 'object') return undefined;
  const terminal = (easyshell as Record<string, unknown>).terminal;
  return typeof terminal === 'string' && terminal.trim() ? terminal.trim() : undefined;
}

/** A terminal named the old way, `cwd: "easyshell://<id>"`, or nothing. */
function terminalFromCwd(cwd: unknown): string | undefined {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw.startsWith(TERMINAL_URI)) return undefined;
  const rest = raw.slice(TERMINAL_URI.length);
  return rest.split('/')[0] || raw;
}

/**
 * A `cwd` the host may act on.
 *
 * Absolute only: a relative one would mean whatever the shell happened to be
 * doing, which is the ambiguity the field exists to remove. The URI convention
 * is not a directory and never becomes one.
 */
function absoluteCwd(cwd: unknown): string | undefined {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw || raw.startsWith(TERMINAL_URI)) return undefined;
  const absolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw);
  return absolute ? raw : undefined;
}

/** `env` as the protocol writes it, whichever shape it arrived in. */
function environmentOf(env: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(env)) {
    return env.filter(
      (item): item is { name: string; value: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { value?: unknown }).value === 'string',
    );
  }
  if (env && typeof env === 'object') {
    return Object.entries(env as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => ({ name, value }));
  }
  return [];
}

/**
 * Turns `command` + `args` + `env` into one command line.
 *
 * `args` are argv, not shell text: each one is quoted, so an argument with a
 * space stays a single argument. Quoting is skipped when the shell is not
 * known to be POSIX 鈥?a POSIX quote handed to PowerShell is part of the value.
 * `env` becomes an `env` invocation rather than a `K=V` prefix, because a
 * prefix binds to the first command of a pipeline only.
 */
function buildTerminalCommand(params: AcpTerminalCreateParams, posix: boolean): string {
  const program = typeof params.command === 'string' ? params.command.trim() : '';
  const args = (Array.isArray(params.args) ? params.args : []).filter(
    (arg): arg is string => typeof arg === 'string',
  );
  const body = [program, ...args.map((arg) => (posix ? posixQuote(arg) : arg))]
    .filter(Boolean)
    .join(' ')
    .trim();
  const env = environmentOf(params.env);
  if (!body || !posix || env.length === 0) return body;
  const assignments = env.map((entry) => `${entry.name}=${posixQuote(entry.value)}`);
  return `env ${assignments.join(' ')} ${body}`;
}

function exitStatusOf(job: TerminalJob): { exitCode: number | null; signal: string | null } {
  return job.killed ? { exitCode: null, signal: 'SIGKILL' } : { exitCode: job.exitCode, signal: null };
}
