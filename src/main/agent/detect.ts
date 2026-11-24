/**
 * Which of the known ACP agents this machine can actually start.
 *
 * Detection only looks at PATH: it never spawns anything, so opening the
 * settings page cannot hang on a CLI that wants a login. The one exception is
 * implicit — a shim is read as text when the app later plans its launch.
 */
import { AGENT_CLIS } from '../../shared/agents';
import type { AgentCliDetection } from '../../shared/agents';
import { defaultLaunchContext, findExecutable } from './launch';
import type { ExecLookup } from './launch';

/**
 * Expands `%VAR%` and a leading `~` in a known desktop install path.
 *
 * Returns null when a variable is missing: a template that cannot be resolved is
 * simply "not here", never a path built from an empty string.
 */
export function expandDesktopPath(
  template: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let resolved = template;
  if (template.startsWith('~')) {
    const home = env.USERPROFILE ?? env.HOME;
    if (!home) return null;
    resolved = `${home}${template.slice(1)}`;
  }

  let missing = false;
  resolved = resolved.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = env[name];
    if (!value) missing = true;
    return value ?? '';
  });
  return missing || !resolved ? null : resolved;
}

/**
 * One detection per catalog entry, in catalog order.
 *
 * `adapter-missing` is the interesting case: Claude Code and Codex are driven
 * through a separate ACP adapter, so the CLI being installed while the adapter
 * is not is the common state, and the card can say exactly what to install.
 *
 * A desktop install is reported separately: it explains "but I installed it"
 * without pretending the GUI can be started as an ACP agent.
 */
export function detectAgentClis(lookup: ExecLookup = defaultLaunchContext()): AgentCliDetection[] {
  return AGENT_CLIS.map((definition) => {
    const base: AgentCliDetection = {
      id: definition.id,
      state: 'missing',
      command: '',
      args: [],
      install: definition.install,
    };
    if (!definition.acp) return { ...base, state: 'unsupported' };

    const executable = findExecutable(definition.bins, lookup);
    if (executable) {
      return { ...base, state: 'available', command: executable, args: [...definition.args] };
    }

    const host = definition.hostBin ? findExecutable([definition.hostBin], lookup) : null;
    if (host) return { ...base, state: 'adapter-missing', hostCommand: host };

    const desktopApp =
      (definition.desktop ?? [])
        .map((template) => expandDesktopPath(template))
        .find((path): path is string => path !== null && lookup.isFile(path)) ?? null;
    if (desktopApp) return { ...base, desktopApp };

    return base;
  });
}
