/**
 * Plugin switches, as the settings page and the main process both read them.
 *
 * A plugin ships with a default and the user's file only records the exceptions,
 * so everything here is pure: the same disabled list decides what the parser
 * sees, what the OS claim covers and what a switch shows.
 */

import type { PluginInfo, PluginSettings } from './types';

/** How many ids a settings file may carry; a deny-list never needs this many. */
const MAX_DISABLED = 64;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Repairs `plugins.disabled` from whatever the settings file held. */
export function normalizeDisabledPlugins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const item of input) {
    const id = text(item);
    if (!id) continue;
    seen.add(id);
    if (seen.size >= MAX_DISABLED) break;
  }
  return [...seen];
}

/** True when the plugin runs: its own default, unless the user said otherwise. */
export function isPluginEnabled(
  plugin: Pick<PluginInfo, 'id' | 'enabledByDefault'>,
  plugins: PluginSettings | undefined,
): boolean {
  const disabled = plugins?.disabled ?? [];
  return disabled.includes(plugin.id) ? false : plugin.enabledByDefault;
}

/** The next `disabled` list after a switch was flipped; returns a new array. */
export function togglePluginDisabled(
  disabled: readonly string[],
  id: string,
  enabled: boolean,
): string[] {
  const rest = disabled.filter((item) => item !== id);
  return enabled ? rest : [...rest, id];
}
