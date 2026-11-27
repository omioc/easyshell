/**
 * The plugin registry.
 *
 * Adding a capability is a file next to `sso.ts` and one line in `PLUGINS`;
 * nothing else in the app has to change. What the registry does at run time is
 * keep the set of live plugins and the schemes they own equal to the settings:
 * a switch, or a scheme edited in a plugin's form, claims and releases exactly
 * the difference — never re-registering a scheme that was already claimed.
 */

import { isPluginEnabled } from '../../shared/plugins';
import type { PluginInfo, Settings } from '../../shared/types';
import type { CliLinkPlugin } from '../cli/parse';
import { ssoPlugin } from './sso';
import type { EasyshellPlugin, PluginHost } from './types';

/** Every plugin this build ships, in the order a link is offered to them. */
export const PLUGINS: readonly EasyshellPlugin[] = [ssoPlugin];

export type { EasyshellPlugin, PluginHost } from './types';
export { matchScheme, parseSsoLink, ssoPlugin } from './sso';

export function findPlugin(id: string): EasyshellPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.id === id);
}

/** What the settings page draws: the catalog, without the running state. */
export function pluginCatalog(): PluginInfo[] {
  return PLUGINS.map((plugin) => ({
    id: plugin.id,
    labelKey: plugin.labelKey,
    descriptionKey: plugin.descriptionKey,
    enabledByDefault: plugin.enabledByDefault,
  }));
}

/**
 * The link shapes the parser should understand, given the current settings.
 *
 * The adapter closes over the settings so the parser keeps its pure one-argument
 * shape: a token a plugin claims is decoded with the mapping the user chose.
 */
export function linkPlugins(settings: Settings): CliLinkPlugin[] {
  return PLUGINS.filter((plugin) => isPluginEnabled(plugin, settings.plugins)).map((plugin) => ({
    id: plugin.id,
    claims: (arg: string) => plugin.claims(arg, settings),
    parse: (arg: string) => plugin.parse(arg, settings),
  }));
}

/** `--help` lines contributed by every plugin in the build. */
export function pluginHelpLines(settings: Settings): string[] {
  return PLUGINS.flatMap((plugin) => [...(plugin.helpLines?.(settings) ?? [])]);
}

/** The plugin a release switch in `argv` asks for, if any. */
export function releaseRequest(argv: readonly string[]): EasyshellPlugin | undefined {
  return PLUGINS.find(
    (plugin) => plugin.releaseFlag !== undefined && argv.includes(plugin.releaseFlag),
  );
}

/**
 * Keeps the live plugins — and the OS claims they own — in step with settings.
 *
 * `sync` is idempotent and diffs by scheme, because both the switch and the
 * plugin's own form can change what it should own. Re-claiming a scheme on every
 * unrelated settings write would re-register it with LaunchServices each time.
 */
export class PluginRuntime {
  private readonly active = new Set<string>();
  private readonly claimed = new Map<string, string[]>();

  constructor(private readonly host: PluginHost) {}

  sync(settings: Settings): void {
    for (const plugin of PLUGINS) {
      const wanted = isPluginEnabled(plugin, settings.plugins);
      const running = this.active.has(plugin.id);

      if (wanted && !running) {
        this.active.add(plugin.id);
        plugin.activate?.(this.host);
      } else if (!wanted && running) {
        this.active.delete(plugin.id);
        plugin.deactivate?.(this.host);
      }

      const desired = wanted ? [...new Set(plugin.urlSchemes(settings))] : [];
      const current = this.claimed.get(plugin.id) ?? [];
      const added = desired.filter((scheme) => !current.includes(scheme));
      const dropped = current.filter((scheme) => !desired.includes(scheme));

      for (const scheme of dropped) this.host.releaseUrlScheme(scheme);
      for (const scheme of added) this.host.claimUrlScheme(scheme);

      if (desired.length > 0) this.claimed.set(plugin.id, desired);
      else this.claimed.delete(plugin.id);
    }
  }

  /** True when a plugin is live right now, without asking the settings again. */
  isActive(id: string): boolean {
    return this.active.has(id);
  }
}
