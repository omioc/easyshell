import { describe, expect, it } from 'vitest';
import {
  buildAgentPromptContext,
  buildClassifierPrompt,
  commandFromToolInput,
  commandKey,
  decideAgentAction,
  parseRiskVerdict,
  stripAnsi,
  tailLines,
  toolCallTarget,
} from '../../src/shared/agent';
import type { AgentPermissionMode, AgentRiskState, SessionInfo } from '../../src/shared/types';

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    kind: 'ssh',
    title: id,
    status: 'connected',
    createdAt: 0,
    lastActivityAt: 0,
    cols: 80,
    rows: 24,
    origin: { type: 'ui' },
    metadata: {
      endpoint: {
        kind: 'ssh',
        displayName: `root@${id}`,
        host: id,
        username: 'root',
        source: 'session',
        chain: [
          { label: 'bastion', host: '198.18.0.1', detectedBy: 'session', confidence: 'high', at: 0 },
          { label: 'inner', host: id, detectedBy: 'probe', confidence: 'high', at: 0 },
        ],
      },
      os: {},
      extra: {},
      updatedAt: 0,
    },
    probe: { enabled: true, intervalMs: 30_000 },
    attachedClients: 0,
    bufferBytes: 0,
    ...overrides,
  };
}

describe('decideAgentAction', () => {
  const table: Array<[AgentPermissionMode, AgentRiskState, string]> = [
    ['read-only', 'read', 'allow'],
    ['read-only', 'write', 'deny'],
    ['read-only', 'destructive', 'deny'],
    ['ask', 'read', 'allow'],
    ['ask', 'write', 'ask'],
    ['ask', 'destructive', 'ask'],
    ['auto', 'read', 'allow'],
    ['auto', 'write', 'allow'],
    ['auto', 'destructive', 'ask'],
    ['unrestricted', 'read', 'allow'],
    ['unrestricted', 'write', 'allow'],
    ['unrestricted', 'destructive', 'allow'],
  ];

  it('maps every mode and verdict onto run / ask / deny', () => {
    for (const [mode, risk, expected] of table) {
      expect(decideAgentAction(mode, risk), `${mode}/${risk}`).toBe(expected);
    }
  });

  it('treats an unknown verdict as destructive', () => {
    expect(decideAgentAction('read-only', 'unknown')).toBe('deny');
    expect(decideAgentAction('ask', 'unknown')).toBe('ask');
    expect(decideAgentAction('auto', 'unknown')).toBe('ask');
    expect(decideAgentAction('unrestricted', 'unknown')).toBe('allow');
  });
});

describe('parseRiskVerdict', () => {
  it('reads the json answer', () => {
    expect(parseRiskVerdict('{"risk":"read","reason":"only lists files"}')).toEqual({
      risk: 'read',
      reason: 'only lists files',
      degraded: false,
    });
  });

  it('accepts a bare word', () => {
    expect(parseRiskVerdict('Destructive')).toEqual({ risk: 'destructive', reason: '', degraded: false });
  });

  it('finds the json inside surrounding prose', () => {
    const answer = 'Sure.\n{"risk":"write","reason":"writes one file"}\nDone.';
    expect(parseRiskVerdict(answer).risk).toBe('write');
  });

  it('degrades to destructive when nothing usable came back', () => {
    for (const raw of ['', 'I cannot help with that', '{"risk":"maybe"}', '{"reason":"x"}', 'null']) {
      const verdict = parseRiskVerdict(raw);
      expect(verdict.risk, raw).toBe('destructive');
      expect(verdict.degraded).toBe(true);
    }
  });

  it('never accepts a verdict outside the three classes', () => {
    expect(parseRiskVerdict('{"risk":"harmless"}').risk).toBe('destructive');
  });
});

describe('classifier prompt', () => {
  it('carries the command and the terminal it targets', () => {
    const prompt = buildClassifierPrompt('rm -rf /var/log/*', 'root@198.18.0.7 (ssh)');
    expect(prompt).toContain('rm -rf /var/log/*');
    expect(prompt).toContain('root@198.18.0.7 (ssh)');
    expect(prompt).toContain('"destructive"');
  });

  it('asks for the reason in the language the app is showing', () => {
    expect(buildClassifierPrompt('ls -l', 'root@198.18.0.7 (ssh)', 'zh')).toContain(
      'in Simplified Chinese',
    );
    expect(buildClassifierPrompt('ls -l', 'root@198.18.0.7 (ssh)', 'en')).toContain('in English');
    // Defaulting to English keeps the prompt usable from tests and older call sites.
    expect(buildClassifierPrompt('ls -l', 'root@198.18.0.7 (ssh)')).toContain('in English');
  });
});

describe('terminal text', () => {
  it('strips colors and cursor movement', () => {
    const raw = '\u001b[31mred\u001b[0m and \u001b[2K\u001b[1Gplain';
    expect(stripAnsi(raw)).toBe('red and plain');
  });

  it('strips window title sequences', () => {
    expect(stripAnsi('\u001b]0;title\u0007root@host:~$ ')).toBe('root@host:~$ ');
  });

  it('keeps the last lines and drops the trailing blank ones', () => {
    expect(tailLines('a\nb\nc\n\n', 2)).toBe('b\nc');
    expect(tailLines('a\r\nb\r\n', 5)).toBe('a\nb');
    expect(tailLines('', 5)).toBe('');
  });
});

describe('buildAgentPromptContext', () => {
  const sessions = [session('198.18.0.7'), session('198.18.0.9', { kind: 'local', title: 'PowerShell' })];

  it('lists the live terminals and marks the focused one', () => {
    const context = buildAgentPromptContext({
      mode: 'ask',
      sessions,
      focusedSessionId: '198.18.0.9',
      tails: { '198.18.0.9': 'PS C:\\> dir' },
    });
    expect(context).toContain('id=198.18.0.7');
    expect(context).toContain('id=198.18.0.9');
    expect(context).toContain('[focused]');
    expect(context).toContain('| PS C:\\> dir');
    expect(context).toContain('chain=');
  });

  it('states the rule of the mode', () => {
    const readOnly = buildAgentPromptContext({ mode: 'read-only', sessions, focusedSessionId: null });
    expect(readOnly).toContain('Permission mode: read-only');
    expect(readOnly).toContain('blocked before it runs');

    const auto = buildAgentPromptContext({ mode: 'auto', sessions, focusedSessionId: null });
    expect(auto).toContain('wait until the user approves');
  });

  it('always explains how to address a terminal', () => {
    const context = buildAgentPromptContext({ mode: 'ask', sessions, focusedSessionId: null });
    // Three routes, in the order the agent should try them: the MCP tool (works
    // with every adapter), a standard ACP terminal request, and the older
    // `cwd` convention an adapter may forward verbatim.
    expect(context).toContain('terminal_run');
    expect(context).toContain('_meta.easyshell.terminal');
    expect(context).toContain('easyshell://<id>');
    expect(context).toContain('without a TTY');
    // The contract has to say what to do when neither route is available: say
    // so, never answer from the desktop the agent happens to run on.
    expect(context).toContain('If neither route is available');
  });

  it('hands the agent the working directory it may read', () => {
    const withDir = buildAgentPromptContext({
      mode: 'ask',
      sessions,
      focusedSessionId: null,
      workDir: 'C:\\work\\my-project',
    });
    // Picking a directory has to mean something: the agent may read it, which
    // is how it learns what to run from the project's own notes.
    expect(withDir).toContain('C:\\work\\my-project');
    expect(withDir).toContain('may read files inside it');
    expect(withDir).not.toContain('file tools are disabled');
    // Reading a local file is context for a command, never the target machine.
    expect(withDir).toContain('never the state of the target machine');

    const withoutDir = buildAgentPromptContext({ mode: 'ask', sessions, focusedSessionId: null });
    expect(withoutDir).toContain('no working directory');
    expect(withoutDir).toContain('refused');
  });

  it('says so when no terminal is open', () => {
    const context = buildAgentPromptContext({ mode: 'ask', sessions: [], focusedSessionId: null });
    expect(context).toContain('Live terminals: none');
  });
});

describe('command helpers', () => {
  it('keys a command by terminal and normalised text', () => {
    expect(commandKey('s1', '  ls   -la ')).toBe(commandKey('s1', 'ls -la'));
    expect(commandKey('s1', 'ls -la')).not.toBe(commandKey('s2', 'ls -la'));
  });

  it('digs the command out of a tool call payload', () => {
    expect(commandFromToolInput({ command: 'df -h' }, 'fallback')).toBe('df -h');
    expect(commandFromToolInput({ cmd: 'uname -a' }, 'fallback')).toBe('uname -a');
    expect(commandFromToolInput({ args: ['systemctl', 'status', 'nginx'] }, '')).toBe(
      'systemctl status nginx',
    );
    expect(commandFromToolInput(undefined, 'echo hi')).toBe('echo hi');
    expect(commandFromToolInput({}, '  ls  ')).toBe('ls');
  });

  it('reads a call that nests its command and terminal in MCP arguments', () => {
    // The shape Trae sends for our own bridge: nothing runnable at the top level.
    const trae = {
      server: 'easyshell1',
      tool: 'terminal_run',
      arguments: { session_id: 'session-a', command: 'rmdir /opt/test' },
    };
    expect(toolCallTarget(trae)).toEqual({ command: 'rmdir /opt/test', terminal: 'session-a' });
    expect(commandFromToolInput(trae, '')).toBe('rmdir /opt/test');

    // The three container names, and argv one level down.
    expect(toolCallTarget({ input: { cmd: 'df -h' } }).command).toBe('df -h');
    expect(toolCallTarget({ params: { args: ['systemctl', 'status', 'nginx'] } }).command).toBe(
      'systemctl status nginx',
    );
    // A terminal named beside the container still counts.
    expect(toolCallTarget({ terminal: 'session-b', arguments: { command: 'ls' } })).toEqual({
      command: 'ls',
      terminal: 'session-b',
    });

    // A tool that names no command is not a command: `query` is not `command`.
    expect(toolCallTarget({ arguments: { query: 'terminal_run' } })).toEqual({ command: '' });
    // One level only: a tree of arguments is not a command form we guess at.
    expect(toolCallTarget({ arguments: { arguments: { command: 'ls' } } }).command).toBe('');
  });
});
