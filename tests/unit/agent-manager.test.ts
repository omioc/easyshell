import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translate } from '../../src/shared/i18n';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultSettings } from '../../src/shared/defaults';
import type {
  AgentEvent,
  AgentPermissionMode,
  ExecResult,
  PlatformOs,
  SessionInfo,
  Settings,
} from '../../src/shared/types';
import { AgentManager } from '../../src/main/agent/manager';
import type { AcpMcpServer } from '../../src/main/agent/acp';
import type { SessionManager } from '../../src/main/session/manager';

const agentPath = fileURLToPath(new URL('../fixtures/mock-acp-agent.mjs', import.meta.url));

/** The manager only asks the session layer for a list and, on a command, an exec. */
const sessions = {
  list: () => [],
  attach: () => null,
  exec: () => Promise.reject(new Error('no terminals in this test')),
} as unknown as SessionManager;

let root = '';
const managers: AgentManager[] = [];

function makeSettings(
  env: Record<string, string> = {},
  enabled = true,
  permissionMode: AgentPermissionMode = 'ask',
): Settings {
  const base = createDefaultSettings(process.platform as PlatformOs);
  return {
    ...base,
    agent: {
      ...base.agent,
      enabled,
      permissionMode,
      command: process.execPath,
      args: [agentPath],
      env,
    },
  };
}

function make(
  env: Record<string, string> = {},
  options: {
    enabled?: boolean;
    /** A getter lets a test tighten the mode between two commands. */
    permissionMode?: AgentPermissionMode | (() => AgentPermissionMode);
    sessions?: SessionManager;
    mcpServers?: () => AcpMcpServer[];
  } = {},
) {
  const events: AgentEvent[] = [];
  const manager = new AgentManager({
    getSettings: () =>
      makeSettings(
        env,
        options.enabled ?? true,
        typeof options.permissionMode === 'function'
          ? options.permissionMode()
          : options.permissionMode,
      ),
    sessions: options.sessions ?? sessions,
    tempDir: join(root, '.easyshell'),
    tasksFile: join(root, 'agent-tasks.json'),
    emit: (event) => events.push(event),
    mcpServers: options.mcpServers,
  });
  managers.push(manager);
  return { manager, events };
}

function noticeKeys(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'agent-notice' ? [event.notice.key] : [],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'easyshell-agent-'));
});

afterEach(async () => {
  while (managers.length > 0) managers.pop()!.shutdown();
  // The agent processes are killed asynchronously and their cwd is inside
  // `root`, so Windows refuses the delete for a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* a leftover temp directory must not fail the suite */
  }
});

describe('AgentManager task directories', () => {
  it('gives a temp task the scratch directory and creates it', () => {
    const { manager } = make();
    const task = manager.create();

    expect(task.mode).toBe('temp');
    expect(task.cwd).toBe(join(root, '.easyshell'));
    expect(existsSync(task.cwd)).toBe(true);
  });

  it('refuses to create a session while the assistant is switched off', () => {
    const { manager } = make({}, { enabled: false });

    expect(() => manager.create()).toThrow(/switched off/);
    expect(manager.list()).toHaveLength(0);
  });

  it('keeps the directory a project task was given', () => {
    const { manager } = make();
    const project = mkdtempSync(join(root, 'proj-'));

    const task = manager.create(undefined, { mode: 'project', cwd: project });

    expect(task.mode).toBe('project');
    expect(task.cwd).toBe(project);
  });

  it('refuses a project task without an absolute directory', () => {
    const { manager } = make();

    expect(() => manager.create(undefined, { mode: 'project' })).toThrow(/directory/);
    expect(() =>
      manager.create(undefined, { mode: 'project', cwd: 'relative/project' }),
    ).toThrow(/absolute/);
  });
});

describe('the MCP bridge handed to the agent', () => {
  /**
   * The mock refuses `session/new` unless it received exactly `MCP_EXPECT`
   * servers, so a turn that succeeds is proof the list arrived.
   */
  const bridge = () => [
    { name: 'easyshell', command: '/usr/bin/node', args: ['mcp-server.js'], env: [] },
  ];

  function failed(events: AgentEvent[]): boolean {
    return events.some(
      (event) => event.type === 'agent-notice' && event.notice.key === 'agent.notice.agentFailed',
    );
  }

  it('is offered when one is configured', async () => {
    const { manager, events } = make({ MCP_EXPECT: '1' }, { mcpServers: bridge });
    const task = manager.create();

    await manager.prompt(task.id, 'hello');

    expect(failed(events)).toBe(false);
  });

  it('is what the check above is actually looking at', async () => {
    const { manager, events } = make({ MCP_EXPECT: '1' });
    const task = manager.create();

    await manager.prompt(task.id, 'hello');

    expect(failed(events)).toBe(true);
  });
});

/**
 * `terminal_run` is the route the app tells the agent to prefer, so it has to
 * pass the same gate as an ACP terminal request. Before this, the bridge ran
 * whatever it was handed, in any permission mode.
 */
describe('the gate behind terminal_run', () => {
  const terminal = {
    id: 'session-a',
    kind: 'ssh',
    title: 'root@198.18.0.7',
    status: 'connected',
    metadata: { endpoint: { displayName: 'root@198.18.0.7', chain: [] } },
  } as unknown as SessionInfo;

  const oneTerminal = () =>
    ({
      list: () => [terminal],
      get: (id: string) => (id === terminal.id ? terminal : null),
      attach: () => null,
      exec: () => Promise.reject(new Error('unexpected out-of-band exec')),
      runCommand: () => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }),
    }) as unknown as SessionManager;

  async function waitFor(check: () => AgentEvent | undefined, what: string): Promise<AgentEvent> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('asks the user in manual mode, and lets the command through when allowed', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();
    await manager.prompt(task.id, 'hello');

    const verdict = manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rm -rf /opt/test',
      sessionId: 'session-a',
    });
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    expect(raised.request.command).toBe('rm -rf /opt/test');
    expect(raised.request.sessionId).toBe('session-a');

    manager.respond(raised.request.id, 'allow');
    await expect(verdict).resolves.toMatchObject({ allowed: true });
  });

  it('blocks a write in read-only mode without asking', async () => {
    const { manager, events } = make({}, { permissionMode: 'read-only', sessions: oneTerminal() });
    const task = manager.create();
    await manager.prompt(task.id, 'hello');

    const verdict = await manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rm -rf /opt/test',
      sessionId: 'session-a',
    });

    expect(verdict.allowed).toBe(false);
    expect(events.some((event) => event.type === 'agent-approval')).toBe(false);
  });

  it('refuses a call from a task it cannot identify', async () => {
    const { manager } = make({}, { permissionMode: 'unrestricted', sessions: oneTerminal() });

    const verdict = await manager.authorizeBridgeCommand({
      taskId: 'ghost',
      command: 'df -h',
      sessionId: 'session-a',
    });

    expect(verdict.allowed).toBe(false);
  });

  it('hands the permission answer to the run it asked about, with no second card', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();

    // An adapter that asks first and executes through the bridge second: one
    // call, two gates, one question.
    const prompting = manager.prompt(task.id, 'PERM:rm -rf /opt/test');
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    manager.respond(raised.request.id, 'allow');
    await prompting;

    const ran = await manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rm -rf /opt/test',
      sessionId: 'session-a',
    });

    expect(ran.allowed).toBe(true);
    // Still cleared, so no second question — but the row keeps the sentence the
    // gate reached the first time rather than a bare "already approved".
    expect(ran.reason).toBe(raised.request.reason);
    expect(events.filter((event) => event.type === 'agent-approval')).toHaveLength(1);
  });

  it('asks again when the same command comes back as a new call', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();
    await manager.prompt(task.id, 'hello');

    const command = 'rmdir /opt/test && ls -ld /opt/test';
    const first = manager.authorizeBridgeCommand({
      taskId: task.id,
      command,
      sessionId: 'session-a',
    });
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    manager.respond(raised.request.id, 'allow');
    await expect(first).resolves.toMatchObject({ allowed: true });

    // The bridge is the only gate this command passes, so one approval must not
    // become a licence: running the same line again is a new question. Before
    // this, the second run went through with no card at all, which is exactly
    // the silent write a user in manual mode is watching for.
    const second = manager.authorizeBridgeCommand({
      taskId: task.id,
      command,
      sessionId: 'session-a',
    });
    const again = await waitFor(
      () => events.filter((event) => event.type === 'agent-approval')[1],
      'a second approval card',
    );
    if (again.type !== 'agent-approval') throw new Error('unreachable');
    expect(again.request.command).toBe(command);
    manager.respond(again.request.id, 'allow');

    await expect(second).resolves.toMatchObject({ allowed: true });
  });

  it('revokes a cleared command when the mode is narrowed to read-only', async () => {
    let mode: AgentPermissionMode = 'ask';
    const { manager, events } = make({}, { permissionMode: () => mode, sessions: oneTerminal() });
    const task = manager.create();
    await manager.prompt(task.id, 'hello');

    const first = manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rm -rf /opt/test',
      sessionId: 'session-a',
    });
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    manager.respond(raised.request.id, 'allow');
    await expect(first).resolves.toMatchObject({ allowed: true });

    mode = 'read-only';
    const second = await manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rm -rf /opt/test',
      sessionId: 'session-a',
    });

    expect(second.allowed).toBe(false);
  });

  it('fills the row an adapter drew with nothing but a title', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();
    // What Trae does: announce the MCP call by name and ask about it, no command.
    await manager.prompt(task.id, 'PERMTITLE:Tool: easyshell/terminal_run');

    const drawn = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-title');
    expect(drawn?.command).toBeUndefined();
    // A title is not a command: nothing to classify, so no card for it.
    expect(events.some((event) => event.type === 'agent-approval')).toBe(false);

    const verdict = manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rmdir /opt/test',
      sessionId: 'session-a',
    });
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    expect(raised.request.command).toBe('rmdir /opt/test');
    manager.respond(raised.request.id, 'allow');
    await expect(verdict).resolves.toMatchObject({ allowed: true });

    // The row now names the command, the terminal it ran in, and why the gate
    // let it through.
    const row = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-title');
    expect(row?.command).toBe('rmdir /opt/test');
    expect(row?.sessionId).toBe('session-a');
    expect(row?.risk).toBe('destructive');
    expect(row?.reason).toBeTruthy();
  });

  it('asks again on the second run of a call the adapter only titled', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();
    // The shape Trae sends: a permission request that names no command (answered
    // "allow" because there is nothing to judge), then the bridge twice with the
    // same line. The second run used to go through with no card at all.
    await manager.prompt(task.id, 'PERMTITLE:Tool: easyshell/terminal_run');
    const command = 'rmdir /opt/test && ls -ld /opt/test';

    for (const nth of [1, 2]) {
      const run = manager.authorizeBridgeCommand({
        taskId: task.id,
        command,
        sessionId: 'session-a',
      });
      const raised = await waitFor(
        () => events.filter((event) => event.type === 'agent-approval')[nth - 1],
        `approval card ${nth}`,
      );
      if (raised.type !== 'agent-approval') throw new Error('unreachable');
      expect(raised.request.command).toBe(command);
      manager.respond(raised.request.id, 'allow');
      await expect(run).resolves.toMatchObject({ allowed: true });
    }
  });

  it('keeps the arguments and the answer of a tool that runs no command', async () => {
    const { manager } = make();
    const task = manager.create();
    await manager.prompt(task.id, 'TOOL:ToolSearch');

    const call = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-tool');
    // No command line means nothing for the gate to judge; the row can still say
    // what the tool was asked and what it answered.
    expect(call?.command).toBeUndefined();
    expect(call?.input).toBe('{\n  "query": "terminal_run"\n}');
    expect(call?.output).toBe('terminal_run\nread_text_file');
    expect(call?.status).toBe('completed');
  });

  it('keeps the real arguments of a deferred call, and only its real answer', async () => {
    const { manager } = make();
    const task = manager.create();
    // What CodeBuddy does around `DeferExecuteTool`: announce the call with no
    // arguments, stream a draft of them (empty command, raw JSON in `content`),
    // then send the real ones and finally the answer.
    await manager.prompt(task.id, 'DEFER:kubectl describe node worker1');

    const call = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-defer');
    expect(call?.command).toBe('kubectl describe node worker1');
    // The draft that named an empty command is gone: the command block above says
    // the same thing in the way it is read.
    expect(call?.input).toBeUndefined();
    // The streamed JSON never became the answer, and the real one did.
    expect(call?.output).toBe('node1 Ready\nnode2 Ready');
    expect(call?.status).toBe('completed');
  });

  it('shows the answer a call reports in rawOutput', async () => {
    const { manager } = make();
    const task = manager.create();
    // What Codex sends for a `terminal_run` call: the command one level down in
    // the MCP arguments, the tool's answer in `rawOutput`, no content block.
    await manager.prompt(task.id, 'MCPRUN:uptime');

    const call = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-mcp');
    expect(call?.command).toBe('uptime');
    expect(call?.output).toBe('terminal: worker1\nexit code: 0\nstdout:\nuptime ok');
    expect(call?.status).toBe('completed');
  });

  it('ends the row a bridge run drew with its output and exit code', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();
    const prompting = manager.prompt(task.id, 'PERMARGS:df -h');
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    manager.respond(raised.request.id, 'allow');
    await prompting;

    const verdict = await manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'df -h',
      sessionId: 'session-a',
    });
    expect(verdict.allowed).toBe(true);
    // The output of a run over the bridge goes back to the agent over MCP, not
    // through ACP, so the bridge hands the ending over for the row it drew.
    manager.recordBridgeRun({
      taskId: task.id,
      command: 'df -h',
      sessionId: 'session-a',
      stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        98G   61G   32G  66% /',
      stderr: '',
      code: 0,
      timedOut: false,
    });

    const row = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-args');
    expect(row?.output).toContain('Use% Mounted on');
    expect(row?.exitCode).toBe(0);
    expect(row?.status).toBe('completed');
  });

  it('judges a call whose command is nested in MCP arguments, before it runs', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();

    // What Trae sends for our own bridge call: a title that names nothing
    // runnable, and the command one level down in `arguments`. Reading only the
    // top level answered "nothing to judge" here, which pushed the card to the
    // later bridge call - and left an adapter that never reaches the bridge with
    // no gate at all.
    const prompting = manager.prompt(task.id, 'PERMARGS:rmdir /opt/test');
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    expect(raised.request.command).toBe('rmdir /opt/test');
    // The card names the terminal the call is aimed at, not just the one in front.
    expect(raised.request.sessionId).toBe('session-a');
    expect(raised.request.sessionLabel).toBeTruthy();
    manager.respond(raised.request.id, 'allow');
    await prompting;

    // The run this same call asked for reuses the answer: one question, not two.
    const ran = await manager.authorizeBridgeCommand({
      taskId: task.id,
      command: 'rmdir /opt/test',
      sessionId: 'session-a',
    });
    expect(ran.allowed).toBe(true);
    expect(ran.reason).toBe(raised.request.reason);
    expect(events.filter((event) => event.type === 'agent-approval')).toHaveLength(1);

    // The row the adapter drew carries the command, the terminal and the verdict.
    const row = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-args');
    expect(row?.command).toBe('rmdir /opt/test');
    expect(row?.sessionId).toBe('session-a');
    expect(row?.risk).toBe('destructive');
  });

  it('drops a terminal name it does not have instead of refusing the command', async () => {
    const { manager, events } = make({}, { permissionMode: 'ask', sessions: oneTerminal() });
    const task = manager.create();

    // Some other server's `session_id` means nothing here. Passing it through
    // would make the gate refuse over a terminal that is "gone"; dropping it
    // falls back to the terminal in front, which is what the card then shows.
    const prompting = manager.prompt(task.id, 'PERMARGSMISS:df -h');
    const raised = await waitFor(
      () => events.find((event) => event.type === 'agent-approval'),
      'an approval card',
    );
    if (raised.type !== 'agent-approval') throw new Error('unreachable');
    expect(raised.request.command).toBe('df -h');
    manager.respond(raised.request.id, 'allow');
    await prompting;
    // The unknown name was dropped, so the gate fell back to the terminal in
    // front and the command could still be judged and shown.
    expect(raised.request.sessionId).toBe('session-a');
  });
});

/**
 * Picking a working directory is a promise: the agent can read the project it
 * was pointed at. Before this, file tools were switched off entirely, so the
 * choice meant nothing and the prompt told the agent not to look.
 */
describe('the working directory the agent may read', () => {
  const said = (manager: AgentManager, taskId: string) =>
    manager
      .transcript(taskId)
      .messages.map((message) => message.text)
      .join('\n');

  it('reads a file inside the session directory', async () => {
    const project = mkdtempSync(join(root, 'project-'));
    writeFileSync(join(project, 'deploy.md'), 'step one\nstep two\n');
    const { manager } = make();
    const task = manager.create(undefined, { mode: 'project', cwd: project });

    await manager.prompt(task.id, `READ:${join(project, 'deploy.md')}`);

    expect(said(manager, task.id)).toContain('read:step one\nstep two');
  }, 30_000);

  it('refuses a path outside it, and a walk out with ..', async () => {
    const project = mkdtempSync(join(root, 'project-'));
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'do not read me');
    const { manager } = make();
    const task = manager.create(undefined, { mode: 'project', cwd: project });

    await manager.prompt(task.id, `READ:${secret}`);
    await manager.prompt(task.id, `READ:${join(project, '..', 'secret.txt')}`);

    const text = said(manager, task.id);
    expect(text).toContain('read-error:');
    expect(text).not.toContain('do not read me');
  }, 30_000);
});

describe('AgentManager task records', () => {
  it('writes the task list to disk', async () => {
    const { manager } = make();
    const task = manager.create();

    await manager.prompt(task.id, 'hello');

    expect(existsSync(join(root, 'agent-tasks.json'))).toBe(true);
  });

  it('restores a task and reopens its session on resume', async () => {
    const { manager } = make();
    const task = manager.create();
    await manager.prompt(task.id, 'hello');

    const sessionId = manager.list()[0]?.acpSessionId;
    expect(sessionId).toBeTruthy();
    // The turn ran: the user message is in the transcript.
    expect(manager.transcript(task.id).messages.some((message) => message.text === 'hello')).toBe(
      true,
    );
    manager.shutdown();

    const { manager: restarted } = make();
    const restored = restarted.list()[0]!;
    expect(restored.id).toBe(task.id);
    expect(restored.restored).toBe(true);
    expect(restored.mode).toBe('temp');
    expect(restored.cwd).toBe(task.cwd);
    expect(restored.acpSessionId).toBe(sessionId);

    await restarted.resume(task.id);

    const resumed = restarted.list()[0]!;
    // The same session came back, and the agent replayed it through the normal
    // update channel 鈥?that is what refills the transcript.
    expect(resumed.acpSessionId).toBe(sessionId);
    expect(resumed.restored).toBe(false);
    expect(
      restarted.transcript(task.id).messages.some((message) => message.text.includes('replayed hello')),
    ).toBe(true);
    // A replay writes through the same channel as a live answer and nothing
    // closes it afterwards, so a task that was restored used to come back with
    // its last answer still "arriving": the caret under it never went away, and
    // the next turn was appended to that same message.
    expect(restarted.transcript(task.id).messages.some((message) => message.streaming)).toBe(
      false,
    );
  });

  it('rebuilds a replayed conversation in the order it happened', async () => {
    const env = { MOCK_ACP_REPLAY: 'turns' };
    const { manager } = make(env);
    const task = manager.create();
    await manager.prompt(task.id, 'hello');
    manager.shutdown();

    const { manager: restarted } = make(env);
    await restarted.resume(task.id);

    const transcript = restarted.transcript(task.id);
    // The user's own turns come back from the replay, and every block of agent
    // text stays its own message: the tool call ends the paragraph before it.
    expect(transcript.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:first question',
      'agent:first answer',
      'agent:second answer',
      'user:second question',
      'agent:third answer',
      // The replay ends on a user turn with no answer after it: the only place
      // that can clean it up is the moment it arrives.
      'user:third question',
    ]);
    expect(transcript.toolCalls.map((call) => call.id)).toEqual(['replay-call-1']);
    // The transcript is sorted by these stamps, so they have to be unique and
    // strictly increasing - a replay lands in one millisecond otherwise, and
    // the sort has nothing to go on.
    const stamps = [
      ...transcript.messages.map((message) => message.at),
      ...transcript.toolCalls.map((call) => call.startedAt),
    ];
    expect(new Set(stamps).size).toBe(stamps.length);

    // The command sits between the two paragraphs it interrupted.
    const call = transcript.toolCalls[0]!;
    const firstAnswer = transcript.messages.find((message) => message.text === 'first answer')!;
    const secondAnswer = transcript.messages.find((message) => message.text === 'second answer')!;
    expect(call.startedAt).toBeGreaterThan(firstAnswer.at);
    expect(call.startedAt).toBeLessThan(secondAnswer.at);
  });

  it("shows only the user's own words when the replay splits the prompt", async () => {
    const env = { MOCK_ACP_REPLAY: 'split' };
    const { manager } = make(env);
    const task = manager.create();
    await manager.prompt(task.id, 'hello');
    manager.shutdown();

    const { manager: restarted } = make(env);
    await restarted.resume(task.id);

    // One turn arrived in two pieces, the other lost the head of the context
    // block on the way: neither may leave the host's instructions on screen.
    expect(
      restarted.transcript(task.id).messages.map((message) => `${message.role}:${message.text}`),
    ).toEqual([
      'user:first question',
      'agent:first answer',
      'user:second question',
      'agent:second answer',
    ]);
  });

  it('writes the gate verdict onto the tool call the agent reported', async () => {
    // No live terminal in this fixture, so the gate refuses: the row the adapter
    // already put on screen has to carry that, not stay at "risk unknown".
    const { manager } = make({}, { permissionMode: 'read-only' });
    const task = manager.create();
    await manager.prompt(task.id, 'PERM:rm -rf /tmp/scratch');

    const call = manager.transcript(task.id).toolCalls.find((item) => item.id === 'call-1');
    expect(call).toBeTruthy();
    expect(call?.status).toBe('blocked');
    expect(call?.reason).toBe(translate('en', 'agent.gate.noTerminal'));
  });

  it('falls back to a new session when the agent cannot load one', async () => {
    const { manager } = make({ MOCK_ACP_NO_LOAD: '1' });
    const task = manager.create();
    await manager.prompt(task.id, 'hello');
    manager.shutdown();

    const { manager: restarted, events } = make({ MOCK_ACP_NO_LOAD: '1' });
    await restarted.resume(task.id);

    expect(noticeKeys(events)).toContain('agent.notice.sessionReset');
    expect(restarted.list()[0]?.acpSessionId).toBeTruthy();
    expect(restarted.list()[0]?.restored).toBe(false);
  });

  it('drops a closed task from disk', async () => {
    const { manager } = make();
    const task = manager.create();
    manager.close(task.id);
    manager.shutdown();

    const { manager: restarted } = make();
    expect(restarted.list()).toHaveLength(0);
  });
});

describe('ACP terminals', () => {
  /**
   * Two live terminals. The point of these tests is that a command lands on
   * the one the agent *named*, whatever the user happens to have in front.
   */
  const terminal = (id: string, target: string) =>
    ({
      id,
      kind: 'ssh',
      title: target,
      status: 'connected',
      metadata: { endpoint: { displayName: target, chain: [] } },
    }) as unknown as SessionInfo;

  const A = terminal('session-a', 'root@198.18.0.7');
  const B = terminal('session-b', 'deploy@198.18.0.9');

  function liveSessions(
    onRun?: (id: string, command: string, options: unknown) => Promise<ExecResult>,
  ) {
    const calls: Array<{ id: string; command: string; options: Record<string, unknown> }> = [];
    const stub = {
      list: () => [A, B],
      get: (id: string) => (id === A.id ? A : id === B.id ? B : null),
      attach: () => null,
      exec: () => Promise.reject(new Error('unexpected out-of-band exec')),
      runCommand: async (id: string, command: string, options: Record<string, unknown>) => {
        calls.push({ id, command, options });
        if (onRun) return onRun(id, command, options);
        return { code: 0, stdout: 'ok\n', stderr: '', timedOut: false } satisfies ExecResult;
      },
    } as unknown as SessionManager;
    return { stub, calls };
  }

  function said(manager: AgentManager, taskId: string): string {
    return manager
      .transcript(taskId)
      .messages.map((message) => message.text)
      .join('\n');
  }

  it('names the terminal through _meta and keeps cwd a real directory', async () => {
    const { stub, calls } = liveSessions();
    const { manager } = make({}, { permissionMode: 'unrestricted', sessions: stub });
    const task = manager.create();
    // The user is looking at the other terminal; the command is not for it.
    manager.setFocus(B.id);

    await manager.prompt(task.id, 'TERM:session-a|/srv|ls -la');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('session-a');
    // argv is quoted, because it is argv and not shell text.
    expect(calls[0]?.command).toBe("ls -la 'a b' 'it'\\''s'");
    // `cwd` is a directory inside the target, exactly what ACP says it is.
    expect(calls[0]?.options).toMatchObject({ cwd: '/srv' });
    expect(said(manager, task.id)).toContain('ran:ok');
  });

  it('reports the exit status of a command it killed', async () => {
    const { stub, calls } = liveSessions(
      (_id, _command, options) =>
        new Promise<ExecResult>((resolve) => {
          const signal = (options as { signal?: AbortSignal }).signal;
          signal?.addEventListener('abort', () =>
            resolve({ code: null, stdout: '', stderr: '', timedOut: false }),
          );
        }),
    );
    const { manager } = make({}, { permissionMode: 'unrestricted', sessions: stub });
    const task = manager.create();

    await manager.prompt(task.id, 'KILL:session-a|sleep 600');

    expect(calls).toHaveLength(1);
    // terminal/kill has to reach the running command, and the exit status has
    // to describe a signal rather than pretend a code was returned.
    expect(said(manager, task.id)).toContain('killed:SIGKILL');
  });

  it('refuses to run on another machine when the named terminal is gone', async () => {
    const { stub, calls } = liveSessions();
    const { manager } = make({}, { permissionMode: 'unrestricted', sessions: stub });
    const task = manager.create();
    manager.setFocus(A.id);

    await manager.prompt(task.id, 'TERM:ghost|/srv|ls');

    expect(calls).toHaveLength(0);
    expect(said(manager, task.id)).toContain('failed:');
  });
});
