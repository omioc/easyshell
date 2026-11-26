import { upsertCredential } from '@shared/credentials';
import { createDefaultSettings } from '@shared/defaults';
import { resolveLocale, translate } from '@shared/i18n';
import { createSshProfile } from '@shared/profiles';
import { createWorkspace } from '@shared/workspaces';
import type { AgentCliDetection } from '@shared/agents';
import type {
  AgentEvent,
  AgentMessage,
  AgentTaskInfo,
  AgentTaskOptions,
  AgentTranscript,
  ApplyIdentityResult,
  AttachSnapshot,
  BootstrapPayload,
  DeepPartial,
  EasyShellBridge,
  ExecResult,
  SftpEntry,
  SftpEvent,
  SessionEvent,
  SessionInfo,
  SessionKind,
  SessionMetadata,
  SessionSpec,
  SessionSpecSsh,
  Settings,
  SshProfile,
  WindowBridgeState,
} from '@shared/types';

/**
 * In-memory stand-in for `window.easyshell`, used by `npm run dev:web`.
 * Every screen of the renderer is reachable without Electron; all data below is
 * demo data, deterministic so the layout never shifts between renders.
 */

const MINUTE = 60_000;
const BASE = Date.now();

function isoMinus(offsetMs: number): number {
  return BASE - offsetMs;
}

function hexFromSeed(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 0xffffff;
  }
  return `0000${hash.toString(16)}`.slice(-6);
}

function demoToken(): string {
  return `${hexFromSeed('easyshell')}${hexFromSeed('local-api')}${hexFromSeed('bearer')}`;
}

/* --------------------------------------------------------------- seed data */

const SSH_OUTER_HOST = '192.0.2.7';
const SSH_OUTER_PORT = 60022;
const SSH_INNER_HOST = '192.0.2.9';
const SSH_INNER_HOSTNAME = 'core-node-01';

function localMetadata(): SessionMetadata {
  return {
    endpoint: {
      kind: 'local',
      displayName: 'PowerShell',
      host: 'DEMO-PC',
      username: 'demo',
      source: 'session',
      chain: [
        {
          label: 'PowerShell',
          host: 'DEMO-PC',
          username: 'demo',
          detectedBy: 'session',
          confidence: 'high',
          at: isoMinus(26 * MINUTE),
        },
      ],
    },
    os: {
      hostname: 'DEMO-PC',
      os: 'Windows 11 Pro',
      osVersion: '10.0.22631',
      kernel: '26100.2894',
      arch: 'x86_64',
      user: 'demo',
      shell: 'powershell.exe',
      ips: ['198.18.1.42'],
      cpuCount: 16,
      memoryMb: 32768,
      timezone: 'Asia/Shanghai',
      probedAt: isoMinus(4 * MINUTE),
    },
    extra: { 'windows.build': '22631.4169', 'powershell.version': '5.1.22621' },
    updatedAt: isoMinus(4 * MINUTE),
  };
}

function wslMetadata(): SessionMetadata {
  return {
    endpoint: {
      kind: 'wsl',
      displayName: 'Ubuntu',
      distribution: 'Ubuntu',
      host: 'DEMO-PC',
      username: 'demo',
      source: 'session',
      chain: [
        {
          label: 'Ubuntu',
          host: 'DEMO-PC',
          username: 'demo',
          detectedBy: 'session',
          confidence: 'high',
          at: isoMinus(52 * MINUTE),
        },
      ],
    },
    os: {
      hostname: 'DEMO-PC',
      os: 'Ubuntu',
      osVersion: '24.04.1 LTS',
      kernel: '5.15.167.4-microsoft-standard-WSL2',
      arch: 'x86_64',
      user: 'demo',
      shell: '/bin/bash',
      ips: ['198.18.112.5', '198.18.17.1'],
      cpuCount: 16,
      memoryMb: 15872,
      timezone: 'Asia/Shanghai',
      probedAt: isoMinus(11 * MINUTE),
    },
    extra: { distribution: 'Ubuntu', 'wsl.version': '2' },
    updatedAt: isoMinus(11 * MINUTE),
  };
}

function sshMetadata(): SessionMetadata {
  return {
    endpoint: {
      kind: 'ssh',
      displayName: 'root (su)',
      host: SSH_INNER_HOST,
      hostname: SSH_INNER_HOSTNAME,
      port: 22,
      username: 'root',
      source: 'nested',
      chain: [
        {
          label: 'sso-demo@192.0.2.6',
          host: SSH_OUTER_HOST,
          hostname: 'edge-gw-01',
          port: SSH_OUTER_PORT,
          username: 'sso-demo',
          detectedBy: 'session',
          confidence: 'high',
          at: isoMinus(18 * MINUTE),
        },
        {
          label: `root@${SSH_INNER_HOSTNAME}`,
          host: SSH_INNER_HOST,
          hostname: SSH_INNER_HOSTNAME,
          port: 22,
          username: 'root',
          detectedBy: 'prompt',
          confidence: 'high',
          at: isoMinus(3 * MINUTE),
        },
        {
          label: 'root (su)',
          host: SSH_INNER_HOST,
          hostname: SSH_INNER_HOSTNAME,
          port: 22,
          username: 'root',
          sameHost: true,
          detectedBy: 'command-line',
          confidence: 'low',
          at: isoMinus(1 * MINUTE),
        },
      ],
    },
    os: {
      hostname: 'core-node-01',
      fqdn: 'core-node-01.example.com',
      os: 'Ubuntu',
      osVersion: '22.04.4 LTS',
      kernel: '5.15.0-105-generic',
      arch: 'x86_64',
      user: 'root',
      shell: '/bin/bash',
      ips: ['192.0.2.9', '192.0.2.10'],
      cpuCount: 8,
      memoryMb: 15936,
      timezone: 'Asia/Shanghai',
      probedAt: isoMinus(3 * MINUTE),
    },
    extra: { 'bastion.hop': 'edge-gw-01', 'mfa.state': 'verified' },
    updatedAt: isoMinus(3 * MINUTE),
  };
}

function seedSessions(): SessionInfo[] {
  return [
    {
      id: 'sess-local-01',
      kind: 'local',
      title: 'PowerShell',
      status: 'connected',
      createdAt: isoMinus(26 * MINUTE),
      lastActivityAt: isoMinus(4 * MINUTE),
      cols: 118,
      rows: 30,
      exitCode: null,
      origin: { type: 'ui' },
      metadata: localMetadata(),
      probe: {
        enabled: true,
        intervalMs: 30_000,
        lastAt: isoMinus(4 * MINUTE),
        channel: 'child',
      },
      attachedClients: 0,
      bufferBytes: 18_432,
    },
    {
      id: 'sess-wsl-01',
      kind: 'wsl',
      title: 'Ubuntu',
      status: 'connected',
      createdAt: isoMinus(52 * MINUTE),
      lastActivityAt: isoMinus(11 * MINUTE),
      cols: 118,
      rows: 30,
      exitCode: null,
      origin: { type: 'cli', raw: 'easyshell --wsl Ubuntu', via: 'newtab' },
      metadata: wslMetadata(),
      probe: {
        enabled: true,
        intervalMs: 30_000,
        lastAt: isoMinus(11 * MINUTE),
        channel: 'child',
      },
      attachedClients: 0,
      bufferBytes: 4_096,
    },
    {
      id: 'sess-ssh-01',
      kind: 'ssh',
      title: `root@${SSH_OUTER_HOST}`,
      status: 'connected',
      createdAt: isoMinus(18 * MINUTE),
      lastActivityAt: isoMinus(3 * MINUTE),
      cols: 118,
      rows: 30,
      exitCode: null,
      origin: { type: 'api' },
      metadata: sshMetadata(),
      probe: {
        enabled: true,
        intervalMs: 30_000,
        lastAt: isoMinus(3 * MINUTE),
        channel: 'exec-channel',
      },
      attachedClients: 1,
      bufferBytes: 92_160,
    },
  ];
}

const PLATFORM = {
  os: 'win32' as const,
  arch: 'x64',
  isPackaged: false,
  appVersion: '0.1.0',
  electron: '45.0.0',
  node: '22.15.0',
  hostname: 'DEMO-PC',
  username: 'demo',
  homeDir: 'C:\\Users\\demo',
  locale: 'en' as const,
  launchPath: 'C:\\Program Files\\EasyShell\\EasyShell.exe',
};

const API_BASE_URL = 'http://127.0.0.1:37821';

/** Three saved hosts (password, key file, agent). Demo data. */
function seedSshProfiles(): SshProfile[] {
  return [
    createSshProfile({
      id: 'ssh-demo-bastion',
      name: 'Bastion edge',
      host: SSH_OUTER_HOST,
      port: SSH_OUTER_PORT,
      username: 'root',
      authType: 'password',
      password: 'demo-password',
      portForwards: [
        { mode: 'local', bindHost: '127.0.0.1', bindPort: 21380, targetHost: '192.0.2.10', targetPort: 80 },
      ],
      loginCommands: ['cd /var/log', 'tail -n 20 syslog'],
      createdAt: isoMinus(72 * 60 * MINUTE),
      updatedAt: isoMinus(18 * MINUTE),
      lastUsedAt: isoMinus(18 * MINUTE),
    }),
    createSshProfile({
      id: 'ssh-demo-deploy',
      name: 'Production deploy',
      host: '192.0.2.130',
      username: 'deploy',
      authType: 'key',
      privateKeyPath: 'C:\\Users\\demo\\.ssh\\easyshell_deploy_ed25519',
      hostKeyPolicy: 'strict',
      loginCommands: ['cd /srv/app', 'git status --short'],
      createdAt: isoMinus(8 * 24 * 60 * MINUTE),
      updatedAt: isoMinus(3 * 24 * 60 * MINUTE),
      lastUsedAt: isoMinus(26 * 60 * MINUTE),
    }),
    createSshProfile({
      id: 'ssh-demo-lab',
      name: 'Lab cluster',
      host: 'lab-01.example.com',
      port: 2222,
      username: 'demo',
      authType: 'agent',
      createdAt: isoMinus(5 * 24 * 60 * MINUTE),
      updatedAt: isoMinus(2 * 24 * 60 * MINUTE),
    }),
  ];
}

/** Two workspaces, so the sidebar shows both levels of the demo data. */
function seedWorkspaces(): Settings['workspaces'] {
  return [
    createWorkspace({ id: 'ws-demo-core', name: 'EasyShell', profileIds: ['ssh-demo-bastion'] }),
    createWorkspace({
      id: 'ws-demo-release',
      name: 'Release',
      profileIds: ['ssh-demo-deploy'],
    }),
  ];
}

function seedSettings(): Settings {
  const settings = createDefaultSettings('win32');
  return {
    ...settings,
    api: { ...settings.api, token: demoToken() },
    ssh: { ...settings.ssh, profiles: seedSshProfiles() },
    workspaces: seedWorkspaces(),
    shell: { ...settings.shell, wslDefaultDistribution: 'Ubuntu' },
    probe: { ...settings.probe },
    // A plausible ACP CLI, so the demo shows the task list instead of the
    // first-run setup card. No process is ever spawned: the mock answers every
    // prompt with a demo notice.
    agent: { ...settings.agent, enabled: true, command: 'claude-code-acp', args: [] },
  };
}

/* ----------------------------------------------------------------- prompts */

function promptFor(session: SessionInfo, nestedHost?: string): string {
  if (session.kind === 'local') return 'PS C:\\Users\\demo> ';
  if (session.kind === 'wsl') return '\u001b[32mada@DEMO-PC\u001b[0m:\u001b[34m~\u001b[0m$ ';
  const host = nestedHost ? 'core-node-01' : 'edge-gw-02';
  return `\u001b[32mroot@${host}\u001b[0m:\u001b[34m~\u001b[0m# `;
}

function banner(session: SessionInfo): string {
  const head = '\u001b[36mEasyShell\u001b[0m \u001b[90mdemo session\u001b[0m\r\n';
  if (session.kind === 'local') {
    return (
      head +
      '\u001b[90mWindows PowerShell 5.1 \u00b7 DEMO-PC\u001b[0m\r\n' +
      '\u001b[90mType ls, pwd, whoami or help to see the mock respond.\u001b[0m\r\n\r\n'
    );
  }
  if (session.kind === 'wsl') {
    return (
      head +
      '\u001b[90mUbuntu 24.04.1 LTS \u00b7 WSL2 \u00b7 /home/demo\u001b[0m\r\n' +
      '\u001b[90mType ls, pwd, whoami or help to see the mock respond.\u001b[0m\r\n\r\n'
    );
  }
  return (
    head +
    `\u001b[90mroot@${SSH_OUTER_HOST}:${SSH_OUTER_PORT} \u00b7 Ubuntu 22.04.4 LTS\u001b[0m\r\n` +
    '\u001b[90mAlready inside root@192.0.2.9 (nested hop). Try: ssh 192.0.2.20\u001b[0m\r\n\r\n'
  );
}

/* ------------------------------------------------------------------- state */

interface MockState {
  settings: Settings;
  sessions: SessionInfo[];
  listeners: Set<(event: SessionEvent) => void>;
  buffers: Map<string, string>;
  prompts: Map<string, string>;
  nested: Map<string, string>;
  maximized: boolean;
  seq: number;
  /** Agent tasks. The demo starts empty so the first-run list is what you see. */
  agentTasks: AgentTaskInfo[];
  agentMessages: Map<string, AgentMessage[]>;
  agentListeners: Set<(event: AgentEvent) => void>;
  agentSeq: number;
  sftpListeners: Set<(event: SftpEvent) => void>;
  /** The login each session's demo `ssh` line asked for, so saving can find it. */
  credentialTargets: Map<string, { username: string; host: string }>;
}

/* --------------------------------------------------------------- demo files */

/**
 * A small file tree so the browser preview has something to browse.
 *
 * It lives at module scope instead of inside `MockState`: the preview has one
 * bridge, and a tree that is rebuilt per call would forget every folder the user
 * just created in it.
 */
interface DemoNode {
  name: string;
  size?: number;
  children?: DemoNode[];
}

interface DemoFile {
  path: string;
  dir: boolean;
  size: number;
  modifiedAt: number;
}

const DEMO_TREE: DemoNode = {
  name: '',
  children: [
    {
      name: 'home',
      children: [
        {
          name: 'demo',
          children: [
            {
              name: '.ssh',
              children: [
                { name: 'config', size: 1210 },
                { name: 'id_ed25519.pub', size: 98 },
              ],
            },
            {
              name: 'logs',
              children: [
                { name: 'nginx-access.log', size: 84_212_992 },
                { name: 'nginx-error.log', size: 1_204_112 },
                { name: 'deploy-2026-05-11.log', size: 12_004 },
              ],
            },
            {
              name: 'projects',
              children: [
                {
                  name: 'api-gateway',
                  children: [
                    { name: 'go.mod', size: 812 },
                    { name: 'Dockerfile', size: 1_934 },
                    { name: 'main.go', size: 6_140 },
                  ],
                },
                {
                  name: 'web-console',
                  children: [
                    { name: 'package.json', size: 2_318 },
                    { name: 'README.md', size: 4_120 },
                  ],
                },
              ],
            },
            { name: 'notes.md', size: 3_412 },
            { name: 'deploy.sh', size: 2_048 },
          ],
        },
      ],
    },
    {
      name: 'etc',
      children: [
        { name: 'hosts', size: 221 },
        { name: 'nginx', children: [{ name: 'nginx.conf', size: 1_442 }] },
      ],
    },
    { name: 'var', children: [{ name: 'log', children: [{ name: 'syslog', size: 512_004 }] }] },
  ],
};

function buildDemoFiles(): Map<string, DemoFile> {
  const files = new Map<string, DemoFile>();
  const at = isoMinus(30 * MINUTE);
  const walk = (node: DemoNode, parent: string): void => {
    const path = parent === '/' ? `/${node.name}` : `${parent}/${node.name}`;
    const dir = node.children !== undefined;
    files.set(path, { path, dir, size: node.size ?? 0, modifiedAt: at });
    for (const child of node.children ?? []) walk(child, path);
  };
  for (const child of DEMO_TREE.children ?? []) walk(child, '/');
  return files;
}

const demoFiles = buildDemoFiles();
const DEMO_HOME = '/home/demo';

function demoParent(path: string): string | null {
  if (path === '/' || path === '') return null;
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function emitSftp(state: MockState, event: SftpEvent): void {
  for (const listener of state.sftpListeners) listener(event);
}

function demoEntries(path: string): SftpEntry[] {
  const prefix = path === '/' ? '/' : `${path}/`;
  const rows: SftpEntry[] = [];
  for (const file of demoFiles.values()) {
    if (!file.path.startsWith(prefix) || file.path === path) continue;
    if (file.path.slice(prefix.length).includes('/')) continue;
    rows.push({
      name: file.path.slice(prefix.length),
      path: file.path,
      dir: file.dir,
      size: file.size,
      modifiedAt: file.modifiedAt,
    });
  }
  return rows.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function emitAgent(state: MockState, event: AgentEvent): void {
  for (const listener of state.agentListeners) listener(event);
}

/** Same replace-by-id rule the real transcript follows: streaming grows one id. */
function pushAgentMessage(state: MockState, message: AgentMessage): void {
  const list = state.agentMessages.get(message.taskId) ?? [];
  const index = list.findIndex((item) => item.id === message.id);
  state.agentMessages.set(
    message.taskId,
    index === -1 ? [...list, message] : list.map((item, i) => (i === index ? message : item)),
  );
  emitAgent(state, { type: 'agent-message', message });
}

function emit(state: MockState, event: SessionEvent): void {
  for (const listener of state.listeners) listener(event);
}

function touch(state: MockState, id: string): void {
  const session = state.sessions.find((item) => item.id === id);
  if (session) session.lastActivityAt = Date.now();
}

function commandOutput(state: MockState, session: SessionInfo, line: string): string {
  const command = line.trim();
  if (!command) return '';
  const parts = command.split(/\s+/);
  const head = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1).join(' ');

  if (command === 'clear' || command === 'cls') return '\u001b[2J\u001b[H';
  if (head === 'echo') return `${rest}\r\n`;
  if (head === 'pwd') return session.kind === 'local' ? 'C:\\Users\\demo\r\n' : '/root\r\n';
  if (head === 'whoami') return session.kind === 'local' ? 'demo-pc\\demo\r\n' : 'root\r\n';
  if (head === 'ls' || head === 'dir' || head === 'll') {
    return (
      '\u001b[34mapps\u001b[0m   \u001b[34mdeploy\u001b[0m   \u001b[34mlogs\u001b[0m   ' +
      '\u001b[32mrun.sh\u001b[0m   \u001b[90mREADME.md\u001b[0m\r\n'
    );
  }
  if (head === 'uname') {
    return 'Linux edge-gw-02 5.15.0-105-generic #115-Ubuntu SMP x86_64 GNU/Linux\r\n';
  }
  if (head === 'date') return `${new Date().toISOString()}\r\n`;
  if (head === 'help') {
    return (
      '\u001b[90mdemo commands: ls, pwd, whoami, uname -a, date, echo <text>, clear\u001b[0m\r\n'
    );
  }
  if (head === 'ssh' && session.kind === 'ssh') {
    const host = rest.split(/\s+/)[0] ?? '';
    if (host) {
      state.nested.set(session.id, host);
      state.prompts.set(session.id, promptFor(session, host));
      const chain = session.metadata.endpoint.chain;
      const last = chain[chain.length - 1];
      if (!last || last.host !== host) {
        session.metadata = {
          endpoint: {
            ...session.metadata.endpoint,
            displayName: `root@${host}`,
            host,
            port: 22,
            source: 'nested',
            chain: [
              ...chain,
              {
                label: `root@${host}`,
                host,
                username: 'root',
                port: 22,
                detectedBy: 'command-line',
                confidence: 'medium',
                at: Date.now(),
              },
            ],
          },
          os: session.metadata.os,
          extra: session.metadata.extra,
          updatedAt: Date.now(),
        };
        emit(state, { type: 'session-metadata', id: session.id, metadata: session.metadata });
      }
      return (
        `\r\n\u001b[90mConnecting to ${host} through the existing jump host...\u001b[0m\r\n` +
        `\u001b[90mWelcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-105-generic x86_64)\u001b[0m\r\n`
      );
    }
  }
  return `\u001b[31m${head}: command not found\u001b[0m\r\n`;
}

function handleInput(state: MockState, session: SessionInfo, data: string): void {
  let out = '';
  let line = state.buffers.get(session.id) ?? '';
  let submittedLine = '';
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      state.buffers.set(session.id, '');
      submittedLine = line;
      out += '\r\n';
      out += commandOutput(state, session, line);
      out += state.prompts.get(session.id) ?? '';
      line = '';
    } else if (char === '\u007f') {
      if (line.length > 0) {
        line = line.slice(0, -1);
        out += '\b \b';
      }
    } else if (char === '\u0003') {
      state.buffers.set(session.id, '');
      line = '';
      out += '^C\r\n' + (state.prompts.get(session.id) ?? '');
    } else if (char === '\t') {
      out += '  ';
      line += '  ';
    } else if (char >= ' ') {
      line += char;
      out += char;
    }
  }
  state.buffers.set(session.id, line);
  touch(state, session.id);
  if (out) emit(state, { type: 'session-output', id: session.id, data: out });

  // `ssh alice@host` in the demo asks the same question a real login asks.
  const ssh = /^ssh\s+(?:-\S+\s+)*(\S+)$/.exec(submittedLine.trim());
  if (ssh) {
    const target = ssh[1] ?? '';
    const at = target.lastIndexOf('@');
    const username = at > 0 ? target.slice(0, at) : 'root';
    const host = at > 0 ? target.slice(at + 1) : target;
    if (host) {
      state.credentialTargets.set(session.id, { username, host });
      window.setTimeout(() => {
        emit(state, {
          type: 'session-credential',
          id: session.id,
          request: { kind: 'save', label: `${username}@${host}`, username, host },
        });
      }, 350);
    }
  }
}

function displayNameFor(spec: SessionSpec, settings: Settings): string {
  if (spec.kind === 'local') {
    const profile = settings.shell.profiles.find((item) => item.id === spec.profileId);
    return profile?.label ?? spec.command;
  }
  if (spec.kind === 'wsl') return spec.distribution;
  return `${spec.target.username}@${spec.target.host}`;
}

function buildSession(state: MockState, spec: SessionSpec): SessionInfo {
  state.seq += 1;
  const id = `sess-${spec.kind}-${String(state.seq).padStart(2, '0')}`;
  const created = Date.now();
  const displayName = displayNameFor(spec, state.settings);
  const endpoint = {
    kind: spec.kind as SessionKind,
    displayName,
    host: spec.kind === 'ssh' ? spec.target.host : PLATFORM.hostname,
    port: spec.kind === 'ssh' ? spec.target.port : undefined,
    username: spec.kind === 'ssh' ? spec.target.username : PLATFORM.username,
    distribution: spec.kind === 'wsl' ? spec.distribution : undefined,
    source: 'session' as const,
    chain: [
      {
        label: displayName,
        host: spec.kind === 'ssh' ? spec.target.host : PLATFORM.hostname,
        username: spec.kind === 'ssh' ? spec.target.username : PLATFORM.username,
        port: spec.kind === 'ssh' ? spec.target.port : undefined,
        detectedBy: 'session' as const,
        confidence: 'high' as const,
        at: created,
      },
    ],
  };
  const session: SessionInfo = {
    id,
    kind: spec.kind,
    title: spec.title ?? displayName,
    status: 'connecting',
    createdAt: created,
    lastActivityAt: created,
    cols: 118,
    rows: 30,
    exitCode: null,
    origin: spec.origin ?? { type: 'ui' },
    metadata: {
      endpoint,
      os: { user: spec.kind === 'ssh' ? spec.target.username : PLATFORM.username },
      extra: {},
      updatedAt: created,
    },
    probe: {
      enabled: state.settings.probe.enabled,
      intervalMs: state.settings.probe.intervalMs,
      channel: spec.kind === 'ssh' ? 'exec-channel' : 'child',
    },
    attachedClients: 0,
    bufferBytes: 0,
  };
  state.prompts.set(id, promptFor(session));
  state.buffers.set(id, '');
  return session;
}

/* ------------------------------------------------------------------ bridge */

export function createMockBridge(): EasyShellBridge {
  const state: MockState = {
    settings: seedSettings(),
    sessions: seedSessions(),
    listeners: new Set(),
    buffers: new Map(),
    prompts: new Map(),
    nested: new Map(),
    maximized: false,
    seq: 3,
    agentTasks: [],
    agentMessages: new Map(),
    agentListeners: new Set(),
    agentSeq: 0,
    sftpListeners: new Set(),
    credentialTargets: new Map(),
  };

  const find = (id: string): SessionInfo | null =>
    state.sessions.find((session) => session.id === id) ?? null;

  const bridge: EasyShellBridge = {
    async bootstrap(): Promise<BootstrapPayload> {
      return {
        settings: state.settings,
        sessions: state.sessions,
        platform: PLATFORM,
        api: {
          enabled: state.settings.api.enabled,
          host: state.settings.api.host,
          port: state.settings.api.port,
          token: state.settings.api.token,
          baseUrl: API_BASE_URL,
        },
        wslDistributions: ['Ubuntu', 'docker-desktop'],
        pendingSpecs: [],
        agentTasks: state.agentTasks,
        // The demo has no OS key store, but a real install does; show the note
        // the shipped app shows rather than the fallback one.
        secrets: { encrypted: true },
      };
    },

    async listSessions() {
      return state.sessions;
    },

    async getSession(id: string) {
      return find(id);
    },

    async createSession(spec: SessionSpec) {
      const session = buildSession(state, spec);
      state.sessions = [...state.sessions, session];
      emit(state, { type: 'session-created', session });
      window.setTimeout(() => {
        const live = find(session.id);
        if (!live || live.status !== 'connecting') return;
        live.status = 'connected';
        live.metadata = {
          ...live.metadata,
          os: {
            hostname: spec.kind === 'ssh' ? spec.target.host : PLATFORM.hostname,
            os: spec.kind === 'ssh' ? 'Ubuntu' : 'Windows 11 Pro',
            user: live.metadata.os.user,
            shell: spec.kind === 'ssh' ? '/bin/bash' : 'powershell.exe',
            probedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
        emit(state, { type: 'session-updated', session: live });
        emit(state, { type: 'session-metadata', id: live.id, metadata: live.metadata });
        emit(state, { type: 'session-output', id: live.id, data: banner(live) + promptFor(live) });
      }, 450);
      return session;
    },

    async closeSession(id: string) {
      state.sessions = state.sessions.filter((session) => session.id !== id);
      state.buffers.delete(id);
      state.prompts.delete(id);
      state.nested.delete(id);
      emit(state, { type: 'session-closed', id, code: 0 });
    },

    async renameSession(id: string, title: string) {
      const session = find(id);
      if (!session) return;
      session.title = title;
      emit(state, { type: 'session-updated', session });
    },

    async writeSession(id: string, data: string) {
      const session = find(id);
      if (!session || (session.status !== 'connected' && session.status !== 'connecting')) return;
      handleInput(state, session, data);
    },

    async resizeSession(id: string, cols: number, rows: number) {
      const session = find(id);
      if (!session) return;
      session.cols = cols;
      session.rows = rows;
    },

    async attachSession(id: string): Promise<AttachSnapshot> {
      const session = find(id);
      const data = session ? banner(session) + promptFor(session, state.nested.get(id)) : '';
      return { data, cols: session?.cols ?? 118, rows: session?.rows ?? 30 };
    },

    async detachSession() {
      /* nothing to release in the mock */
    },

    async probeSession(id: string) {
      const session = find(id);
      if (!session) throw new Error(`unknown session ${id}`);
      const probedAt = Date.now();
      session.metadata = {
        ...session.metadata,
        os: { ...session.metadata.os, probedAt, probeError: undefined },
        updatedAt: probedAt,
      };
      session.probe = { ...session.probe, lastAt: probedAt, lastError: undefined };
      emit(state, { type: 'session-metadata', id, metadata: session.metadata });
      return session.metadata;
    },

    async execInSession(): Promise<ExecResult> {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return { code: 0, stdout: 'demo output', stderr: '', timedOut: false };
    },

    /*
     * The demo has no real prompts, so an `ssh` line stands in for one: the
     * popover shows up exactly as it would after a login that landed, which is
     * what makes it reviewable in `npm run dev:web`.
     */
    async respondCredential(id: string, decision: 'accept' | 'dismiss') {
      const session = find(id);
      if (!session) return;
      emit(state, { type: 'session-credential', id, request: null });
      if (decision !== 'accept') return;
      // The demo keeps the password as well, so the saved list on the settings
      // page grows from a demo login exactly as it does from a real one.
      const target = state.credentialTargets.get(id);
      if (target) {
        const now = Date.now();
        const credentials = upsertCredential(state.settings.vault.credentials, {
          id: `cred-demo-${state.seq}`,
          username: target.username,
          host: target.host,
          password: 'demo-password',
          createdAt: now,
          updatedAt: now,
        });
        state.settings = { ...state.settings, vault: { credentials } };
        emit(state, { type: 'settings-updated', settings: state.settings });
      }
      emit(state, {
        type: 'session-output',
        id,
        data: `\r\ndemo: password kept\r\n${state.prompts.get(id) ?? ''}`,
      });
    },

    /* The demo answers the editor's test button after a beat, so the pending
       state is visible; a host that reads like a failure fails. */
    async testConnection(spec: SessionSpecSsh) {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      const { host, port } = spec.target;
      if (!host.trim()) return { ok: false as const, error: 'Host is required' };
      if (/invalid|unreachable|fail/i.test(host)) {
        return { ok: false as const, error: `connect ECONNREFUSED ${host}:${port}` };
      }
      return { ok: true as const };
    },

    async getSettings() {
      return state.settings;
    },

    async updateSettings(patch: DeepPartial<Settings>) {
      const next = { ...state.settings } as Settings;
      const source = patch as unknown as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (value === undefined) continue;
        const current = (state.settings as unknown as Record<string, unknown>)[key];
        const mergeable =
          typeof value === 'object' && value !== null && !Array.isArray(value) &&
          typeof current === 'object' && current !== null && !Array.isArray(current);
        (next as unknown as Record<string, unknown>)[key] = mergeable
          ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
          : value;
      }
      state.settings = next;
      emit(state, { type: 'settings-updated', settings: next });
      return next;
    },

    async applyIdentity(): Promise<ApplyIdentityResult> {
      const path = `C:\\Program Files\\EasyShell\\${state.settings.identity.alias}.exe`;
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      state.settings = {
        ...state.settings,
        identity: { ...state.settings.identity, lastAppliedPath: path, lastAppliedAt: Date.now() },
      };
      emit(state, { type: 'settings-updated', settings: state.settings });
      return {
        ok: true,
        path,
        messageKey: 'settings.identity.result.ok',
        params: { path },
        portable: false,
      };
    },

    async revealIdentity() {
      /* the mock has nothing to reveal */
    },

    async listWslDistributions() {
      return ['Ubuntu', 'docker-desktop'];
    },

    async pickPrivateKeyFile() {
      // No native dialog in the browser: hand back a plausible Windows path.
      return 'C:\\Users\\demo\\.ssh\\easyshell_deploy_ed25519';
    },

    async readClipboardText() {
      // In the browser preview the real clipboard may be readable; when the
      // permission is refused there is simply nothing to paste.
      try {
        return (await navigator.clipboard?.readText?.()) ?? '';
      } catch {
        return '';
      }
    },

    async getWindowState(): Promise<WindowBridgeState> {
      return { maximized: state.maximized, fullscreen: false, platform: PLATFORM.os };
    },

    async windowMinimize() {
      /* no window in the browser */
    },

    async windowToggleMaximize() {
      state.maximized = !state.maximized;
      return state.maximized;
    },

    async windowClose() {
      /* no window in the browser */
    },

    onEvent(listener: (event: SessionEvent) => void) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },

    /* ------------------------------------------------------------- agent */

    async listAgentTasks() {
      return state.agentTasks;
    },

    async detectAgentClis() {
      // A plausible mix so the preview shows every card state at once.
      const detections: AgentCliDetection[] = [
        {
          id: 'claude-code',
          state: 'available',
          command: 'C:\\Users\\demo\\AppData\\Roaming\\npm\\claude-agent-acp.cmd',
          args: [],
          install: 'npm install -g @zed-industries/claude-agent-acp',
        },
        {
          id: 'codex',
          state: 'adapter-missing',
          command: '',
          args: [],
          install: 'npm install -g codex-acp',
          hostCommand: 'C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd',
        },
        {
          id: 'opencode',
          state: 'available',
          command: 'C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd',
          args: ['acp'],
          install: 'npm install -g opencode-ai',
        },
        {
          id: 'codebuddy',
          state: 'available',
          command: 'C:\\Users\\demo\\AppData\\Roaming\\npm\\codebuddy.cmd',
          args: ['--acp'],
          install: 'npm install -g @tencent-ai/codebuddy-code',
        },
        {
          id: 'trae',
          state: 'available',
          command: 'C:\\Users\\demo\\AppData\\Local\\Programs\\TraeCLI\\bin\\traecli.cmd',
          args: ['acp', 'serve'],
          install: '',
        },
      ];
      return detections;
    },

    async createAgentTask(title?: string, options?: AgentTaskOptions) {
      state.agentSeq += 1;
      const now = Date.now();
      const mode = options?.mode === 'project' ? 'project' : 'temp';
      const task: AgentTaskInfo = {
        id: `task-demo-${String(state.agentSeq).padStart(2, '0')}`,
        title: title?.trim() || `Demo task ${state.agentSeq}`,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        agentName: state.settings.agent.command,
        commandCount: 0,
        mode,
        cwd:
          mode === 'project'
            ? options?.cwd ?? 'D:\\workspace\\demo-project'
            : 'C:\\Users\\demo\\.easyshell',
      };
      state.agentTasks = [...state.agentTasks, task];
      emitAgent(state, { type: 'agent-task', task });
      return task;
    },

    async resumeAgentTask() {
      /* the mock keeps its transcript in memory, so there is nothing to load */
    },

    async pickProjectDirectory() {
      // No native dialog in the browser: hand back a plausible project path.
      return 'D:\\workspace\\demo-project';
    },

    async closeAgentTask(id: string) {
      state.agentTasks = state.agentTasks.filter((task) => task.id !== id);
      state.agentMessages.delete(id);
      emitAgent(state, { type: 'agent-task-removed', taskId: id });
    },

    async promptAgent(taskId: string, text: string) {
      const task = state.agentTasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`unknown agent task ${taskId}`);
      const at = Date.now();
      pushAgentMessage(state, {
        id: `${taskId}:user:${at}`,
        taskId,
        role: 'user',
        text,
        at,
      });
      pushAgentMessage(state, {
        id: `${taskId}:demo:${at}`,
        taskId,
        role: 'system',
        // The demo has no agent process: say so in the reader's language
        // instead of faking an answer.
        text: translate(resolveLocale(state.settings.locale, PLATFORM.locale), 'agent.demoNoAgent'),
        at: at + 1,
      });
      task.status = 'idle';
      task.updatedAt = at;
      emitAgent(state, { type: 'agent-task', task });

      // The demo has no gate, but the approval panel is part of the
      // conversation: `approve` in the prompt shows one, in the same shape a
      // real gate produces. Answering it resolves locally.
      if (/\bapprove\b/i.test(text)) {
        task.status = 'waiting';
        task.updatedAt = at + 2;
        emitAgent(state, { type: 'agent-task', task });
        emitAgent(state, {
          type: 'agent-approval',
          request: {
            id: `demo-approval:${at}`,
            taskId,
            toolCallId: 'demo-call',
            title: 'touch /opt/demo',
            command: 'touch /opt/demo && ls -ld /opt/demo',
            sessionLabel: `root@${SSH_OUTER_HOST} (ssh)`,
            risk: 'write',
            reason: 'writes a file outside the home directory',
            mode: state.settings.agent.permissionMode,
            createdAt: at + 2,
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      }
    },

    async cancelAgent(taskId: string) {
      const task = state.agentTasks.find((item) => item.id === taskId);
      if (!task) return;
      task.status = 'idle';
      task.updatedAt = Date.now();
      emitAgent(state, { type: 'agent-task', task });
    },

    async getAgentTranscript(taskId: string): Promise<AgentTranscript> {
      return {
        messages: state.agentMessages.get(taskId) ?? [],
        toolCalls: [],
      };
    },

    async respondAgentApproval() {
      /* the demo never asks for approval: nothing runs */
    },

    async setAgentFocus() {
      /* no gate in the demo to route commands into */
    },

    onAgentEvent(listener: (event: AgentEvent) => void) {
      state.agentListeners.add(listener);
      return () => {
        state.agentListeners.delete(listener);
      };
    },

    /* -------------------------------------------------------------- files */

    async sftpOrigin(sessionId: string) {
      const session = find(sessionId);
      if (!session) return null;
      const nested = session.metadata.endpoint.chain.length > 1;
      return {
        kind: session.kind,
        label: session.metadata.endpoint.chain[0]?.label ?? session.title,
        style: 'posix' as const,
        root: '/',
        home: DEMO_HOME,
        cwd: nested ? null : session.cwd ?? DEMO_HOME,
        canFollow: !nested,
        nested,
      };
    },

    async sftpList(_sessionId: string, path: string) {
      return { path, parent: demoParent(path), entries: demoEntries(path) };
    },

    async sftpMkdir(_sessionId: string, path: string) {
      if (demoFiles.has(path)) throw new Error(`${path} already exists`);
      demoFiles.set(path, { path, dir: true, size: 0, modifiedAt: Date.now() });
    },

    async sftpCreateFile(_sessionId: string, path: string) {
      if (demoFiles.has(path)) throw new Error(`${path} already exists`);
      demoFiles.set(path, { path, dir: false, size: 0, modifiedAt: Date.now() });
    },

    async sftpRename(_sessionId: string, from: string, to: string) {
      if (!demoFiles.has(from)) throw new Error(`${from} is not there any more`);
      const moves: Array<{ from: string; to: string; file: DemoFile }> = [];
      for (const [key, value] of demoFiles) {
        if (key !== from && !key.startsWith(`${from}/`)) continue;
        moves.push({ from: key, to: `${to}${key.slice(from.length)}`, file: value });
      }
      for (const move of moves) demoFiles.delete(move.from);
      for (const move of moves) demoFiles.set(move.to, { ...move.file, path: move.to });
    },

    async sftpRemove(_sessionId: string, paths: string[]) {
      for (const path of paths) {
        for (const key of [...demoFiles.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) demoFiles.delete(key);
        }
      }
    },

    async sftpUpload(sessionId: string, destDir: string, localPaths: string[]) {
      for (const localPath of localPaths) {
        const name = localPath.split(/[\\/]/).filter(Boolean).pop() ?? 'upload';
        const target = `${destDir.replace(/\/$/, '')}/${name}`;
        const total = 2048;
        const transfer = {
          id: `sftp-up-${Date.now()}-${name}`,
          sessionId,
          direction: 'upload' as const,
          name,
          target,
          bytes: 0,
          total,
          done: false,
        };
        emitSftp(state, { type: 'sftp-transfer', transfer });
        demoFiles.set(target, { path: target, dir: false, size: total, modifiedAt: Date.now() });
        // The demo has no bytes to move: the bar completes a moment later.
        setTimeout(
          () => emitSftp(state, { type: 'sftp-transfer', transfer: { ...transfer, bytes: total, done: true } }),
          220,
        );
      }
    },

    async sftpDownload(sessionId: string, paths: string[]) {
      const folder = 'C:\\Users\\demo\\Downloads';
      for (const path of paths) {
        const name = path.split('/').filter(Boolean).pop() ?? 'file';
        const total = 4096;
        const transfer = {
          id: `sftp-down-${Date.now()}-${name}`,
          sessionId,
          direction: 'download' as const,
          name,
          target: folder,
          bytes: 0,
          total,
          done: false,
        };
        emitSftp(state, { type: 'sftp-transfer', transfer });
        setTimeout(
          () => emitSftp(state, { type: 'sftp-transfer', transfer: { ...transfer, bytes: total, done: true } }),
          260,
        );
      }
      return folder;
    },

    async sftpPickFiles() {
      // A browser has no native dialog: this is the file the demo uploads.
      return ['C:\\Users\\demo\\Downloads\\release-notes.pdf'];
    },

    async sftpStage(_sessionId: string, paths: string[]) {
      return paths.map(
        (path) =>
          `C:\\Users\\demo\\AppData\\Local\\Temp\\easyshell\\${path.split('/').filter(Boolean).pop() ?? 'file'}`,
      );
    },

    sftpStartDrag() {
      /* the preview has no native drag to start */
    },

    async sftpRefreshCwd() {
      // No shell to ask in the browser: the sheet stays where it opened.
      return null;
    },

    async sftpFollowCwd() {
      // The browser preview has no terminal output to follow.
    },

    pathForFile() {
      // A file dropped into a plain browser carries no path.
      return '';
    },

    onSftpEvent(listener: (event: SftpEvent) => void) {
      state.sftpListeners.add(listener);
      return () => {
        state.sftpListeners.delete(listener);
      };
    },
  };

  return bridge;
}