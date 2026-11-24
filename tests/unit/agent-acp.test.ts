import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, AcpError, denyAllHost } from '../../src/main/agent/acp';
import type { AcpHostHandlers } from '../../src/main/agent/acp';

const agentPath = fileURLToPath(new URL('../fixtures/mock-acp-agent.mjs', import.meta.url));

interface Harness {
  connection: AcpConnection;
  calls: string[];
  text: string;
}

const open: AcpConnection[] = [];

function connect(
  overrides: Partial<AcpHostHandlers> = {},
  env: Record<string, string> = {},
): Harness {
  const calls: string[] = [];
  const harness = { calls, text: '' } as Harness;
  const host: AcpHostHandlers = {
    onUpdate: (_sessionId, update) => {
      const content = update.content as { text?: string } | undefined;
      if (typeof content?.text === 'string') harness.text += content.text;
    },
    requestPermission: (params) => {
      const command = (params.toolCall?.rawInput as { command?: string } | undefined)?.command;
      calls.push(`permission:${command ?? ''}`);
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } });
    },
    terminalCreate: (params) => {
      calls.push(`create:${params.command ?? ''}@${params.cwd ?? ''}`);
      return Promise.resolve({ terminalId: 'term-1' });
    },
    terminalOutput: () =>
      Promise.resolve({ output: 'hello from the terminal', truncated: false }),
    terminalWaitForExit: () => Promise.resolve({ exitCode: 0 }),
    terminalKill: () => Promise.resolve(null),
    terminalRelease: () => Promise.resolve(null),
    readTextFile: () => Promise.reject(new AcpError('no file access in this test', -32602)),
    ...overrides,
  };
  const connection = new AcpConnection({
    command: process.execPath,
    args: [agentPath],
    cwd: process.cwd(),
    env,
    host,
  });
  open.push(connection);
  harness.connection = connection;
  return harness;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.dispose();
});

describe('AcpConnection', () => {
  it('completes the handshake and exposes the agent identity', async () => {
    const harness = connect();
    await harness.connection.start();
    expect(harness.connection.agentName).toBe('mock-acp-agent');
    expect(harness.connection.agentVersion).toBe('0.0.1');
    expect(harness.connection.protocolVersion).toBe(1);

    const sessionId = await harness.connection.newSession(process.cwd());
    expect(sessionId).toBe('mock-session-1');
  });

  it('routes a permission request to the host and reports the answer back', async () => {
    const harness = connect();
    await harness.connection.start();
    const sessionId = await harness.connection.newSession(process.cwd());

    const stopReason = await harness.connection.prompt(sessionId, 'PERM:rm -rf /tmp/scratch');
    expect(stopReason).toBe('end_turn');
    expect(harness.calls).toContain('permission:rm -rf /tmp/scratch');
    expect(harness.text).toContain('outcome:allow');
  });

  it('runs a terminal job through create / wait / output / release', async () => {
    const harness = connect();
    await harness.connection.start();
    const sessionId = await harness.connection.newSession(process.cwd());

    await harness.connection.prompt(sessionId, 'RUN:uptime');
    expect(harness.calls).toContain('create:uptime@easyshell://session-a');
    expect(harness.text).toContain('ran:hello from the terminal:0');
  });

  it('hands a refused command back to the agent as an error, not a hang', async () => {
    const harness = connect({
      terminalCreate: () => Promise.reject(new AcpError('command not run: read-only mode', -32001)),
    });
    await harness.connection.start();
    const sessionId = await harness.connection.newSession(process.cwd());

    const stopReason = await harness.connection.prompt(sessionId, 'RUN:rm -rf /');
    expect(stopReason).toBe('end_turn');
    expect(harness.text).toContain('failed:command not run: read-only mode');
  });

  it('gives the classifier a session that cannot run anything', async () => {
    const harness = connect({ terminalCreate: denyAllHost().terminalCreate });
    await harness.connection.start();
    const sessionId = await harness.connection.newSession(process.cwd());

    await harness.connection.prompt(sessionId, 'RUN:uptime');
    expect(harness.text).toContain('failed:this session may not call terminal/create');
  });

  it('rejects a request once the agent process is gone', async () => {
    const harness = connect();
    await harness.connection.start();
    harness.connection.dispose();
    await expect(harness.connection.newSession(process.cwd())).rejects.toThrow(
      'not running',
    );
  });

  it('records whether the agent can reopen a session', async () => {
    const harness = connect();
    await harness.connection.start();
    expect(harness.connection.supportsLoadSession).toBe(true);

    const limited = connect({}, { MOCK_ACP_NO_LOAD: '1' });
    await limited.connection.start();
    expect(limited.connection.supportsLoadSession).toBe(false);
    await expect(limited.connection.loadSession('mock-session-1', process.cwd())).rejects.toThrow(
      'session/load',
    );
  });

  it('replays the conversation when a stored session is loaded', async () => {
    const harness = connect();
    await harness.connection.start();
    await harness.connection.loadSession('mock-session-1', process.cwd());
    expect(harness.text).toContain('replayed hello');
  });
});

describe('AcpConnection through a Windows shim', () => {
  // `spawn('foo.cmd')` throws EINVAL, so the shim path is not hypothetical: it is
  // every npm-installed agent CLI on the platform this app ships to first.
  const windowsOnly = process.platform === 'win32' ? it : it.skip;

  windowsOnly('reads the batch shim and runs its script instead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyshell-shim-'));
    copyFileSync(agentPath, join(dir, 'mock-acp-agent.mjs'));
    const shim = join(dir, 'mock-acp.cmd');
    writeFileSync(shim, '@echo off\r\nnode "%~dp0mock-acp-agent.mjs" %*\r\n', 'utf8');

    const connection = new AcpConnection({
      command: shim,
      args: [],
      cwd: dir,
      env: {},
      host: denyAllHost(),
    });
    open.push(connection);
    try {
      await connection.start();
      expect(connection.agentName).toBe('mock-acp-agent');
    } finally {
      connection.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
