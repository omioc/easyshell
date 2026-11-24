/**
 * Shared contract between the Electron main process (session host), the preload
 * bridge, the renderer UI and the local control API.
 *
 * Everything an agent or an external tool can observe about a session lives here.
 */

// Type-only, and one-directional at runtime: `agents.ts` owns the catalog data,
// this file owns the shapes everything else passes around.
import type { AgentCliDetection } from './agents';

export type Locale = 'zh' | 'en';
export type ThemeMode = 'system' | 'light' | 'dark';
export type PlatformOs = 'win32' | 'darwin' | 'linux';

/* ------------------------------------------------------------------ sessions */

export type SessionKind = 'local' | 'wsl' | 'ssh';
export type SessionStatus = 'connecting' | 'connected' | 'exited' | 'error';

export type HostKeyPolicy = 'accept-new' | 'strict' | 'insecure';

export type SshAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyPath: string; passphrase?: string }
  | { type: 'agent' }
  | { type: 'none' };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  hostKeyPolicy: HostKeyPolicy;
}

/** How a session came into existence. Used by the UI and by the audit trail. */
export type SessionOrigin =
  | { type: 'ui' }
  | { type: 'cli'; raw: string; via: 'newtab' | 'xshell' | 'url' | 'native' }
  | { type: 'api' };

export interface SessionSpecLocal {
  kind: 'local';
  profileId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SessionSpecWsl {
  kind: 'wsl';
  distribution: string;
  cwd?: string;
}

export interface SessionSpecSsh {
  kind: 'ssh';
  target: SshTarget;
}

export type SessionSpecBody = SessionSpecLocal | SessionSpecWsl | SessionSpecSsh;

export type SessionSpec = SessionSpecBody & {
  /** Tab title override. Falls back to the endpoint display name. */
  title?: string;
  /** Run once the session is up (used by bastion invocations and the API). */
  initialCommand?: string;
  origin?: SessionOrigin;
};

/**
 * What came back from asking a host to open a connection and closing it again.
 * The editor's "test" button reads this and nothing else: no session, no tab.
 */
export type ConnectionTestResult = { ok: true } | { ok: false; error: string };

/* ---------------------------------------------------------------- metadata */

/**
 * One hop in the session's location chain. The first hop is the machine the
 * session was opened on; later hops are detected nested logins (`ssh inner-host`
 * typed inside the session).
 */
export interface SessionHop {
  label: string;
  /**
   * The address this hop is reached at (`198.18.0.5`, or the name typed into
   * `ssh`). A title or a prompt may reveal the name the machine calls itself,
   * but that name never replaces the address. A hop that was dialed by name
   * gets the address the machine reports about itself once the probe or the
   * login banner learns it; the name then stays in `hostname`.
   */
  host?: string;
  /** The name the machine uses for itself (`hostname`, OSC title, prompt). */
  hostname?: string;
  username?: string;
  port?: number;
  /**
   * The hop stays on the same machine and only changes the user (`su`,
   * `sudo -i`). Address, port and everything the probe learned still apply.
   */
  sameHost?: boolean;
  /** What made us believe this hop exists. */
  detectedBy: 'session' | 'osc-title' | 'command-line' | 'prompt' | 'probe';
  confidence: 'high' | 'medium' | 'low';
  at: number;
}

export interface SessionEndpoint {
  kind: SessionKind;
  /** Effective display name: `root@198.18.0.5`, `Ubuntu`, `PowerShell`. */
  displayName: string;
  host?: string;
  port?: number;
  username?: string;
  distribution?: string;
  /** Where the current top-of-chain information came from. */
  source: 'session' | 'probe' | 'nested' | 'osc-title';
  /** Name the current machine uses for itself, when something revealed it. */
  hostname?: string;
  chain: SessionHop[];
}

export interface OsInfo {
  hostname?: string;
  fqdn?: string;
  os?: string;
  osVersion?: string;
  kernel?: string;
  arch?: string;
  user?: string;
  shell?: string;
  uptimeSeconds?: number;
  ips?: string[];
  cpuCount?: number;
  memoryMb?: number;
  timezone?: string;
  probedAt?: number;
  probeError?: string;
}

export interface SessionMetadata {
  endpoint: SessionEndpoint;
  os: OsInfo;
  /** Free-form strings a probe or an agent wants to keep on the session. */
  extra: Record<string, string>;
  updatedAt: number;
}

export interface ProbeState {
  enabled: boolean;
  intervalMs: number;
  lastAt?: number;
  lastError?: string;
  /** `exec-channel` for ssh, `child` for local/wsl, `shell` for a probe typed into the shell. */
  channel?: 'exec-channel' | 'child' | 'shell';
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  title: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  cols: number;
  rows: number;
  exitCode?: number | null;
  origin: SessionOrigin;
  metadata: SessionMetadata;
  probe: ProbeState;
  /**
   * The directory the interactive shell is in, when it can be known: the shell
   * reports it (OSC 7 / OSC 9;9) or answers a `pwd` typed at its prompt. The
   * file sheet starts here, which is what makes it follow the terminal.
   */
  cwd?: string;
  /** Clients currently attached through the control API. */
  attachedClients: number;
  /** Bytes currently buffered for late attach. */
  bufferBytes: number;
}

/* -------------------------------------------------------------------- files */

/**
 * One row of the file sheet.
 *
 * `path` is absolute and already joined with the target's own separator, so the
 * renderer never has to know whether it is talking to a POSIX host, a Windows
 * box or a WSL distribution.
 */
export interface SftpEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modifiedAt: number | null;
  symlink?: boolean;
  /** Permission bits, when the target reports them. */
  mode?: number;
}

export interface SftpListing {
  path: string;
  /** `null` at the root of the tree: the up action has nowhere to go. */
  parent: string | null;
  entries: SftpEntry[];
}

export type FilePathStyle = 'posix' | 'win32';

/**
 * Where a session's file tree starts, and what it belongs to.
 *
 * The tree always belongs to the machine the session was opened on. A nested
 * login inside the tab cannot be reached over the file channel (it is another
 * SSH connection the app does not own), so `nested` says so and `canFollow` is
 * false: the panel keeps showing the original host instead of pretending to
 * follow a machine it cannot see.
 */
export interface SftpOrigin {
  kind: SessionKind;
  /** The machine the files live on, e.g. `root@198.18.0.5`. */
  label: string;
  style: FilePathStyle;
  /** Topmost reachable directory: `/`, or the drive root on Windows. */
  root: string;
  home: string;
  /** The terminal's current directory, when the shell reports one. */
  cwd: string | null;
  canFollow: boolean;
  nested: boolean;
}

export interface SftpTransfer {
  id: string;
  sessionId: string;
  direction: 'upload' | 'download';
  /** File or folder name being copied. */
  name: string;
  /** Destination display path. */
  target: string;
  bytes: number;
  /** `null` while the size is still unknown. */
  total: number | null;
  done: boolean;
  error?: string;
}

export type SftpEvent =
  | { type: 'sftp-transfer'; transfer: SftpTransfer }
  | { type: 'sftp-notice'; notice: NoticePayload };

/* ----------------------------------------------------------------- settings */

export interface ShellProfile {
  id: string;
  label: string;
  kind: 'local';
  command: string;
  args: string[];
}

/**
 * What a session learned about the machine a saved connection points at.
 *
 * `linux` is false only when the host named itself as something else outright.
 * A host that could not be identified carries no facts at all, so its row keeps
 * the plain terminal tile instead of claiming to be Linux.
 */
export interface SshHostFacts {
  /** The host answered as Linux. */
  linux: boolean;
  /** Distribution the host printed, e.g. `Ubuntu`, `Rocky Linux`. */
  distribution?: string;
  /** When these facts were last confirmed. */
  at: number;
}

/**
 * A saved SSH connection.
 *
 * Secrets live in `settings.json` in the user's profile directory, in plain
 * text. That is deliberate for a local tool; the UI says so where the field is
 * edited, and nothing is ever sent anywhere except to the SSH server itself.
 */
export interface SshProfile {
  id: string;
  /** Tab title and list label. */
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key' | 'agent';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Optional per-profile host key policy override. */
  hostKeyPolicy?: HostKeyPolicy;
  notes?: string;

  /**
   * What the last session on this machine reported about itself.
   *
   * Written by the main process whenever a probe or a login banner identifies the
   * host, so the sidebar can draw the right tile before the next connection
   * exists. Refreshed on every new session: the same address can come back as a
   * different system after a reinstall.
   */
  detected?: SshHostFacts;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  colorScheme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Extra px per cell on top of the font's own advance; xterm rounds it. */
  letterSpacing: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
}

export interface ProbeSettings {
  enabled: boolean;
  intervalMs: number;
  /** Detect nested logins from typed commands and terminal titles. */
  nestedDetection: boolean;
}

export interface ApiSettings {
  enabled: boolean;
  host: '127.0.0.1';
  port: number;
  token: string;
}

/**
 * Identity metadata. This is what makes the app adressable by bastion portals
 * that only whitelist known SSH clients (MobaXterm, Xshell, ...).
 */
export interface IdentityMetadata {
  /** Executable / bundle name, e.g. `MobaXterm`. */
  alias: string;
  companyName: string;
  productName: string;
  fileDescription: string;
  internalName: string;
  originalFilename: string;
  legalCopyright: string;
  fileVersion: string;
  productVersion: string;
  macBundleIdentifier: string;
  macBundleName: string;
  linuxProcessName: string;
  /** Where the last applied artifact landed. */
  lastAppliedPath?: string;
  lastAppliedAt?: number;
}

/**
 * A named group of saved SSH connections. Workspaces are the second level of
 * the sidebar: the flat session list stays temporary, while a workspace keeps
 * the hosts you return to.
 */
export interface WorkspaceGroup {
  id: string;
  name: string;
  /** Saved SSH profile ids, in display order. */
  profileIds: string[];
}

export interface Settings {
  version: number;
  locale: 'auto' | Locale;
  appearance: AppearanceSettings;
  shell: {
    profiles: ShellProfile[];
    defaultProfileId: string;
    wslDefaultDistribution?: string;
  };
  ssh: {
    defaultPort: number;
    hostKeyPolicy: HostKeyPolicy;
    keepAliveSeconds: number;
    /** Saved connections, most recently used first is not enforced here. */
    profiles: SshProfile[];
  };
  /** Sidebar groups of saved connections. Empty until the user makes one. */
  workspaces: WorkspaceGroup[];
  probe: ProbeSettings;
  api: ApiSettings;
  identity: IdentityMetadata;
  agent: AgentSettings;
  /** Window chrome state that the user expects to survive a restart. */
  layout: {
    sidebarCollapsed: boolean;
    /**
     * Order of the sidebar's Sessions list, as entry keys: `local:<profileId>`,
     * `wsl:<distribution>`, `ssh:<profileId>`. Keys the list does not name keep
     * their natural order after the ones it does, so a new entry lands at the
     * bottom instead of jumping into a dragged list.
     */
    sessionOrder: string[];
  };
  window: { width: number; height: number; x?: number; y?: number; maximized?: boolean };
}

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/* ---------------------------------------------------------------- app shell */

export interface PlatformInfo {
  os: PlatformOs;
  arch: string;
  isPackaged: boolean;
  appVersion: string;
  electron: string;
  node: string;
  hostname: string;
  username: string;
  homeDir: string;
  /** Effective UI locale after `auto` resolution. */
  locale: Locale;
  /** Executable that bastions should point at. */
  launchPath: string;
}

export interface ApiEndpointInfo {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  baseUrl: string;
}

export interface BootstrapPayload {
  settings: Settings;
  /** Whether this machine seals saved passwords with the OS key store. */
  secrets: { encrypted: boolean };
  sessions: SessionInfo[];
  platform: PlatformInfo;
  api: ApiEndpointInfo;
  wslDistributions: string[];
  /** Sessions requested by CLI arguments of this launch. */
  pendingSpecs: SessionSpec[];
  /** Agent tasks, oldest first. */
  agentTasks: AgentTaskInfo[];
}

/* ------------------------------------------------------------------- events */

export interface NoticePayload {
  level: 'info' | 'warn' | 'error';
  /** i18n key; the renderer resolves it, main never ships display copy. */
  key: string;
  params?: Record<string, string | number>;
}

export type SessionEvent =
  | { type: 'session-created'; session: SessionInfo }
  | { type: 'session-updated'; session: SessionInfo }
  | { type: 'session-output'; id: string; data: string }
  /**
   * Brings one terminal to the front.
   *
   * The agent runs commands *inside* the user's own tabs, so a command nobody
   * is looking at is a command nobody can check. Emitted right before an agent
   * command starts; the app answers by switching the visible tab.
   */
  | { type: 'session-focus'; id: string }
  | { type: 'session-title'; id: string; title: string }
  | { type: 'session-metadata'; id: string; metadata: SessionMetadata }
  | { type: 'session-closed'; id: string; code: number | null }
  | { type: 'settings-updated'; settings: Settings }
  | { type: 'notice'; notice: NoticePayload };

/* ------------------------------------------------------------------ requests */

export interface CreateSessionRequest {
  spec: SessionSpec;
}

export interface ApplyIdentityResult {
  ok: boolean;
  /** Absolute path of the produced artifact (spoofed exe / app bundle / symlink). */
  path?: string;
  /** i18n key describing the outcome. */
  messageKey: string;
  params?: Record<string, string | number>;
  /** The artifact exists but is not directly launchable (dev mode). */
  portable?: boolean;
}

export interface AttachSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/* -------------------------------------------------------------------- agent */

/**
 * How much rope the agent gets.
 *
 * The app never judges a command itself: it hands the command line to the
 * connected agent CLI (a dedicated classification session) and maps the verdict
 * onto one of these four modes.
 */
export type AgentPermissionMode = 'read-only' | 'ask' | 'auto' | 'unrestricted';

/** The only three verdicts a classifier may return. */
export type AgentCommandRisk = 'read' | 'write' | 'destructive';

/** A verdict, or `unknown` while nothing has been classified yet. */
export type AgentRiskState = AgentCommandRisk | 'unknown';

export interface AgentRiskVerdict {
  risk: AgentCommandRisk;
  reason: string;
  /** The classifier could not be asked or could not be read: treat it as destructive. */
  degraded: boolean;
}

export interface AgentSettings {
  /**
   * The ACP agent CLI, e.g. `claude-agent-acp` or `opencode acp`.
   *
   * Connection settings only: the working directory belongs to a task, not to
   * the agent installation, so it is picked when a task is created.
   */
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  permissionMode: AgentPermissionMode;
  /** Upper bound for one command the agent runs. */
  commandTimeoutMs: number;
  /** Upper bound for one classification prompt; past it the verdict degrades. */
  classifyTimeoutMs: number;
  /** Lines of the focused terminal that ride along with every turn. */
  contextTailLines: number;
}

export type AgentTaskStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'error' | 'closed';

/**
 * Where a task's agent process works.
 *
 * `temp` is the app's own scratch directory: no project context, nothing worth
 * keeping. `project` is a directory the user picked for this task, which is what
 * an agent that reads `AGENTS.md` or resolves relative paths needs.
 */
export type AgentTaskMode = 'temp' | 'project';

export interface AgentTaskOptions {
  mode?: AgentTaskMode;
  /** Only meaningful for `project`; must be an absolute path. */
  cwd?: string;
}

export interface AgentTaskInfo {
  id: string;
  title: string;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** The ACP session id, once the agent accepted `session/new` or `session/load`. */
  acpSessionId?: string;
  /** Agent name reported by `initialize`, e.g. `claude-code-acp`. */
  agentName?: string;
  error?: string;
  /** Commands the gate has let through on this task. */
  commandCount: number;
  mode: AgentTaskMode;
  /** Working directory of the agent process for this task. */
  cwd: string;
  /**
   * Restored from disk after a restart: the record is back but the agent has not
   * been asked to load its session yet, so `acpSessionId` is stale until resumed.
   */
  restored?: boolean;
}

export type AgentToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface AgentToolCallInfo {
  /** The ACP `toolCallId`, or `run:<terminalId>` for a command the gate executed. */
  id: string;
  taskId: string;
  title: string;
  /** ACP tool kind: `execute`, `read`, `edit`, ... */
  kind: string;
  status: AgentToolCallStatus;
  command?: string;
  cwd?: string;
  risk: AgentRiskState;
  reason?: string;
  /**
   * The arguments a call that runs no command was given, as text.
   *
   * A tool the agent calls inside itself (a search, a file read) has no command
   * line for the classifier to judge, so its arguments and its result are the
   * only things worth showing behind "details".
   */
  input?: string;
  /** Terminal session the command was routed into. */
  sessionId?: string;
  exitCode?: number | null;
  output?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface AgentMessage {
  id: string;
  taskId: string;
  /** `thought` is the agent's reasoning stream: shown collapsed. */
  role: 'user' | 'agent' | 'thought' | 'system';
  text: string;
  at: number;
  /** True while more chunks may still arrive for this same message id. */
  streaming?: boolean;
}

export interface AgentApprovalOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/**
 * One command waiting for the user.
 *
 * The card has to answer the only questions that matter before a shell command
 * runs: what exactly runs, on which machine, and why the classifier flagged it.
 */
export interface AgentApprovalRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  title: string;
  command?: string;
  cwd?: string;
  sessionId?: string;
  /** Endpoint label of the target terminal, for the "where" line. */
  sessionLabel?: string;
  risk: AgentRiskState;
  reason?: string;
  mode: AgentPermissionMode;
  createdAt: number;
  options: AgentApprovalOption[];
}

export interface AgentTranscript {
  messages: AgentMessage[];
  toolCalls: AgentToolCallInfo[];
}

export type AgentEvent =
  | { type: 'agent-task'; task: AgentTaskInfo }
  | { type: 'agent-task-removed'; taskId: string }
  | { type: 'agent-message'; message: AgentMessage }
  | { type: 'agent-tool-call'; toolCall: AgentToolCallInfo }
  | { type: 'agent-approval'; request: AgentApprovalRequest }
  | { type: 'agent-approval-resolved'; taskId: string; requestId: string; allowed: boolean }
  | { type: 'agent-notice'; notice: NoticePayload };

export interface WindowBridgeState {
  maximized: boolean;
  fullscreen: boolean;
  platform: PlatformOs;
}

/** Injected by the preload script as `window.easyshell`. */
export interface EasyShellBridge {
  bootstrap(): Promise<BootstrapPayload>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo | null>;
  createSession(spec: SessionSpec): Promise<SessionInfo>;
  closeSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  writeSession(id: string, data: string): Promise<void>;
  resizeSession(id: string, cols: number, rows: number): Promise<void>;
  attachSession(id: string): Promise<AttachSnapshot>;
  detachSession(id: string): Promise<void>;
  probeSession(id: string): Promise<SessionMetadata>;
  execInSession(id: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  /**
   * Opens a connection to the host, then hangs up. Nothing is saved and no tab
   * is created - it answers one question: would this host let us in?
   */
  testConnection(spec: SessionSpecSsh): Promise<ConnectionTestResult>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  applyIdentity(): Promise<ApplyIdentityResult>;
  revealIdentity(): Promise<void>;
  listWslDistributions(): Promise<string[]>;
  /** Native open dialog filtered to private keys; null when cancelled. */
  pickPrivateKeyFile(): Promise<string | null>;
  /** Native directory picker for a project task; null when cancelled. */
  pickProjectDirectory(): Promise<string | null>;
  /**
   * The system clipboard as text. The terminal's right-click paste reads it
   * here: `navigator.clipboard` needs a permission grant the renderer does not
   * ask for, and a paste that silently does nothing is worse than no paste.
   */
  readClipboardText(): Promise<string>;

  getWindowState(): Promise<WindowBridgeState>;
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<boolean>;
  windowClose(): Promise<void>;

  listAgentTasks(): Promise<AgentTaskInfo[]>;
  /** Probes PATH for the known ACP agent CLIs; never spawns anything. */
  detectAgentClis(): Promise<AgentCliDetection[]>;
  /** `options.mode` defaults to `temp`; `project` requires `options.cwd`. */
  createAgentTask(title?: string, options?: AgentTaskOptions): Promise<AgentTaskInfo>;
  closeAgentTask(id: string): Promise<void>;
  /**
   * Brings a restored task's agent session back (`session/load`) without sending
   * a prompt. A no-op for tasks that were never persisted.
   */
  resumeAgentTask(id: string): Promise<void>;
  promptAgent(taskId: string, text: string): Promise<void>;
  cancelAgent(taskId: string): Promise<void>;
  getAgentTranscript(taskId: string): Promise<AgentTranscript>;
  respondAgentApproval(requestId: string, optionId: string | null): Promise<void>;
  /** Tells main which terminal tab is in front, so the agent has a default target. */
  setAgentFocus(sessionId: string | null): Promise<void>;

  /* ----------------------------------------------------------------- files */

  /**
   * Where this session's file tree starts. `null` when the session has no file
   * channel yet (an SSH tab that is still connecting, or one that failed).
   */
  sftpOrigin(sessionId: string): Promise<SftpOrigin | null>;
  sftpList(sessionId: string, path: string): Promise<SftpListing>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  /** Creates an empty file. Existing files are left alone. */
  sftpCreateFile(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpRemove(sessionId: string, paths: string[]): Promise<void>;
  /** Copies local files or folders into `destDir`; progress arrives as events. */
  sftpUpload(sessionId: string, destDir: string, localPaths: string[]): Promise<void>;
  /**
   * Asks where to put the downloaded entries, then copies them there. Returns
   * the chosen directory, or `null` when the dialog was cancelled.
   */
  sftpDownload(sessionId: string, paths: string[]): Promise<string | null>;
  /** Native multi-file picker for the upload action; empty when cancelled. */
  sftpPickFiles(): Promise<string[]>;
  /**
   * Copies remote entries into the app's temporary folder and returns the local
   * paths, so a drag out of the panel can hand real files to the OS.
   */
  sftpStage(sessionId: string, paths: string[]): Promise<string[]>;
  /** Starts a native drag with staged files: the other half of a drag out. */
  sftpStartDrag(paths: string[]): void;
  /** Asks the shell where it is; the resolved directory, or `null`. */
  sftpRefreshCwd(sessionId: string): Promise<string | null>;
  /** Enables directory queries on terminal output while the file sheet follows. */
  sftpFollowCwd(sessionId: string, follow: boolean): Promise<void>;
  /** Absolute path of a dropped `File`, for drag-and-drop upload. */
  pathForFile(file: File): string;

  onEvent(listener: (event: SessionEvent) => void): () => void;
  /** Agent traffic has its own channel; the session event stream stays as it was. */
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /** SFTP progress and failures keep their own channel, like agent traffic. */
  onSftpEvent(listener: (event: SftpEvent) => void): () => void;
}
