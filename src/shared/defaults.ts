import { createDefaultSsoSettings } from './sso';
import type { PlatformOs, Settings, ShellProfile } from './types';

export const SETTINGS_VERSION = 1;

export const API_DEFAULT_PORT = 37821;

/** Shell profiles that exist by default on each platform. */
export function defaultShellProfiles(os: PlatformOs): ShellProfile[] {
  if (os === 'win32') {
    return [
      { id: 'powershell', label: 'PowerShell', kind: 'local', command: 'powershell.exe', args: ['-NoLogo'] },
      { id: 'pwsh', label: 'PowerShell 7', kind: 'local', command: 'pwsh.exe', args: ['-NoLogo'] },
      { id: 'cmd', label: 'Command Prompt', kind: 'local', command: 'cmd.exe', args: [] },
    ];
  }
  if (os === 'darwin') {
    return [
      { id: 'zsh', label: 'zsh', kind: 'local', command: '/bin/zsh', args: ['-l'] },
      { id: 'bash', label: 'bash', kind: 'local', command: '/bin/bash', args: ['-l'] },
      { id: 'sh', label: 'sh', kind: 'local', command: '/bin/sh', args: [] },
    ];
  }
  return [
    { id: 'bash', label: 'bash', kind: 'local', command: '/bin/bash', args: ['-l'] },
    { id: 'zsh', label: 'zsh', kind: 'local', command: '/bin/zsh', args: ['-l'] },
    { id: 'sh', label: 'sh', kind: 'local', command: '/bin/sh', args: [] },
  ];
}

export function createDefaultSettings(os: PlatformOs): Settings {
  const profiles = defaultShellProfiles(os);
  return {
    version: SETTINGS_VERSION,
    locale: 'auto',
    appearance: {
      theme: 'system',
      colorScheme: 'easyshell',
      // The terminal face ships with the app: Sarasa Mono puts its CJK glyphs on
      // exactly two cells, which is what keeps Chinese output in columns.
      fontFamily: "'Sarasa Mono SC', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      /*
       * Sarasa Mono's Latin advance is half an em — 6.5px at 13px, against the
       * 7.15px of the Consolas it replaced — so the characters read as a column
       * of stems. xterm adds this to every cell and rounds it, so one pixel is
       * the smallest step that actually lands: 6.5 → 7.5px.
       */
      letterSpacing: 1,
      cursorStyle: 'bar',
      cursorBlink: true,
    },
    shell: {
      profiles,
      defaultProfileId: profiles[0]?.id ?? 'bash',
      wslDefaultDistribution: undefined,
    },
    ssh: {
      defaultPort: 22,
      hostKeyPolicy: 'accept-new',
      keepAliveSeconds: 30,
      profiles: [],
    },
    workspaces: [],
    // Remembered passwords are opt-in: empty until a login succeeds and the user
    // says yes to keeping the password.
    vault: { credentials: [] },
    // Nothing is turned off on a fresh install: every plugin runs with the
    // default it declares. The `sso` mapping starts on the USM shape.
    plugins: { disabled: [], sso: createDefaultSsoSettings() },
    probe: {
      enabled: true,
      intervalMs: 30_000,
      nestedDetection: true,
    },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port: API_DEFAULT_PORT,
      token: '',
    },
    identity: {
      alias: 'MobaXterm',
      companyName: 'Mobatek',
      productName: 'MobaXterm',
      fileDescription: 'MobaXterm',
      internalName: 'MobaXterm',
      originalFilename: 'MobaXterm.exe',
      legalCopyright: 'Copyright (C) 2008-2024 Mobatek',
      fileVersion: '24.2.0.0',
      productVersion: '24.2',
      macBundleIdentifier: 'com.mobatek.mobaxterm',
      macBundleName: 'MobaXterm',
      linuxProcessName: 'mobaxterm',
    },
    agent: {
      // Off until the user names an agent CLI: there is no default we can assume.
      enabled: false,
      command: '',
      args: [],
      env: {},
      permissionMode: 'ask',
      commandTimeoutMs: 120_000,
      classifyTimeoutMs: 20_000,
      contextTailLines: 30,
    },
    layout: { sidebarCollapsed: false, sessionOrder: [] },
    // A wide default: the composer, the transcript and the terminal all read
    // better with room, and a fresh install should start at its best shape -
    // wide enough for the docked sheet beside a terminal that still holds a
    // full line of output.
    window: { width: 1580, height: 900 },
  };
}
