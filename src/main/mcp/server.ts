/**
 * The MCP server an agent CLI spawns to reach this app's terminals.
 *
 * Every agent that speaks ACP is also an MCP client, and the host decides which
 * MCP servers a session gets. That is the one door into a terminal which does
 * not depend on the agent implementing ACP's `terminal/*` extension — which, as
 * of this writing, none of them do.
 *
 * The process is spawned by the *agent*, so it cannot call into the app. It
 * talks to the loopback bridge instead (`AgentBridge`), whose URL and token
 * arrive as `EASYSHELL_BRIDGE_URL` / `EASYSHELL_BRIDGE_TOKEN`. It is plain Node:
 * the app launches it with `ELECTRON_RUN_AS_NODE`, so nothing reachable from
 * here may import Electron or any app module.
 *
 * Everything below is transport: environment in, stdin lines through the
 * handler, one JSON line out per message. Nothing else may print to stdout —
 * a stray write is a protocol error to the client.
 */
import { createMcpHandler } from './protocol';
import type { BridgeCall } from './protocol';

const BRIDGE_URL = (process.env.EASYSHELL_BRIDGE_URL ?? '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.EASYSHELL_BRIDGE_TOKEN ?? '';
/**
 * Which agent task this MCP server belongs to.
 *
 * The bridge has to name the task an approval card is filed against, and one
 * bridge serves every task in the window, so the id travels with the process.
 */
const BRIDGE_TASK = process.env.EASYSHELL_BRIDGE_TASK ?? '';

/** One call to the app, with the failure modes folded into a printable string. */
const callBridge: BridgeCall = async (path, init) => {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error(
      'the EasyShell bridge is not available: this session was started without it, so no terminal can be reached',
    );
  }
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
      'content-type': 'application/json',
      // An older app may not have started this process with a task id; the
      // bridge then falls back to the only task that can be talking.
      ...(BRIDGE_TASK ? { 'x-easyshell-task': BRIDGE_TASK } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    // A long command on a slow link is not a broken bridge.
    signal: AbortSignal.timeout(600_000),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`the bridge answered with something that is not JSON: ${raw.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(
      typeof parsed['error'] === 'string' ? parsed['error'] : `status ${response.status}`,
    );
  }
  return parsed;
};

const handle = createMcpHandler({
  call: callBridge,
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
});

/**
 * Requests still being answered.
 *
 * A pipe that closes right after its last line must not kill the process
 * mid-request: writing the answer is the whole point of having read the line.
 */
const pending = new Set<Promise<void>>();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const job = handle(line);
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
    index = buffer.indexOf('\n');
  }
});
// The agent closed the pipe: answer what is still in flight, then leave.
process.stdin.on('end', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});
