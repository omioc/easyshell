import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentCliDetection } from '@shared/agents';
import type {
  AgentEvent,
  AgentTaskInfo,
  AgentTaskOptions,
  AgentTranscript,
  ApplyIdentityResult,
  AttachSnapshot,
  BootstrapPayload,
  ConnectionTestResult,
  DeepPartial,
  EasyShellBridge,
  ExecResult,
  SessionEvent,
  SessionInfo,
  SessionMetadata,
  PluginInfo,
  SessionSpec,
  SessionSpecSsh,
  Settings,
  SftpEvent,
  SftpListing,
  SftpOrigin,
  WindowBridgeState,
} from '@shared/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const bridge: EasyShellBridge = {
  bootstrap: () => invoke<BootstrapPayload>('app:bootstrap'),

  listSessions: () => invoke<SessionInfo[]>('session:list'),
  getSession: (id) => invoke<SessionInfo | null>('session:get', id),
  createSession: (spec: SessionSpec) => invoke<SessionInfo>('session:create', spec),
  closeSession: (id) => invoke<void>('session:close', id),
  renameSession: (id, title) => invoke<void>('session:rename', id, title),
  writeSession: (id, data) => invoke<void>('session:write', id, data),
  resizeSession: (id, cols, rows) => invoke<void>('session:resize', id, cols, rows),
  attachSession: (id) => invoke<AttachSnapshot>('session:attach', id),
  detachSession: (id) => invoke<void>('session:detach', id),
  probeSession: (id) => invoke<SessionMetadata>('session:probe', id),
  execInSession: (id, command, timeoutMs) => invoke<ExecResult>('session:exec', id, command, timeoutMs),
  testConnection: (spec) => invoke<ConnectionTestResult>('connection:test', spec),
  respondCredential: (id, decision) => invoke<void>('session:credential', id, decision),

  getSettings: () => invoke<Settings>('settings:get'),
  updateSettings: (patch: DeepPartial<Settings>) => invoke<Settings>('settings:update', patch),
  listPlugins: () => invoke<PluginInfo[]>('plugins:list'),
  applyIdentity: () => invoke<ApplyIdentityResult>('identity:apply'),
  revealIdentity: () => invoke<void>('identity:reveal'),
  listWslDistributions: () => invoke<string[]>('platform:wsl'),
  pickPrivateKeyFile: () => invoke<string | null>('dialog:pick-private-key'),
  /** Native directory picker for a project task; null when cancelled. */
  pickProjectDirectory: () => invoke<string | null>('dialog:pick-directory'),
  readClipboardText: () => invoke<string>('clipboard:read-text'),
  listAgentTasks: () => invoke<AgentTaskInfo[]>('agent:list'),
  detectAgentClis: () => invoke<AgentCliDetection[]>('agent:detect'),
  createAgentTask: (title, options) =>
    invoke<AgentTaskInfo>('agent:create', title, options),
  closeAgentTask: (id) => invoke<void>('agent:close', id),
  resumeAgentTask: (id) => invoke<void>('agent:resume', id),
  promptAgent: (taskId, text) => invoke<void>('agent:prompt', taskId, text),
  cancelAgent: (taskId) => invoke<void>('agent:cancel', taskId),
  getAgentTranscript: (taskId) => invoke<AgentTranscript>('agent:transcript', taskId),
  respondAgentApproval: (requestId, optionId) =>
    invoke<void>('agent:approval', requestId, optionId),
  setAgentFocus: (sessionId) => invoke<void>('agent:focus', sessionId),

  sftpOrigin: (sessionId) => invoke<SftpOrigin | null>('sftp:origin', sessionId),
  sftpList: (sessionId, path) => invoke<SftpListing>('sftp:list', sessionId, path),
  sftpMkdir: (sessionId, path) => invoke<void>('sftp:mkdir', sessionId, path),
  sftpCreateFile: (sessionId, path) => invoke<void>('sftp:create-file', sessionId, path),
  sftpRename: (sessionId, from, to) => invoke<void>('sftp:rename', sessionId, from, to),
  sftpRemove: (sessionId, paths) => invoke<void>('sftp:remove', sessionId, paths),
  sftpUpload: (sessionId, destDir, localPaths) =>
    invoke<void>('sftp:upload', sessionId, destDir, localPaths),
  sftpDownload: (sessionId, paths) => invoke<string | null>('sftp:download', sessionId, paths),
  sftpPickFiles: () => invoke<string[]>('sftp:pick-files'),
  sftpStage: (sessionId, paths) => invoke<string[]>('sftp:stage', sessionId, paths),
  sftpStartDrag: (paths) => {
    ipcRenderer.send('sftp:start-drag', paths);
  },
  sftpRefreshCwd: (sessionId) => invoke<string | null>('sftp:cwd', sessionId),
  sftpFollowCwd: (sessionId, follow) => invoke<void>('sftp:follow-cwd', sessionId, follow),
  /**
   * A dropped `File` carries its real path only inside the preload world, so the
   * lookup has to happen here rather than in the renderer.
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  getWindowState: () => invoke<WindowBridgeState>('window:state'),
  windowMinimize: () => invoke<void>('window:minimize'),
  windowToggleMaximize: () => invoke<boolean>('window:toggle-maximize'),
  windowClose: () => invoke<void>('window:close'),

  onEvent: (listener) => {
    const handler = (_event: unknown, payload: SessionEvent) => listener(payload);
    ipcRenderer.on('app:event', handler);
    return () => {
      ipcRenderer.removeListener('app:event', handler);
    };
  },

  onAgentEvent: (listener) => {
    const handler = (_event: unknown, payload: AgentEvent) => listener(payload);
    ipcRenderer.on('agent:event', handler);
    return () => {
      ipcRenderer.removeListener('agent:event', handler);
    };
  },

  onSftpEvent: (listener) => {
    const handler = (_event: unknown, payload: SftpEvent) => listener(payload);
    ipcRenderer.on('sftp:event', handler);
    return () => {
      ipcRenderer.removeListener('sftp:event', handler);
    };
  },
};

contextBridge.exposeInMainWorld('easyshell', bridge);