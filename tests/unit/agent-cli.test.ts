import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { AGENT_CLIS, isDetectedAgentSelected } from '../../src/shared/agents';
import type { AgentCliDetection } from '../../src/shared/agents';
import { LOCALE_LABELS, translate } from '../../src/shared/i18n';
import { detectAgentClis, expandDesktopPath } from '../../src/main/agent/detect';
import {
  findExecutable,
  parseShimEntry,
  parseShimExecutable,
  planLaunch,
} from '../../src/main/agent/launch';
import type { LaunchContext } from '../../src/main/agent/launch';

/** A fake file system: only the paths handed in exist. */
function lookup(platform: 'win32' | 'darwin' | 'linux', files: string[], pathEnv: string) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return {
    platform,
    pathEnv,
    pathExt: '.COM;.EXE;.BAT;.CMD',
    isFile: (path: string) => set.has(path.toLowerCase()),
  };
}

function launchContext(
  platform: 'win32' | 'darwin' | 'linux',
  overrides: Partial<LaunchContext> = {},
): LaunchContext {
  return {
    platform,
    pathEnv: '',
    pathExt: '.EXE;.CMD',
    isFile: () => false,
    execPath: platform === 'win32' ? 'C:\\app\\EasyShell.exe' : '/app/easyshell',
    nodePath: null,
    readFile: () => '',
    ...overrides,
  };
}

const detection = (overrides: Partial<AgentCliDetection> = {}): AgentCliDetection => ({
  id: 'gemini',
  state: 'available',
  command: join('C:', 'tools', 'gemini.cmd'),
  args: ['--acp'],
  install: 'npm install -g @google/gemini-cli',
  ...overrides,
});

describe('agent CLI catalog', () => {
  it('lists the five agents once each', () => {
    expect(AGENT_CLIS).toHaveLength(5);
    expect(new Set(AGENT_CLIS.map((entry) => entry.id)).size).toBe(5);
    expect(AGENT_CLIS.map((entry) => entry.name)).toEqual([
      'Claude Code',
      'Codex',
      'OpenCode',
      'CodeBuddy',
      'Trae',
    ]);
  });

  it('has a description for every card in both locales', () => {
    for (const locale of Object.keys(LOCALE_LABELS) as Array<keyof typeof LOCALE_LABELS>) {
      for (const entry of AGENT_CLIS) {
        const text = translate(locale, entry.descriptionKey);
        expect(text, `${locale}/${entry.id}`).not.toBe(entry.descriptionKey);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists only agents that can actually be started', () => {
    // The flag stays in the model for cards that are wanted before they become
    // startable; today every entry has an ACP entry point.
    expect(AGENT_CLIS.filter((entry) => !entry.acp)).toEqual([]);
  });
});

describe('detectAgentClis', () => {
  it('reports what PATH actually holds', () => {
    const files = [
      join('C:', 'bin', 'opencode.cmd'),
      join('C:', 'bin', 'claude.exe'),
      join('C:', 'bin', 'trae.exe'),
    ];
    const found = detectAgentClis(lookup('win32', files, join('C:', 'bin')));

    const byId = Object.fromEntries(found.map((entry) => [entry.id, entry]));
    expect(byId.opencode?.state).toBe('available');
    expect(byId.opencode?.command).toBe(join('C:', 'bin', 'opencode.cmd'));
    expect(byId.opencode?.args).toEqual(['acp']);

    // The CLI is there, the ACP adapter is not: the card can say what to install.
    expect(byId['claude-code']?.state).toBe('adapter-missing');
    expect(byId['claude-code']?.hostCommand).toBe(join('C:', 'bin', 'claude.exe'));

    expect(byId.codex?.state).toBe('missing');

    // CodeBuddy is not on this PATH either: a plain miss, not a downgrade.
    expect(byId.codebuddy?.state).toBe('missing');
    expect(byId.codebuddy?.command).toBe('');

    // `trae.exe` is not one of Trae's shims, so this is a plain miss.
    expect(byId.trae?.state).toBe('missing');
    expect(byId.trae?.command).toBe('');
  });

  it('resolves each agent through its own ACP entry point on posix', () => {
    const dir = '/usr/local/bin';
    const files = ['codex-acp', 'opencode', 'claude-agent-acp'].map((bin) => join(dir, bin));
    const found = detectAgentClis(lookup('linux', files, dir));
    const available = found.filter((entry) => entry.state === 'available');

    expect(available.map((entry) => entry.id)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(available.find((entry) => entry.id === 'opencode')?.args).toEqual(['acp']);
  });

  it('starts Trae CLI through its own acp serve subcommand', () => {
    const dir = join('C:', 'Users', 'demo', 'AppData', 'Local', 'Programs', 'TraeCLI', 'bin');
    const shim = join(dir, 'traecli.cmd');
    const found = detectAgentClis(lookup('win32', [shim], dir));
    const trae = found.find((entry) => entry.id === 'trae');

    expect(trae?.state).toBe('available');
    expect(trae?.command).toBe(shim);
    expect(trae?.args).toEqual(['acp', 'serve']);
  });

  it('starts CodeBuddy through its own --acp flag', () => {
    const dir = join('C:', 'Users', 'demo', 'AppData', 'Roaming', 'npm');
    const shim = join(dir, 'codebuddy.cmd');
    const found = detectAgentClis(lookup('win32', [shim], dir));
    const codebuddy = found.find((entry) => entry.id === 'codebuddy');

    expect(codebuddy?.state).toBe('available');
    expect(codebuddy?.command).toBe(shim);
    expect(codebuddy?.args).toEqual(['--acp']);
  });
});

describe('isDetectedAgentSelected', () => {
  it('matches the configured command by path, case-insensitively', () => {
    expect(
      isDetectedAgentSelected(detection(), {
        command: 'c:/TOOLS/gemini.cmd',
        args: ['--acp'],
      }),
    ).toBe(true);
  });

  it('matches a bare executable name against the detected path', () => {
    expect(isDetectedAgentSelected(detection(), { command: 'gemini', args: ['--acp'] })).toBe(true);
  });

  it('needs the same arguments and a command', () => {
    expect(isDetectedAgentSelected(detection(), { command: 'gemini', args: [] })).toBe(false);
    expect(isDetectedAgentSelected(detection(), { command: '', args: ['--acp'] })).toBe(false);
    expect(
      isDetectedAgentSelected(detection({ command: '' }), { command: 'gemini', args: ['--acp'] }),
    ).toBe(false);
  });

  it('does not confuse two different executables with the same name', () => {
    expect(
      isDetectedAgentSelected(detection(), { command: 'D:/other/gemini.cmd', args: ['--acp'] }),
    ).toBe(false);
  });
});

describe('findExecutable', () => {
  it('tries PATHEXT in order on Windows', () => {
    const dir = join('C:', 'bin');
    const found = findExecutable(
      ['gemini'],
      lookup('win32', [join(dir, 'gemini.cmd')], dir),
    );
    expect(found).toBe(join(dir, 'gemini.cmd'));
  });

  it('reports nothing when the directory holds something else', () => {
    expect(findExecutable(['gemini'], lookup('win32', [join('C:', 'bin', 'other.exe')], join('C:', 'bin')))).toBeNull();
  });

  it('uses the bare name when the candidate already has an extension', () => {
    const dir = join('C:', 'bin');
    const found = findExecutable(['gemini.cmd'], lookup('win32', [join(dir, 'gemini.cmd')], dir));
    expect(found).toBe(join(dir, 'gemini.cmd'));
  });
});

describe('parseShimEntry', () => {
  const shim = join('C:', 'Users', 'demo', 'AppData', 'Roaming', 'npm', 'gemini.cmd');

  it('reads the npm shim and resolves it next to the shim', () => {
    const text = [
      '@ECHO off',
      'SETLOCAL',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\..\\@google\\gemini-cli\\bundle\\gemini.js" %*',
    ].join('\r\n');

    expect(parseShimEntry(text, shim)).toBe(
      resolve(dirname(shim), '..', '@google', 'gemini-cli', 'bundle', 'gemini.js'),
    );
  });

  it('reads a shim that sits next to its script', () => {
    const localShim = join('C:', 'tmp', 'agent.cmd');
    expect(parseShimEntry('node "%~dp0agent.mjs" %*', localShim)).toBe(
      resolve(dirname(localShim), 'agent.mjs'),
    );
  });

  it('reads an npm shim whose bin has no extension', () => {
    const localShim = join('C:', 'Users', 'demo', 'AppData', 'Roaming', 'npm', 'codebuddy.cmd');
    // The real shim: `IF EXIST "%dp0%\node.exe"` first, then the extensionless bin.
    const text = [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & "%_prog%" "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*',
    ].join('\r\n');

    expect(parseShimEntry(text, localShim)).toBe(
      resolve(
        dirname(localShim),
        'node_modules',
        '@tencent-ai',
        'codebuddy-code',
        'bin',
        'codebuddy',
      ),
    );
  });

  it('gives up on a shim it does not recognise', () => {
    expect(parseShimEntry('@echo off\r\necho hi', shim)).toBeNull();
  });
});

describe('parseShimExecutable', () => {
  const dir = join('C:', 'Users', 'demo', 'AppData', 'Local', 'Programs', 'TraeCLI', 'bin');
  const shim = join(dir, 'traecli.cmd');

  it('reads a shim that only forwards to a sibling exe', () => {
    // The real traecli.cmd: two lines, one of them a plain echo-off.
    expect(parseShimExecutable('@echo off\r\n"%~dp0traex.exe" %*\r\n', shim)).toBe(
      resolve(dirname(shim), 'traex.exe'),
    );
  });

  it('accepts the unquoted and backslash forms', () => {
    expect(parseShimExecutable('"%~dp0\\traex.exe" %*', shim)).toBe(
      resolve(dirname(shim), 'traex.exe'),
    );
    expect(parseShimExecutable('@echo off\r\n%~dp0tools\\agent.exe %*\r\n', shim)).toBe(
      resolve(dirname(shim), 'tools', 'agent.exe'),
    );
  });

  it('leaves an npm shim and a batch file with work to do alone', () => {
    const npmShim = [
      '@ECHO off',
      'SETLOCAL',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\..\\gemini\\bundle\\gemini.js" %*',
    ].join('\r\n');
    expect(parseShimExecutable(npmShim, shim)).toBeNull();
    expect(parseShimExecutable('@echo off\r\necho hi\r\ntraex.exe %*', shim)).toBeNull();
    expect(parseShimExecutable('', shim)).toBeNull();
  });
});

describe('expandDesktopPath', () => {
  it('expands a %VAR% from the environment', () => {
    expect(
      expandDesktopPath('%LOCALAPPDATA%\\Programs\\OpenCode\\OpenCode.exe', {
        LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\demo\\AppData\\Local\\Programs\\OpenCode\\OpenCode.exe');
  });

  it('gives up when the variable is missing instead of building a broken path', () => {
    expect(expandDesktopPath('%NOT_SET_ANYWHERE%\\x.exe', {})).toBeNull();
  });

  it('expands a leading tilde', () => {
    expect(expandDesktopPath('~/.config/opencode', { HOME: '/home/demo' })).toBe(
      '/home/demo/.config/opencode',
    );
  });
});

describe('detectAgentClis desktop hint', () => {
  it('names the desktop app when the CLI is not installed', () => {
    const localAppData = join('C:', 'Users', 'demo', 'AppData', 'Local');
    const desktopExe = join(localAppData, 'Programs', '@opencode-aidesktop', 'OpenCode.exe');
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = localAppData;
    try {
      const found = detectAgentClis(lookup('win32', [desktopExe], join('C:', 'empty')));
      const opencode = found.find((entry) => entry.id === 'opencode');

      // Still not selectable: the GUI is not an ACP agent.
      expect(opencode?.state).toBe('missing');
      expect(opencode?.command).toBe('');
      expect(opencode?.desktopApp).toBe(desktopExe);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  });
});

describe('planLaunch', () => {
  const shim = join('C:', 'space test', 'gemini.cmd');
  const shimText = 'endLocal & "%_prog%" "%dp0%\\..\\gemini\\bundle\\gemini.js" %*';
  const entry = resolve(dirname(shim), '..', 'gemini', 'bundle', 'gemini.js');

  it('runs the shim script with node when node is on PATH', () => {
    const plan = planLaunch(
      shim,
      ['--acp'],
      launchContext('win32', {
        nodePath: 'C:\\node\\node.exe',
        readFile: () => shimText,
      }),
    );

    expect(plan).toEqual({
      command: 'C:\\node\\node.exe',
      args: [entry, '--acp'],
      env: {},
    });
  });

  it('falls back to the app runtime with ELECTRON_RUN_AS_NODE', () => {
    const plan = planLaunch(shim, ['--acp'], launchContext('win32', { readFile: () => shimText }));

    expect(plan.command).toBe('C:\\app\\EasyShell.exe');
    expect(plan.args).toEqual([entry, '--acp']);
    expect(plan.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('spawns native binaries directly', () => {
    const exe = join('C:', 'bin', 'gemini.exe');
    expect(planLaunch(exe, ['--acp'], launchContext('win32'))).toEqual({
      command: exe,
      args: ['--acp'],
      env: {},
    });
  });

  it('spawns the executable a forwarding shim names instead of cmd.exe', () => {
    const dir = join('C:', 'Users', 'demo', 'AppData', 'Local', 'Programs', 'TraeCLI', 'bin');
    const shim = join(dir, 'traecli.cmd');
    const plan = planLaunch(
      shim,
      ['acp', 'serve'],
      launchContext('win32', { readFile: () => '@echo off\r\n"%~dp0traex.exe" %*\r\n' }),
    );

    expect(plan).toEqual({
      command: resolve(dirname(shim), 'traex.exe'),
      args: ['acp', 'serve'],
      env: {},
    });
  });

  it('runs an extensionless npm bin with node instead of cmd.exe', () => {
    const dir = join('C:', 'Users', 'demo', 'AppData', 'Roaming', 'npm');
    const shim = join(dir, 'codebuddy.cmd');
    const text = [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & "%_prog%" "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*',
    ].join('\r\n');
    const plan = planLaunch(
      shim,
      ['--acp'],
      launchContext('win32', { nodePath: 'C:\\node\\node.exe', readFile: () => text }),
    );

    expect(plan).toEqual({
      command: 'C:\\node\\node.exe',
      args: [resolve(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'), '--acp'],
      env: {},
    });
  });

  it('does nothing special outside Windows', () => {
    expect(planLaunch('/usr/local/bin/gemini', ['--acp'], launchContext('darwin'))).toEqual({
      command: '/usr/local/bin/gemini',
      args: ['--acp'],
      env: {},
    });
  });
});
