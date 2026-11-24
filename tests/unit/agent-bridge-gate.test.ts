import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../src/shared/defaults';
import { translate } from '../../src/shared/i18n';
import type { AgentEvent, AgentPermissionMode, Locale, PlatformOs, SessionInfo, Settings } from '../../src/shared/types';
import { AgentManager } from '../../src/main/agent/manager';
import { AgentBridge } from '../../src/main/mcp/bridge';
import type { SessionManager } from '../../src/main/session/manager';

/**
 * The bridge and the manager wired the way `src/main/index.ts` wires them.
 *
 * `terminal_run` is the route the app tells the agent to prefer, and it used to
 * run whatever it was handed in any permission mode: the gate only stood in
 * front of ACP `terminal/create`. These tests go through the real HTTP door, the
 * real task, and the real classifier, so a regression in any of the three is
 * caught here rather than by an agent deleting a directory.
 */
const agentPath = fileURLToPath(new URL('../fixtures/mock-acp-agent.mjs', import.meta.url));

const terminal = {
  id: 'session-a',
  kind: 'ssh',
  title: 'root@198.18.0.7',
  status: 'connected',
  metadata: { endpoint: { displayName: 'root@198.18.0.7', chain: [] } },
} as unknown as SessionInfo;

let root = '';
let runs: string[] = [];

const sessions = {
  list: () => [terminal],
  get: () => terminal,
  attach: () => null,
  focus: () => undefined,
  exec: () => Promise.reject(new Error('unexpected exec')),
  runCommand: (_id: string, command: string) => {
    runs.push(command);
    return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
  },
} as unknown as SessionManager;

function settings(mode: AgentPermissionMode): Settings {
  const base = createDefaultSettings(process.platform as PlatformOs);
  return {
    ...base,
    agent: {
      ...base.agent,
      enabled: true,
      permissionMode: mode,
      command: process.execPath,
      args: [agentPath],
      env: {},
    },
  };
}

/** One manager, one bridge, one connected task. */
async function wire(mode: AgentPermissionMode, locale: Locale = 'en') {
  const events: AgentEvent[] = [];
  const manager = new AgentManager({
    getSettings: () => settings(mode),
    // The manager quotes its own reasons through this; the UI language decides.
    getLocale: () => locale,
    sessions,
    tempDir: join(root, '.easyshell'),
    tasksFile: join(root, `tasks-${mode}.json`),
    emit: (event) => events.push(event),
  });
  const bridge = new AgentBridge({
    sessions,
    getSettings: () => settings(mode),
    focused: () => terminal.id,
    authorize: (input) => manager.authorizeBridgeCommand(input),
  });
  const endpoint = await bridge.start();
  if (!endpoint) throw new Error('the bridge did not start');

  const task = manager.create();
  await manager.prompt(task.id, 'hello');

  const run = (command: string) =>
    fetch(`${endpoint.url}/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
        'x-easyshell-task': task.id,
      },
      body: JSON.stringify({ command, sessionId: terminal.id }),
    });

  return {
    manager,
    bridge,
    run,
    events,
    async close() {
      manager.shutdown();
      await bridge.stop();
    },
  };
}

async function approvalCard(events: AgentEvent[], withinMs = 5000): Promise<AgentEvent | undefined> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const raised = events.find((event) => event.type === 'agent-approval');
    if (raised) return raised;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'easyshell-gate-'));
  runs = [];
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* a leftover temp directory must not fail the suite */
  }
});

describe('terminal_run behind the permission gate', () => {
  it('holds the command for the user, and runs nothing when they deny it', async () => {
    const wired = await wire('ask');
    try {
      const pending = wired.run('rm -rf /opt/test');

      const raised = await approvalCard(wired.events);
      if (raised?.type !== 'agent-approval') throw new Error('no approval card was raised');
      expect(raised.request.command).toBe('rm -rf /opt/test');
      expect(raised.request.sessionId).toBe(terminal.id);
      expect(raised.request.mode).toBe('ask');

      wired.manager.respond(raised.request.id, 'reject');
      const response = await pending;

      expect(response.status).toBe(403);
      expect(runs).toHaveLength(0);
    } finally {
      await wired.close();
    }
  }, 60_000);

  it('runs the command once the user allows it', async () => {
    const wired = await wire('ask');
    try {
      const pending = wired.run('df -h');

      const raised = await approvalCard(wired.events);
      if (raised?.type !== 'agent-approval') throw new Error('no approval card was raised');

      wired.manager.respond(raised.request.id, 'allow');
      const response = await pending;

      expect(response.status).toBe(200);
      expect(runs).toEqual(['df -h']);
    } finally {
      await wired.close();
    }
  }, 60_000);

  it('refuses a write in read-only mode without asking', async () => {
    const wired = await wire('read-only');
    try {
      const response = await wired.run('rm -rf /opt/test');

      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(403);
      // Nothing to classify (the mock agent answers no verdict), so the mode is
      // what the refusal is attributed to, in the language the app shows.
      expect(body['error']).toBe(translate('en', 'agent.gate.readOnly'));
      expect(wired.events.some((event) => event.type === 'agent-approval')).toBe(false);
      expect(runs).toHaveLength(0);
    } finally {
      await wired.close();
    }
  }, 60_000);

  it('lets a command through untouched in unrestricted mode', async () => {
    const wired = await wire('unrestricted');
    try {
      const response = await wired.run('uptime');

      expect(response.status).toBe(200);
      expect(wired.events.some((event) => event.type === 'agent-approval')).toBe(false);
      expect(runs).toEqual(['uptime']);
    } finally {
      await wired.close();
    }
  }, 60_000);

  it('writes the reason it reaches itself in the interface language', async () => {
    const wired = await wire('read-only', 'zh');
    try {
      const response = await wired.run('rm -rf /opt/test');
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(body['error']).toBe(translate('zh', 'agent.gate.readOnly'));
      expect(body['error']).not.toBe(translate('en', 'agent.gate.readOnly'));
    } finally {
      await wired.close();
    }
  }, 60_000);
});
