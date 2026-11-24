#!/usr/bin/env node
/**
 * A tiny ACP agent used by the unit tests.
 *
 * It speaks the same shape as a real agent CLI over stdio, so the transport can
 * be tested without installing one. Behaviour is driven by the prompt text:
 *
 *   PERM:<command>  ask the host for permission, then echo the option it chose
 *   RUN:<command>   create a terminal, wait for it, read its output, release it
 *
 * Everything else is answered with a single `ok` chunk.
 */
import { createInterface } from 'node:readline';

const sessionId = 'mock-session-1';
const waiting = new Map();
let nextRequestId = 1;
/**
 * Advertise and answer `session/load` like a real agent that can restore a
 * session. `MOCK_ACP_NO_LOAD=1` turns it into one that cannot, which is how the
 * fallback path gets tested.
 */
const supportsLoad = process.env.MOCK_ACP_NO_LOAD !== '1';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function request(method, params) {
  const id = nextRequestId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

function chunk(text) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

/** One `session/update` notification, the shape an agent uses to stream. */
function notifyUpdate(update) {
  notify('session/update', { sessionId, update });
}

/**
 * The history a restoring agent replays: two turns, a tool call between two
 * blocks of agent text, and the user's own words. This is the shape the host has
 * to turn back into a transcript, in this order.
 */
function replayHistory() {
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      // What a real agent stores is the prompt the host sent, context block and
      // all. The host is expected to show only what the user typed.
      text: '<easyshell_context>\nPermission mode: ask\n</easyshell_context>\n\nfirst question',
    },
  });
  notifyUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'first answer' },
  });
  notifyUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'replay-call-1',
    title: 'df -h',
    kind: 'execute',
    status: 'completed',
  });
  notifyUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'second answer' },
  });
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'second question' },
  });
  notifyUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'third answer' },
  });
  // A turn the agent never answered: the replay ends on a user message, so the
  // host has to clean it up when it arrives, not when the next block starts.
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: '<easyshell_context>\nPermission mode: ask\n</easyshell_context>\n\nthird question',
    },
  });
}

/**
 * A replay whose prompt was split on the way back.
 *
 * The first turn arrives as two pieces - the block's head, then its tail with
 * the user's words - and the second turn arrives with the head already lost
 * inside the transport. Both are shapes a real agent produces for a long
 * prompt, and in both the host may only show what the user actually typed.
 */
function replaySplitHistory() {
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: '<easyshell_context>\nPermission mode: ask\nHow a command reaches a terminal:',
    },
  });
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: '\n- ask the host.\n</easyshell_context>\n\nfirst question' },
  });
  notifyUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'first answer' },
  });
  notifyUpdate({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: 'how a command reaches a terminal:\n</easyshell_context>\n\nsecond question',
    },
  });
  notifyUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'second answer' },
  });
}

async function handlePrompt(params) {
  const text = (params.prompt ?? []).map((block) => block.text ?? '').join('\n');
  const permission = /PERM:([^\n]+)/.exec(text);


  // An adapter that asks about a tool call it never describes: Trae titles the
  // MCP call ("Tool: easyshell/terminal_run") and leaves the command out, so the
  // bridge gate is the only place that knows what will run.
  const titled = /PERMTITLE:\s*([^\n]+)/.exec(text);
  if (titled) {
    notifyUpdate({
      sessionUpdate: 'tool_call',

      toolCallId: 'call-title',
      title: titled[1],
      kind: 'other',
      status: 'in_progress',
    });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-title', title: titled[1], kind: 'other', status: 'pending' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer?.outcome ?? {};
    chunk(`outcome:${outcome.optionId ?? outcome.outcome ?? 'none'}`);
  }

  // A tool the agent runs inside itself: `TOOL:<title>`. There is no command
  // line for the gate to judge, so the arguments and the answer are the only
  // things the host can put behind "details".
  const tool = /TOOL:([^\n]+)/.exec(text);
  if (tool) {
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-tool',
      title: tool[1],
      kind: 'search',
      status: 'in_progress',
      rawInput: { query: 'terminal_run' },
    });
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-tool',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'terminal_run' } },
        { type: 'content', content: { type: 'text', text: 'read_text_file' } },
      ],
    });
    chunk('tool-done');
  }

  // The shape CodeBuddy uses: `DEFER:<command>`. It announces the call with no
  // arguments at all, streams a draft of them through `rawInput` and `content`
  // - a draft whose command is the empty string - then sends the real ones, and
  // only at the end the tool's answer.
  const deferred = /DEFER:([^\n]+)/.exec(text);
  if (deferred) {
    const command = deferred[1];
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-defer',
      title: 'DeferExecuteTool',
      kind: 'other',
      status: 'in_progress',
      rawInput: {},
    });
    // Arguments still streaming: the raw JSON travels in `content`, which is not
    // a result, and the draft parameters name no command yet.
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-defer',
      rawInput: { params: { command: '' } },
      content: [{ type: 'content', content: { type: 'text', text: '{"params": {"command": "' } }],
    });
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-defer',
      rawInput: { params: { command } },
      _meta: { 'codebuddy.ai/toolArgumentsComplete': true },
    });
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-defer',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'node1 Ready\nnode2 Ready' } },
      ],
    });
    chunk('defer-done');
  }

  // The shape Codex reports: `MCPRUN:<command>`. The call is named after the MCP
  // tool, the command sits one level down in its arguments, and the tool's answer
  // comes back in `rawOutput` - never in `content`.
  const mcpRun = /MCPRUN:([^\n]+)/.exec(text);
  if (mcpRun) {
    const command = mcpRun[1];
    const rawInput = {
      server: 'easyshell',
      tool: 'terminal_run',
      arguments: { session_id: 'session-a', command },
    };
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-mcp',
      title: 'mcp.easyshell.terminal_run',
      kind: 'execute',
      status: 'in_progress',
      rawInput,
    });
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-mcp',
      status: 'completed',
      rawInput,
      rawOutput: {
        result: {
          content: [{ type: 'text', text: `terminal: worker1\nexit code: 0\nstdout:\n${command} ok` }],
        },
        error: null,
      },
    });
    chunk('mcp-done');
  }

  // The shape Trae uses for our own MCP call: `PERMARGS:<command>`. The command
  // and the terminal sit one level down, inside `arguments`, and the title names
  // nothing runnable. The host has to read that level or it judges nothing here.
  // `PERMARGSMISS:` names a session that is not one of ours.
  const nested = /PERMARGS(MISS)?:\s*([^\n]+)/.exec(text);
  if (nested) {
    const command = nested[2];
    const sessionIdInCall = nested[1] ? 'not-a-terminal' : 'session-a';
    const rawInput = {
      server: 'easyshell1',
      tool: 'terminal_run',
      arguments: { session_id: sessionIdInCall, command },
    };
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-args',
      title: 'Tool: easyshell/terminal_run',
      kind: 'execute',
      status: 'in_progress',
      rawInput,
    });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: 'call-args',
        title: 'Tool: easyshell/terminal_run',
        kind: 'execute',
        status: 'pending',
        rawInput,
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer?.outcome ?? {};
    chunk(`outcome:${outcome.optionId ?? outcome.outcome ?? 'none'}`);
  }

  // Read a file the host offers: `READ:<absolute path>`. The reply is the file
  // or the refusal, so the host's sandbox is visible in the transcript.
  const read = /READ:([^\n]+)/.exec(text);
  if (read) {
    try {
      const result = await request('fs/read_text_file', { sessionId, path: read[1] });
      chunk(`read:${result?.content ?? ''}`);
    } catch (error) {
      chunk(`read-error:${error?.message ?? 'unknown'}`);
    }
  }

  if (permission) {
    // Adapters describe the call, then ask about it: the host needs the row to
    // exist so it can attach its verdict to what the user is looking at.
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: permission[1],
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: permission[1] },
    });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: 'call-1',
        title: permission[1],
        kind: 'execute',
        status: 'pending',
        rawInput: { command: permission[1] },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer?.outcome ?? {};
    chunk(`outcome:${outcome.optionId ?? outcome.outcome ?? 'none'}`);
  }

  const run = /RUN:([^\n]+)/.exec(text);
  if (run) {
    try {
      const created = await request('terminal/create', {
        sessionId,
        command: run[1],
        args: [],
        cwd: 'easyshell://session-a',
        outputByteLimit: 4096,
      });
      const exit = await request('terminal/wait_for_exit', {
        sessionId,
        terminalId: created.terminalId,
      });
      const output = await request('terminal/output', {
        sessionId,
        terminalId: created.terminalId,
      });
      chunk(`ran:${output.output}:${exit.exitCode}`);
      await request('terminal/release', { sessionId, terminalId: created.terminalId });
    } catch (error) {
      chunk(`failed:${error?.message ?? 'unknown'}`);
    }
  }

  // `TERM:<terminal>|<cwd>|<command>` exercises the standard shape: the terminal
  // is named where ACP reserves room for it (`_meta`), `cwd` stays a real
  // absolute directory, and `args` are argv that need quoting.
  const term = /TERM:([^\n]+)/.exec(text);
  if (term) {
    const [terminal, cwd, ...command] = term[1].split('|');
    try {
      const created = await request('terminal/create', {
        sessionId,
        command: command.join('|'),
        args: ['a b', "it's"],
        cwd,
        outputByteLimit: 4096,
        _meta: { easyshell: { terminal } },
      });
      const exit = await request('terminal/wait_for_exit', {
        sessionId,
        terminalId: created.terminalId,
      });
      const output = await request('terminal/output', {
        sessionId,
        terminalId: created.terminalId,
      });
      chunk(`ran:${output.output}:${exit.exitCode}`);
      await request('terminal/release', { sessionId, terminalId: created.terminalId });
    } catch (error) {
      chunk(`failed:${error?.message ?? 'unknown'}`);
    }
  }

  // `KILL:<terminal>|<command>` asks for a terminal and then kills it.
  const kill = /KILL:([^\n]+)/.exec(text);
  if (kill) {
    const [terminal, ...command] = kill[1].split('|');
    try {
      const created = await request('terminal/create', {
        sessionId,
        command: command.join('|'),
        cwd: '/',
        _meta: { easyshell: { terminal } },
      });
      await request('terminal/kill', { sessionId, terminalId: created.terminalId });
      const exit = await request('terminal/wait_for_exit', {
        sessionId,
        terminalId: created.terminalId,
      });
      chunk(`killed:${exit.signal ?? 'none'}`);
      await request('terminal/release', { sessionId, terminalId: created.terminalId });
    } catch (error) {
      chunk(`failed:${error?.message ?? 'unknown'}`);
    }
  }

  return { stopReason: 'end_turn' };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // A response to one of our own host requests.
  if (message.method === undefined) {
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (!entry) return;
    if (message.error) entry.reject(new Error(message.error.message ?? 'rpc error'));
    else entry.resolve(message.result ?? null);
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: supportsLoad ? { loadSession: true } : {},
        agentInfo: { name: 'mock-acp-agent', version: '0.0.1' },
      });
      break;
    case 'session/new':
      // `MCP_EXPECT=<n>` makes the mock refuse a session that does not carry the
      // MCP servers the host promised, which is the wiring the bridge depends on.
      if (
        process.env.MCP_EXPECT !== undefined &&
        String((message.params?.mcpServers ?? []).length) !== process.env.MCP_EXPECT
      ) {
        fail(message.id, -32602, `expected ${process.env.MCP_EXPECT} MCP servers`);
        break;
      }
      respond(message.id, { sessionId });
      break;
    case 'session/load':
      if (!supportsLoad) {
        fail(message.id, -32601, 'unsupported: session/load');
        break;
      }
      // ACP replays the stored conversation before answering the request.
      // `MOCK_ACP_REPLAY=turns` replays two full turns instead of one chunk, so
      // the host's ordering rules can be exercised on a real history; `split`
      // replays prompts whose context block came back in pieces.
      if (process.env.MOCK_ACP_REPLAY === 'turns') replayHistory();
      else if (process.env.MOCK_ACP_REPLAY === 'split') replaySplitHistory();
      else chunk('replayed hello');
      respond(message.id, null);
      break;
    case 'session/prompt':
      void handlePrompt(message.params ?? {}).then((result) => respond(message.id, result));
      break;
    case 'session/cancel':
      break;
    default:
      if (message.id !== undefined) fail(message.id, -32601, `unsupported: ${message.method}`);
  }
});
