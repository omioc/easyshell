/**
 * Agent-mode rules that do not need a process.
 *
 * `decideAgentAction` is the whole permission model in one function: the app
 * never decides on its own whether a command is safe, it only maps a verdict
 * produced by the connected agent CLI (see `buildClassifierPrompt`) onto what
 * the gate does. `buildAgentPromptContext` is the other half: every turn hands
 * the agent the live terminal list plus the rules of the current mode, because
 * ACP has no system prompt of its own.
 *
 * Everything here is pure so the policy can be tested without an agent process
 * and without Electron.
 */
import type {
  AgentCommandRisk,
  AgentPermissionMode,
  AgentRiskState,
  AgentRiskVerdict,
  Locale,
  SessionInfo,
} from './types';

export const AGENT_PERMISSION_MODES: AgentPermissionMode[] = [
  'read-only',
  'ask',
  'auto',
  'unrestricted',
];

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as string[]).includes(value);
}

export type AgentGateAction = 'allow' | 'ask' | 'deny';

/**
 * Mode × risk → what happens to one command.
 *
 * | mode         | read | write | destructive |
 * | ------------ | ---- | ----- | ----------- |
 * | read-only    | run  | deny  | deny        |
 * | ask          | run  | ask   | ask         |
 * | auto         | run  | run   | ask         |
 * | unrestricted | run  | run   | run         |
 *
 * An unknown risk is treated as `destructive`: the only thing the app may do
 * with a command it could not have classified is ask.
 */
export function decideAgentAction(mode: AgentPermissionMode, risk: AgentRiskState): AgentGateAction {
  if (mode === 'unrestricted') return 'allow';
  if (risk === 'read') return 'allow';
  if (mode === 'read-only') return 'deny';
  if (mode === 'ask') return 'ask';
  // auto: the verdict is the only thing standing between the user and the run.
  return risk === 'destructive' || risk === 'unknown' ? 'ask' : 'allow';
}

/* -------------------------------------------------------------- classifier */

/**
 * The language the `reason` comes back in, named the way a model understands it.
 *
 * The reason is quoted verbatim in the approval card, so it is interface text:
 * it has to match the app's language, not the language of the command. The
 * classifier session never sees the user's own message, so the locale has to be
 * passed in - it cannot be inferred from context.
 */
const REASON_LANGUAGES: Record<Locale, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
};

/**
 * The classifier gets its own ACP session that is never used for anything else,
 * so this instruction is repeated on every call: a session that only ever sees
 * this prompt cannot drift into helping with the actual task.
 */
export function buildClassifierInstruction(locale: Locale = 'en'): string {
  return [
    'You are a shell command risk classifier inside a terminal app.',
    'You never execute anything, you never answer questions about the task, and you stay silent about everything except the verdict.',
    'Classify exactly one command line into one of three classes:',
    '- "read": only observes state (ls, cat, head, tail, grep, find, ps, df, du, free, uptime, systemctl status, journalctl, git status/log/diff/show, docker ps, ss, ip addr, whoami, uname).',
    '- "write": changes state, but the change is local, reversible or plainly what the user asked for (touch, mkdir, cp, mv, sed -i, tee, a package install, systemctl restart, docker run, git add/commit/push, writing a report file).',
    '- "destructive": irreversible, wide reaching or privilege changing (rm -rf, rm of system paths, dd of=, mkfs, shred, shutdown, reboot, kill -9 on system processes, chmod/chown -R outside the home directory, writes under /etc /boot /usr, curl|sh, DROP TABLE, TRUNCATE, disabling a firewall, fdisk/parted, any sudo of the above).',
    'Judge the whole command line, including pipes, redirections, command substitution and anything wrapped in sudo, su, sh -c, bash -c, xargs, env or eval.',
    'If the command is ambiguous, obfuscated or you are not sure, answer "destructive".',
    `Write the "reason" value in ${REASON_LANGUAGES[locale] ?? REASON_LANGUAGES.en}, the language the app is showing to the user, and keep it to that one language: no mixed sentences, no English words inside Chinese text.`,
    'Answer with one line of JSON and nothing else: {"risk":"read|write|destructive","reason":"<one short sentence>"}',
  ].join('\n');
}

export function buildClassifierPrompt(command: string, target: string, locale: Locale = 'en'): string {
  return [
    buildClassifierInstruction(locale),
    '',
    `Terminal: ${target}`,
    'Command:',
    command,
  ].join('\n');
}

const RISKS: AgentCommandRisk[] = ['read', 'write', 'destructive'];

function isRisk(value: unknown): value is AgentCommandRisk {
  return typeof value === 'string' && (RISKS as string[]).includes(value);
}

/** What a verdict falls back to when nothing usable came back. */
export const CONSERVATIVE_VERDICT: AgentRiskVerdict = {
  risk: 'destructive',
  reason: 'verdict-unavailable',
  degraded: true,
};

/**
 * Reads the classifier's answer. Anything that is not a clean verdict degrades
 * to `destructive`, so a broken or chatty classifier can only make the gate
 * stricter, never looser.
 */
export function parseRiskVerdict(raw: string): AgentRiskVerdict {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return CONSERVATIVE_VERDICT;

  // Some agents answer with the bare word instead of JSON; take it.
  const bare = text.toLowerCase().replace(/[^a-z]/g, '');
  if (isRisk(bare)) return { risk: bare, reason: '', degraded: false };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return CONSERVATIVE_VERDICT;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return CONSERVATIVE_VERDICT;
    const risk = parsed.risk ?? parsed.classification ?? parsed.verdict ?? parsed.level;
    if (!isRisk(risk)) return CONSERVATIVE_VERDICT;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : '';
    return { risk, reason, degraded: false };
  } catch {
    return CONSERVATIVE_VERDICT;
  }
}

/* ------------------------------------------------------------------ context */

const MODE_RULES: Record<AgentPermissionMode, string> = {
  'read-only':
    'Read-only. You may only produce commands that observe state. Anything that creates, changes or deletes state is blocked before it runs and comes back to you as an error — do not propose one, and do not try to work around the block.',
  ask:
    'Manual approval. Read-only commands run immediately. Every command that changes state, and anything ambiguous, waits until the user approves it.',
  auto:
    'Automatic approval. Commands that change state run immediately. Destructive or privilege-changing commands wait until the user approves them.',
  unrestricted:
    'Unrestricted. Every command runs immediately. Be conservative anyway: prefer the smallest command that answers the question.',
};

/** Trims a session's rollback buffer down to something worth spending tokens on. */
export function tailLines(text: string, count: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  const tail = lines.slice(Math.max(0, lines.length - Math.max(0, count)));
  return tail.join('\n');
}

const ANSI_PATTERN =
  // CSI (colors, cursor), OSC (titles, hyperlinks), and single-character escapes.
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(ANSI_PATTERN, '');
}

function describeSession(session: SessionInfo, focused: boolean): string {
  const endpoint = session.metadata.endpoint;
  const chain = endpoint.chain;
  const parts = [
    `id=${session.id}`,
    `kind=${session.kind}`,
    `target=${JSON.stringify(endpoint.displayName)}`,
    `status=${session.status}`,
    `title=${JSON.stringify(session.title)}`,
  ];
  if (endpoint.username) parts.push(`user=${endpoint.username}`);
  if (chain.length > 1) {
    parts.push(`chain=${JSON.stringify(chain.map((hop) => hop.host ?? hop.label).join(' -> '))}`);
  }
  return `- ${parts.join(' ')}${focused ? '  [focused]' : ''}`;
}

export interface AgentPromptContextInput {
  mode: AgentPermissionMode;
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  /** Visible output tail per session id, already stripped of escape sequences. */
  tails?: Record<string, string>;
  /**
   * The directory the user picked for this session. It is the only place on the
   * desktop the agent may read, and saying so is the whole point of picking one.
   */
  workDir?: string;
}

/**
 * The context block prepended to every user turn.
 *
 * ACP gives the host no system prompt, so this is the only channel that tells
 * the agent which terminals exist right now, how to address one, and what the
 * current mode forbids. It is rebuilt on every turn on purpose: the requirement
 * is that the agent always sees the *latest* live sessions, and a stale catalog
 * is worse than a repeated one.
 */
export function buildAgentPromptContext(input: AgentPromptContextInput): string {
  const lines: string[] = [];
  lines.push('<easyshell_context>');
  lines.push(
    'You are the agent inside EasyShell, a desktop terminal that holds the user\'s live shells: local shells, WSL distributions and SSH sessions, including nested logins through bastions.',
  );
  lines.push(
    'There is no separate machine for you to inspect. Every command you run is executed inside one of the terminals listed below, as the user of that terminal.',
  );
  lines.push('');
  lines.push(`Permission mode: ${input.mode}`);
  lines.push(`Rules for this mode: ${MODE_RULES[input.mode]}`);
  lines.push('');

  if (input.sessions.length === 0) {
    lines.push('Live terminals: none. Ask the user to open a terminal tab before running anything.');
  } else {
    lines.push(`Live terminals (${input.sessions.length}):`);
    for (const session of input.sessions) {
      const focused = session.id === input.focusedSessionId;
      lines.push(describeSession(session, focused));
      const tail = input.tails?.[session.id];
      if (tail) {
        lines.push('  recent output:');
        for (const line of tail.split('\n')) lines.push(`  | ${line}`);
      }
    }
  }

  lines.push('');
  lines.push('How a command reaches a terminal:');
  lines.push(
    "- Preferred: call the `easyshell` MCP server's `terminal_run` tool with a terminal id and a command line. The app runs it inside that live terminal, as that terminal's user, brings the tab to the front, and echoes the command and its output there while it runs. It returns the exit code plus stdout and stderr. `terminal_list` lists the ids; `terminal_focus` brings one forward.",
  );
  lines.push(
    '- If your adapter implements ACP terminals: a `terminal/create` request whose `_meta.easyshell.terminal` names the id, then `terminal/wait_for_exit` and `terminal/output`. `cwd` keeps its protocol meaning: an absolute directory inside the target machine.',
  );
  lines.push(
    '- An adapter that forwards `cwd` verbatim may also name a terminal as `cwd: "easyshell://<id>"`. With no terminal named anywhere, the focused terminal is used: the one marked [focused] above. You cannot switch tabs yourself - naming a terminal per command is how you choose, and the user picks which one is focused.',
  );
  lines.push(
    "- Your own process is the desktop machine, not the target. A command you run in your own shell, or a file you read from it, says nothing about the terminal: never present it as terminal output and never describe the desktop's state as the remote machine's. If neither route is available, say exactly that and ask the user to run the command, instead of answering from the wrong machine.",
  );
  lines.push(
    '- Commands run without a TTY. Never start an interactive program (vim, top, less, ssh without -T, a pager); it hangs and is killed. Use the non-interactive form: ps, tail, cat, journalctl --no-pager, ssh -T.',
  );
  lines.push('- Each command returns its exit code plus stdout and stderr.');
  lines.push(
    input.workDir
      ? `- Your working directory is ${input.workDir} on the desktop, and you may read files inside it (read-only) — deployment notes, compose files, configs — to work out which commands to run. Read outside it is refused. Write on the desktop is refused too: anything you need to leave behind belongs in a terminal, where the gate sees it.`
      : '- You have no working directory on the desktop in this session: file reads and writes are refused. Anything you need to leave behind belongs in a terminal.',
  );
  lines.push(
    "- What you read on the desktop is context for a command, never the state of the target machine: the target is only what a terminal command prints. Never quote a local file as terminal output.",
  );
  lines.push('');
  lines.push(
    'Report and answer in the language the user writes in. When the user asks for a report, answer with finished markdown unless they asked for it as a file.',
  );
  lines.push('</easyshell_context>');
  return lines.join('\n');
}

/** Cache key that keeps two terminals' identical command lines apart. */
export function commandKey(sessionId: string, command: string): string {
  return `${sessionId}\u0000${command.trim().replace(/\s+/g, ' ')}`;
}

/** Keys a tool input uses to name the command it will run. */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell_command', 'commandLine', 'command_line'];

/** Containers an MCP-style call nests its own arguments in, one level down. */
const ARGUMENT_KEYS = ['arguments', 'input', 'params'];

/**
 * Keys those arguments use to name the terminal a command is aimed at. The
 * bridge's own tool takes `session_id`; the other two are the spellings a tool
 * definition picks for itself.
 */
const TERMINAL_KEYS = ['session_id', 'terminal', 'terminal_id'];

/** What one tool call says it will do. */
export interface ToolCallTarget {
  /** The command line it names, or `''` when it names none. */
  command: string;
  /**
   * The terminal it named, verbatim and unverified: a name in arguments can mean
   * something else entirely to another server, so the caller - the only party
   * that holds the session list - decides whether it is one of ours.
   */
  terminal?: string;
}

/** The command line inside one tool-input object, or `''` when it names none. */
function commandOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of COMMAND_KEYS) {
    const found = record[key];
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  // `args` is the same information in argv form: `{command: 'systemctl', args: [...]}`
  // answers with the array when the command itself was not spelled out.
  const args = record.args;
  if (Array.isArray(args) && args.length > 0 && args.every((item) => typeof item === 'string')) {
    return args.join(' ');
  }
  return '';
}

/** The terminal named beside a command, if that object names one. */
function terminalOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of TERMINAL_KEYS) {
    const found = record[key];
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return undefined;
}

/**
 * What a tool call says it will do, wherever the adapter put it.
 *
 * Two shapes come through the same door. A tool that belongs to the protocol
 * itself puts `command` at the top level. An MCP-style call nests its arguments
 * one level down — Trae reports `easyshell/terminal_run` as
 * `{server, tool, arguments: {session_id, command}}` — and reading only the top
 * level made the gate answer "nothing here to judge", which pushed the approval
 * card to the later bridge call and left an adapter that never reaches the bridge
 * with no gate at all.
 *
 * One level is enough: the arguments of an MCP call are a flat object, not a
 * tree. `terminal` is reported without being checked, on purpose - see the type.
 */
export function toolCallTarget(rawInput: unknown): ToolCallTarget {
  const command = commandOf(rawInput);
  if (command) return { command, terminal: terminalOf(rawInput) };
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return { command: '' };
  const record = rawInput as Record<string, unknown>;
  for (const key of ARGUMENT_KEYS) {
    const nested = record[key];
    const inner = commandOf(nested);
    if (inner) return { command: inner, terminal: terminalOf(nested) ?? terminalOf(rawInput) };
  }
  return { command: '' };
}

/** The command carried by an ACP tool call, if it carries one at all. */
export function commandFromToolInput(rawInput: unknown, fallback: string): string {
  return toolCallTarget(rawInput).command || fallback.trim();
}

/**
 * Finds the terminal an agent named.
 *
 * Agents know a tab by whatever the context block showed them — an id, a
 * prefix of one, a title, or `user@host`. All four are accepted because the
 * model quotes back what it was given, and refusing a name it can see is a
 * dead end it has no way out of.
 */
export function matchSession(sessions: SessionInfo[], name: string): SessionInfo | null {
  const wanted = name.trim();
  if (!wanted) return null;
  return (
    sessions.find(
      (session) =>
        session.id === wanted ||
        session.id.startsWith(wanted) ||
        session.title === wanted ||
        session.metadata.endpoint.displayName === wanted,
    ) ?? null
  );
}
