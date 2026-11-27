import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell,
} from 'electron';
import { execFile } from 'node:child_process';
import { homedir, hostname as osHostname, userInfo } from 'node:os';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveLocale, translate } from '../shared/i18n';
import { recordHostFacts } from '../shared/profiles';
import type {
  ApiEndpointInfo,
  ApiSettings,
  ApplyIdentityResult,
  BootstrapPayload,
  ConnectionTestResult,
  DeepPartial,
  ExecResult,
  AgentEvent,
  AgentTaskOptions,
  PlatformInfo,
  PlatformOs,
  PluginInfo,
  SessionEvent,
  SessionMetadata,
  SessionSpec,
  SessionSpecSsh,
  Settings,
  SftpEvent,
  SftpListing,
  SftpOrigin,
  WindowBridgeState,
} from '../shared/types';
import { ControlServer } from './api/server';
import { AgentManager } from './agent/manager';
import { detectAgentClis } from './agent/detect';
import { AgentBridge } from './mcp/bridge';
import { runCliCommand } from './cli/client';
import { extractCliArgs, parseInvocation } from './cli/parse';
import type { CliCommand, CliParseContext } from './cli/parse';
import { applyIdentity } from './identity/spoof';
import { readHostPlatform } from './metadata/platform';
import { paths } from './paths';
import {
  PluginRuntime,
  linkPlugins,
  pluginCatalog,
  pluginHelpLines,
  releaseRequest,
} from './plugins';
import { SftpManager } from './sftp/manager';
import { KnownHostsStore } from './session/known-hosts';
import { SessionManager } from './session/manager';
import { testSshConnection } from './session/ssh';
import { SettingsStore } from './settings';
import { createSecretCipher } from './secrets';
import { createWindow, resolveAppIcon } from './window';

const execFileAsync = promisify(execFile);

const platform: PlatformOs =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const isDev = !app.isPackaged;

const settingsStore = new SettingsStore(platform, createSecretCipher(safeStorage));
const knownHosts = new KnownHostsStore(paths.knownHostsFile);

let mainWindow: BrowserWindow | null = null;
let controlServer: ControlServer | null = null;
let agentManager: AgentManager | null = null;
let agentBridge: AgentBridge | null = null;
let sftpManager: SftpManager | null = null;
let manager: SessionManager;
let wslDistributions: string[] = [];

/**
 * A link can arrive before the window exists: macOS delivers `sso://…` as an
 * Apple Event while the app is still starting, so it is parked here and handled
 * once the initial invocation has created its tabs.
 */
let pendingUrl: string | null = null;
let readyForUrls = false;

/**
 * The plugin host: the only bridge between a plugin file and the running app.
 * Claiming a scheme is an operating-system action, so it lives here rather than
 * in the plugin, which stays a description of a protocol.
 */
const pluginRuntime = new PluginRuntime({
  platform,
  settings: () => settingsStore.get(),
  claimUrlScheme: (scheme) => {
    if (platform !== 'darwin' && platform !== 'win32') return false;
    return app.setAsDefaultProtocolClient(scheme);
  },
  releaseUrlScheme: (scheme) => {
    app.removeAsDefaultProtocolClient(scheme);
  },
});

function broadcast(event: SessionEvent): void {
  noteHostFacts(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:event', event);
  }
  controlServer?.handleEvent(event);
}

/**
 * Writes what a session learned about its machine onto the saved connection.
 *
 * A probe or a login banner is the only source: nothing is ever typed into the
 * user's shell for this. A session that could not identify its host changes
 * nothing, so an unusual or unreachable machine keeps the plain terminal tile.
 */
function noteHostFacts(event: SessionEvent): void {
  if (event.type !== 'session-metadata') return;
  const { endpoint, os } = event.metadata;
  if (endpoint.kind !== 'ssh') return;
  const facts = readHostPlatform(os);
  if (!facts) return;
  const profiles = recordHostFacts(settingsStore.get().ssh.profiles, endpoint, facts, Date.now());
  if (!profiles) return;
  const next = settingsStore.update({ ssh: { profiles } });
  broadcast({ type: 'settings-updated', settings: next });
}

/**
 * Agent traffic keeps its own channel: the session event stream is shared with
 * the local control API, and those clients have no business seeing prompts.
 */
function broadcastAgent(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:event', event);
  }
}

/**
 * File-sheet traffic keeps its own channel: it is high volume (transfer
 * progress) and it has no place in the control API's session stream.
 */
function broadcastSftp(event: SftpEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sftp:event', event);
  }
}

/** Every dialog in this file is parented to the window, so it cannot be missed. */
async function pickDirectory(
  title: string,
  buttonLabel: string,
  defaultPath?: string,
): Promise<string | null> {
  const options = {
    title,
    buttonLabel,
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  } as Electron.OpenDialogOptions;
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * The image a native drag carries.
 *
 * `startDrag` refuses to begin without one, so a build that lost its icon keeps
 * a fallback: the staged file is revealed in the file manager instead of the
 * user holding a button that does nothing.
 */
function dragIcon(): Electron.NativeImage | null {
  const path = resolveAppIcon();
  if (!path) return null;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return null;
  return image.resize({ width: 32, height: 32 });
}

function requireSftp(): SftpManager {
  if (!sftpManager) throw new Error('the file sheet is not ready');
  return sftpManager;
}

function parseContext(): CliParseContext {
  const settings = settingsStore.get();
  return {
    defaultSshPort: settings.ssh.defaultPort,
    hostKeyPolicy: settings.ssh.hostKeyPolicy,
    defaultUsername: userInfo().username,
    profiles: settings.shell.profiles,
    defaultProfileId: settings.shell.defaultProfileId,
    defaultDistribution: settings.shell.wslDefaultDistribution,
    // Only the plugins the user left on: the parser cannot know `sso://`, and a
    // plugin that was switched off must stop answering links immediately.
    plugins: linkPlugins(settings),
  };
}

function platformInfo(): PlatformInfo {
  const settings = settingsStore.get();
  return {
    os: platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    hostname: osHostname(),
    username: userInfo().username,
    homeDir: homedir(),
    locale: resolveLocale(settings.locale, app.getLocale()),
    launchPath: process.execPath,
  };
}

function apiInfo(): ApiEndpointInfo {
  const settings = settingsStore.get();
  return {
    enabled: settings.api.enabled,
    host: settings.api.host,
    port: settings.api.port,
    token: settings.api.token,
    baseUrl: `http://${settings.api.host}:${settings.api.port}`,
  };
}

async function listWslDistributions(): Promise<string[]> {
  if (platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
    return stdout
      .replace(/\u0000/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function focusWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * A link the OS handed over becomes the invocation a command line would have
 * produced. Which schemes are ours is the plugins' business, so this stays one
 * line: the parser already knows the ones still enabled.
 */
async function openExternalUrl(url: string): Promise<void> {
  focusWindow();
  await handleInvocation(parseInvocation([url], parseContext()));
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!readyForUrls) {
    pendingUrl = url;
    return;
  }
  void openExternalUrl(url);
});

async function handleInvocation(command: CliCommand): Promise<void> {
  if (command.type !== 'spawn') return;
  if (command.locale && settingsStore.get().locale !== command.locale) {
    const next = settingsStore.update({ locale: command.locale });
    broadcast({ type: 'settings-updated', settings: next });
  }
  for (const spec of command.specs) {
    try {
      await manager.create(spec);
    } catch (error) {
      broadcast({
        type: 'notice',
        notice: {
          level: 'error',
          key: 'error.connect',
          params: { message: error instanceof Error ? error.message : String(error) },
        },
      });
    }
  }
  if (command.specs.length > 0) {
    broadcast({
      type: 'notice',
      notice: { level: 'info', key: 'notice.cliSessions', params: { count: command.specs.length } },
    });
    if (command.activate) focusWindow();
  }
}

async function restartControlServer(): Promise<void> {
  if (!controlServer) return;
  const settings = settingsStore.get();
  const result = await controlServer.restart();
  if (result.ok) {
    broadcast({
      type: 'notice',
      notice: {
        level: 'info',
        key: 'notice.apiStarted',
        params: { url: `http://${settings.api.host}:${settings.api.port}` },
      },
    });
  } else if (result.error && result.error !== 'disabled') {
    broadcast({
      type: 'notice',
      notice: {
        level: 'warn',
        key: 'notice.apiPortBusy',
        params: { port: settings.api.port, error: result.error },
      },
    });
  }
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', (): BootstrapPayload => {
    return {
      settings: settingsStore.get(),
      secrets: { encrypted: settingsStore.secretsEncrypted },
      sessions: manager.list(),
      platform: platformInfo(),
      api: apiInfo(),
      wslDistributions,
      pendingSpecs: [],
      agentTasks: agentManager?.list() ?? [],
    };
  });

  ipcMain.handle('session:list', () => manager.list());
  ipcMain.handle('session:get', (_event, id: string) => manager.get(id));
  ipcMain.handle('session:create', async (_event, spec: SessionSpec) => manager.create(spec));
  ipcMain.handle('session:close', (_event, id: string) => {
    manager.close(id);
  });
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    manager.rename(id, title);
  });
  ipcMain.handle('session:write', (_event, id: string, data: string) => {
    manager.write(id, data);
  });
  // The credential popover's answer: use the saved password, or keep the one
  // just typed. Neither happens without this call.
  ipcMain.handle('session:credential', (_event, id: string, decision: 'accept' | 'dismiss') => {
    manager.respondCredential(id, decision);
  });
  ipcMain.handle('session:resize', (_event, id: string, cols: number, rows: number) => {
    manager.resize(id, cols, rows);
  });
  ipcMain.handle('session:attach', (_event, id: string) => manager.attach(id));
  ipcMain.handle('session:detach', (_event, id: string) => {
    manager.removeClient(id, 'renderer');
  });
  ipcMain.handle('session:probe', (_event, id: string): Promise<SessionMetadata | null> => manager.probe(id));
  ipcMain.handle(
    'session:exec',
    (_event, id: string, command: string, timeoutMs?: number): Promise<ExecResult> =>
      manager.exec(id, command, { timeoutMs }),
  );

  /*
   * The editor's "test" button. It opens a connection and hangs up: no session,
   * no tab, nothing written to settings. The host-key verdict is the same one a
   * real tab would get, which is the part worth testing before saving.
   */
  ipcMain.handle(
    'connection:test',
    async (_event, spec: SessionSpecSsh): Promise<ConnectionTestResult> => {
      try {
        await testSshConnection({ spec, settings: settingsStore.get(), knownHosts });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle('agent:list', () => agentManager?.list() ?? []);
  ipcMain.handle('agent:detect', () => detectAgentClis());
  ipcMain.handle('agent:create', (_event, title?: string, options?: AgentTaskOptions) => {
    if (!agentManager) throw new Error('agent manager is not ready');
    return agentManager.create(title, options);
  });
  ipcMain.handle('agent:resume', async (_event, id: string) => {
    await agentManager?.resume(id);
  });
  ipcMain.handle('agent:close', (_event, id: string) => {
    agentManager?.close(id);
  });
  ipcMain.handle('agent:prompt', async (_event, id: string, text: string) => {
    await agentManager?.prompt(id, text);
  });
  ipcMain.handle('agent:cancel', (_event, id: string) => {
    agentManager?.cancel(id);
  });
  ipcMain.handle('agent:transcript', (_event, id: string) =>
    agentManager?.transcript(id) ?? { messages: [], toolCalls: [] },
  );
  ipcMain.handle('agent:approval', (_event, requestId: string, optionId: string | null) => {
    agentManager?.respond(requestId, optionId);
  });
  ipcMain.handle('agent:focus', (_event, sessionId: string | null) => {
    agentManager?.setFocus(sessionId);
  });

  /* ----------------------------------------------------------------- files */

  ipcMain.handle('sftp:origin', (_event, sessionId: string): Promise<SftpOrigin | null> =>
    requireSftp().origin(sessionId),
  );
  ipcMain.handle(
    'sftp:list',
    (_event, sessionId: string, path: string): Promise<SftpListing> =>
      requireSftp().list(sessionId, path),
  );
  ipcMain.handle('sftp:mkdir', (_event, sessionId: string, path: string) =>
    requireSftp().mkdir(sessionId, path),
  );
  ipcMain.handle('sftp:create-file', (_event, sessionId: string, path: string) =>
    requireSftp().createFile(sessionId, path),
  );
  ipcMain.handle('sftp:rename', (_event, sessionId: string, from: string, to: string) =>
    requireSftp().rename(sessionId, from, to),
  );
  ipcMain.handle('sftp:remove', (_event, sessionId: string, paths: string[]) =>
    requireSftp().remove(sessionId, paths),
  );
  ipcMain.handle(
    'sftp:upload',
    (_event, sessionId: string, destDir: string, localPaths: string[]) =>
      requireSftp().upload(sessionId, destDir, localPaths),
  );
  ipcMain.handle('sftp:stage', (_event, sessionId: string, paths: string[]): Promise<string[]> =>
    requireSftp().stage(sessionId, paths),
  );
  ipcMain.handle('sftp:cwd', (_event, sessionId: string) => manager.refreshCwd(sessionId));
  ipcMain.handle('sftp:follow-cwd', (_event, sessionId: string, follow: boolean) =>
    manager.followCwd(sessionId, follow),
  );

  ipcMain.handle('sftp:pick-files', async (): Promise<string[]> => {
    const settings = settingsStore.get();
    const locale = resolveLocale(settings.locale, app.getLocale());
    const options = {
      title: translate(locale, 'sftp.pickUpload'),
      buttonLabel: translate(locale, 'sftp.upload'),
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
    } as Electron.OpenDialogOptions;
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle(
    'sftp:download',
    async (_event, sessionId: string, paths: string[]): Promise<string | null> => {
      const settings = settingsStore.get();
      const locale = resolveLocale(settings.locale, app.getLocale());
      const target = await pickDirectory(
        translate(locale, 'sftp.pickDownload'),
        translate(locale, 'sftp.download'),
        app.getPath('downloads'),
      );
      if (!target) return null;
      await requireSftp().download(sessionId, paths, target);
      return target;
    },
  );

  // A drag out of the sheet: the files were staged on disk first, so the OS
  // only ever sees real paths.
  ipcMain.on('sftp:start-drag', (_event, paths: string[]) => {
    if (!mainWindow || mainWindow.isDestroyed() || paths.length === 0) return;
    const icon = dragIcon();
    const first = paths[0];
    if (!icon || !first) {
      if (first) shell.showItemInFolder(first);
      return;
    }
    mainWindow.webContents.startDrag({ file: first, files: paths, icon });
  });

  // The catalog is static, so the page reads it once; whether a plugin actually
  // runs is the settings' answer, which the page already subscribes to.
  ipcMain.handle('plugins:list', (): PluginInfo[] => pluginCatalog());

  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:update', async (_event, patch: DeepPartial<Settings>): Promise<Settings> => {
    const before = settingsStore.get();
    const next = settingsStore.update(patch);
    broadcast({ type: 'settings-updated', settings: next });

    const apiChanged =
      before.api.port !== next.api.port ||
      before.api.token !== next.api.token ||
      before.api.enabled !== next.api.enabled;
    if (apiChanged) await restartControlServer();

    if (before.probe.enabled !== next.probe.enabled) {
      for (const session of manager.list()) manager.setProbeEnabled(session.id, next.probe.enabled);
    }
    nativeTheme.themeSource = next.appearance.theme;
    return next;
  });

  ipcMain.handle('identity:apply', async (): Promise<ApplyIdentityResult> => {
    const settings = settingsStore.get();
    const result = await applyIdentity({
      identity: settings.identity,
      platform,
      execPath: process.execPath,
      isPackaged: app.isPackaged,
      artifactsDir: paths.artifactsDir,
    });
    if (result.ok && result.path) {
      settingsStore.update({
        identity: { lastAppliedPath: result.path, lastAppliedAt: Date.now() },
      });
      broadcast({ type: 'settings-updated', settings: settingsStore.get() });
    }
    return result;
  });

  ipcMain.handle('identity:reveal', () => {
    const path = settingsStore.get().identity.lastAppliedPath;
    if (path) shell.showItemInFolder(path);
  });

  ipcMain.handle('platform:wsl', () => listWslDistributions());

  ipcMain.handle('dialog:pick-private-key', async (): Promise<string | null> => {
    const settings = settingsStore.get();
    const locale = resolveLocale(settings.locale, app.getLocale());
    const options = {
      title: translate(locale, 'connections.pickKey'),
      buttonLabel: translate(locale, 'connections.pickKeyHint'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: translate(locale, 'newSession.auth.key'), extensions: ['pem', 'key', 'ppk', 'ed25519', 'rsa', 'ecdsa', 'openssh'] },
        { name: translate(locale, 'common.allFiles'), extensions: ['*'] },
      ],
    } as Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('dialog:pick-directory', async (): Promise<string | null> => {
    const settings = settingsStore.get();
    const locale = resolveLocale(settings.locale, app.getLocale());
    // A project task needs a real directory: picking one is the whole point of
    // the mode, so the dialog opens straight into directory selection.
    const options = {
      title: translate(locale, 'agent.pickProject'),
      buttonLabel: translate(locale, 'agent.pickProjectButton'),
      properties: ['openDirectory', 'createDirectory'],
    } as Electron.OpenDialogOptions;
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  // Read from the main process: the renderer never asks the browser for a
  // clipboard permission, and a paste that quietly does nothing is worse than
  // one that is refused out loud.
  ipcMain.handle('clipboard:read-text', (): Promise<string> => clipboard.readText());

  ipcMain.handle('window:state', (): WindowBridgeState => {
    return {
      maximized: mainWindow?.isMaximized() ?? false,
      fullscreen: mainWindow?.isFullScreen() ?? false,
      platform,
    };
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
}

function persistWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  settingsStore.update({
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: mainWindow.isMaximized(),
    },
  });
}

/**
 * Hands sessions to the instance that is already running.
 *
 * This is what a bastion portal triggers: the portal spawns the executable with
 * one quoted argument, and that invocation must not start a second app. It also
 * makes the call cheap, because no Chromium has to boot just to open a tab.
 */
async function forwardToRunningInstance(specs: SessionSpec[], api: ApiSettings): Promise<boolean> {
  if (!api.enabled || !api.token) return false;
  const base = `http://${api.host}:${api.port}`;
  const headers = { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' };

  try {
    const health = await fetch(`${base}/v1/health`, { headers, signal: AbortSignal.timeout(1500) });
    if (!health.ok) return false;
  } catch {
    return false;
  }

  for (const spec of specs) {
    try {
      const response = await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ spec: { ...spec, origin: spec.origin ?? { type: 'api' } } }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function startApp(): Promise<void> {
  manager = new SessionManager({
    getSettings: () => settingsStore.get(),
    platform,
    homeDir: homedir(),
    knownHosts,
    emit: broadcast,
    // A password the user agreed to keep: the settings store seals it on disk
    // exactly like a saved host's own password. The broadcast is what keeps the
    // settings page honest — the vault is written from the terminal, so no IPC
    // call answers with the new list and the open page would keep showing the
    // one it read when it mounted.
    replaceCredentials: (credentials) => {
      const next = settingsStore.update({ vault: { credentials } });
      broadcast({ type: 'settings-updated', settings: next });
    },
  });

  agentBridge = new AgentBridge({
    sessions: manager,
    getSettings: () => settingsStore.get(),
    focused: () => agentManager?.focused() ?? null,
    // The bridge answers `terminal_run` itself, so the permission gate has to be
    // asked here too; without it an agent could skip the mode that the user set.
    authorize: async (input) => {
      const agents = agentManager;
      if (!agents) return { allowed: false, reason: 'the assistant is not running' };
      return agents.authorizeBridgeCommand(input);
    },
    // The answer to a run goes back to the agent over MCP, so the transcript
    // only learns how it ended from here.
    onRun: (input) => agentManager?.recordBridgeRun(input),
  });
  await agentBridge.start();

  controlServer = new ControlServer({
    manager,
    getSettings: () => settingsStore.get(),
    appVersion: app.getVersion(),
  });

  agentManager = new AgentManager({
    getSettings: () => settingsStore.get(),
    // The classifier's one-sentence reason is quoted verbatim in the approval
    // card, so it has to come back in the language the app is showing.
    getLocale: () => resolveLocale(settingsStore.get().locale, app.getLocale()),
    sessions: manager,
    // Temp tasks and the classifier work in the app's own scratch directory:
    // no project context, and nothing the user has to choose or maintain.
    tempDir: join(homedir(), '.easyshell'),
    // The task list is the only place a working directory is remembered, so it
    // has to outlive the process.
    tasksFile: paths.agentTasksFile,
    emit: broadcastAgent,
    // Every agent session gets the MCP bridge, because it is the only route
    // into a terminal that does not depend on the agent implementing ACP's
    // terminal extension.
    mcpServers: (taskId) => {
      const endpoint = agentBridge?.endpoint;
      if (!endpoint) return [];
      return [
        {
          name: 'easyshell',
          // Electron relaunched as plain Node: the bridge script uses no
          // Electron API, and booting Chromium for a JSON-RPC pipe would cost
          // more than every command it will ever run.
          command: process.execPath,
          args: [join(__dirname, 'mcp-server.js')],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'EASYSHELL_BRIDGE_URL', value: endpoint.url },
            { name: 'EASYSHELL_BRIDGE_TOKEN', value: endpoint.token },
            // The bridge names the task an approval card belongs to.
            { name: 'EASYSHELL_BRIDGE_TASK', value: taskId },
          ],
        },
      ];
    },
  });

  sftpManager = new SftpManager({
    sessions: manager,
    platform,
    homeDir: homedir(),
    tempDir: app.getPath('temp'),
    emit: broadcastSftp,
  });

  await app.whenReady();
  // The OS key store only answers once the app is ready; this opens what the
  // first load had to leave sealed and rewrites the file with everything sealed.
  settingsStore.settleSecrets();
  nativeTheme.themeSource = settingsStore.get().appearance.theme;
  if (platform === 'win32') app.setAppUserModelId('com.easyshell.app');

  // Optional capabilities come on before any link can legitimately arrive, and
  // follow the settings from then on: a switch claims or releases its schemes
  // without a restart, and the parser reads the same list on every invocation.
  pluginRuntime.sync(settingsStore.get());
  settingsStore.on('change', (next: Settings) => pluginRuntime.sync(next));

  wslDistributions = await listWslDistributions();
  registerIpc();

  mainWindow = createWindow(settingsStore.get(), isDev);
  mainWindow.on('close', persistWindowBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (platform === 'darwin' && !app.isPackaged) {
    // Packaged builds take the dock icon from the .icns; in dev we hand it the PNG.
    const icon = resolveAppIcon();
    if (icon) app.dock?.setIcon(icon);
  }
  await restartControlServer();

  const invocation = parseInvocation(extractCliArgs(process.argv, app.isPackaged), parseContext());
  await handleInvocation(invocation);

  // A link that arrived while the app was booting waited for the first
  // invocation's tabs; from here on it is handled the moment it arrives.
  readyForUrls = true;
  if (pendingUrl) {
    const url = pendingUrl;
    pendingUrl = null;
    void openExternalUrl(url);
  }

  app.on('second-instance', (_event, argv) => {
    void handleInvocation(parseInvocation(extractCliArgs(argv, app.isPackaged), parseContext()));
  });

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(settingsStore.get(), isDev);
      mainWindow.on('close', persistWindowBounds);
    }
  });

  app.on('before-quit', () => {
    persistWindowBounds();
    manager.shutdown();
    agentManager?.shutdown();
    sftpManager?.dispose();
    void controlServer?.stop();
    void agentBridge?.stop();
  });
}

async function main(): Promise<void> {
  const argv = extractCliArgs(process.argv, app.isPackaged);

  // Escape hatch for a plugin's scheme claim: hand the schemes back to whatever
  // client had them before, without uninstalling anything. This works whether or
  // not the plugin is enabled, because a user who turned it off may still want
  // the vendor client back after a crash.
  const release = releaseRequest(argv);
  if (release) {
    // The configured schemes, not a hard-coded list: whatever the user's bastion
    // uses is what gets handed back.
    const schemes = release.urlSchemes(settingsStore.get());
    for (const scheme of schemes) app.removeAsDefaultProtocolClient(scheme);
    const names = schemes.length > 0 ? schemes.map((scheme) => `${scheme}://`).join(', ') : '(none)';
    writeSync(1, `${names} handler released\n`);
    app.exit(0);
    return;
  }

  const invocation = parseInvocation(argv, parseContext());

  if (invocation.type === 'help') {
    writeSync(1, 
      [
        'EasyShell',
        '  easyshell                     open the window',
        '  easyshell -newtab "<cmd>"     bastion invocation (MobaXterm syntax)',
        '  easyshell -ssh <host> -l <user> -p <port> -pw <password>',
        '  easyshell -url ssh://user@host:22',
        ...pluginHelpLines(settingsStore.get()),
        '  easyshell --local <profile> | --wsl <distro> | --new-ssh user@host',
        '  easyshell ls | info <id> | probe <id> | input <id> <text> | exec <id> -- <command>',
        '',
      ].join('\n'),
    );
    app.exit(0);
    return;
  }
  if (invocation.type === 'version') {
    writeSync(1, `${app.getVersion()}\n`);
    app.exit(0);
    return;
  }
  if (invocation.type === 'api') {
    const result = await runCliCommand(invocation.command, invocation.args, settingsStore.get().api);
    writeSync(1, `${result.text}\n`);
    app.exit(result.code);
    return;
  }

  if (invocation.type === 'spawn' && invocation.specs.length > 0) {
    const forwarded = await forwardToRunningInstance(invocation.specs, settingsStore.get().api);
    if (forwarded) {
      app.exit(0);
      return;
    }
  }

  if (invocation.type === 'spawn' && invocation.specs.length > 0) {
    const forwarded = await forwardToRunningInstance(invocation.specs, settingsStore.get().api);
    if (forwarded) {
      app.exit(0);
      return;
    }
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await startApp();
}

void main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});