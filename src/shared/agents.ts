/**
 * The ACP agent CLIs this app knows how to start.
 *
 * Data, not behaviour: the main process probes the machine against it
 * (`src/main/agent/detect.ts`) and the settings page draws one card per entry.
 *
 * Every `bins` value was checked against the agent's own documentation:
 *
 * - Claude Code → `claude-agent-acp` (the ACP adapter, npm
 *   `@zed-industries/claude-agent-acp`).
 * - Codex → `codex-acp` (npm `codex-acp`).
 * - OpenCode → `opencode acp` (`https://opencode.ai/docs/cli/acp/`).
 * - Trae → `traecli acp serve` (`traecli acp --help`; `--acp` is the same
 *   server on the top-level command line).
 * - CodeBuddy → `codebuddy --acp` (help: ACP over `ndJsonStream`; the
 *   `--acp-transport` default is stdio). Its npm bin has no file extension,
 *   which `parseShimEntry` still resolves to a Node launch.
 */
import type { PlatformOs } from './types';

export type AgentCliState = 'available' | 'missing' | 'adapter-missing' | 'unsupported';

export interface AgentCliDefinition {
  id: string;
  /** Product name: a brand, never translated. */
  name: string;
  /** Translation key for the one-line description. */
  descriptionKey: string;
  /** Executables that speak ACP; the first one found on PATH wins. */
  bins: string[];
  /** Arguments that switch the CLI into ACP mode. */
  args: string[];
  /** Shown on the card when the entry cannot be used yet. */
  install: string;
  /** The CLI an adapter shim ultimately drives, when it is a separate binary. */
  hostBin?: string;
  /**
   * Desktop (GUI) install locations, when the product also ships one.
   *
   * A desktop app is not an ACP entry point, but "I installed it" usually means
   * this one, so the card names what it found instead of just saying "not
   * installed". `%VAR%` and `~` are expanded; a missing variable skips the entry.
   */
  desktop?: string[];
  /** False when no ACP entry point is documented; such a card is never selectable. */
  acp: boolean;
}

export const AGENT_CLIS: AgentCliDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    descriptionKey: 'settings.agent.cli.claude',
    bins: ['claude-agent-acp'],
    args: [],
    install: 'npm install -g @zed-industries/claude-agent-acp',
    hostBin: 'claude',
    acp: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    descriptionKey: 'settings.agent.cli.codex',
    bins: ['codex-acp'],
    args: [],
    install: 'npm install -g codex-acp',
    hostBin: 'codex',
    acp: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    descriptionKey: 'settings.agent.cli.opencode',
    bins: ['opencode'],
    args: ['acp'],
    install: 'npm install -g opencode-ai',
    // The desktop app is what most people install first, and it cannot speak ACP.
    desktop: ['%LOCALAPPDATA%\\Programs\\@opencode-aidesktop\\OpenCode.exe'],
    acp: true,
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    descriptionKey: 'settings.agent.cli.codebuddy',
    bins: ['codebuddy', 'cbc'],
    args: ['--acp'],
    install: 'npm install -g @tencent-ai/codebuddy-code',
    acp: true,
  },
  {
    id: 'trae',
    name: 'Trae',
    descriptionKey: 'settings.agent.cli.trae',
    // Both shims ship in the same install directory; `traecli` is the name in
    // the CLI's own help output.
    bins: ['traecli', 'trae-cli'],
    // `traecli acp` alone only prints help: `serve` is the real entry point.
    args: ['acp', 'serve'],
    // ByteDance ships its own installer, so there is no one-line command to
    // copy; the card says the CLI was not found and leaves it at that.
    install: '',
    acp: true,
  },
];

/** What one probe of the machine found for one entry. */
export interface AgentCliDetection {
  id: string;
  state: AgentCliState;
  /** Executable to spawn; empty unless `state` is `available`. */
  command: string;
  args: string[];
  /** Install command to show on the card. */
  install: string;
  /** For `adapter-missing`: the CLI that was found, e.g. `claude.exe`. */
  hostCommand?: string;
  /** For `missing`: a desktop install of the same product, which cannot speak ACP. */
  desktopApp?: string;
}

export interface AgentCliLookup {
  platform: PlatformOs;
  pathEnv: string;
  pathExt?: string;
  isFile(path: string): boolean;
}

export function agentCliById(id: string): AgentCliDefinition | undefined {
  return AGENT_CLIS.find((entry) => entry.id === id);
}

/**
 * Whether the configured agent is exactly what a detected card would start.
 *
 * Compared by path, and by bare name when the setting holds one (`opencode` vs
 * `C:\...\opencode.cmd`), because both spellings end up in settings.json.
 */
export function isDetectedAgentSelected(
  detection: AgentCliDetection,
  agent: { command: string; args: string[] },
): boolean {
  if (!detection.command) return false;
  if (detection.args.length !== agent.args.length) return false;
  if (detection.args.some((arg, index) => arg !== agent.args[index])) return false;

  const configured = agent.command.trim();
  if (!configured) return false;
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  if (normalize(configured) === normalize(detection.command)) return true;
  if (/[\\/]/.test(configured)) return false;
  const base = detection.command.split(/[\\/]/).pop() ?? '';
  return normalize(configured) === normalize(base.replace(/\.(exe|cmd|bat|ps1)$/i, ''));
}
