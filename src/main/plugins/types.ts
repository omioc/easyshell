/**
 * What a plugin is, and what the app hands it.
 *
 * A plugin is an optional capability that plugs into three seams without any of
 * them knowing about it: the command line (a link shape the parser would not
 * otherwise understand), the operating system (URL schemes the bundle declares),
 * and the settings page (one switch). Everything a plugin cannot do for itself —
 * claiming a scheme, reading the settings — is on `PluginHost`, so a plugin file
 * stays a pure description of a protocol.
 */

import type { PlatformOs, Settings } from '../../shared/types';
import type { SshLoginFields } from '../cli/parse';

/** The few things only the running app can do for a plugin. */
export interface PluginHost {
  readonly platform: PlatformOs;
  /** The settings the app is running with right now. */
  settings(): Settings;
  /** Gives this app the OS-wide claim on `scheme`; false when the OS refused. */
  claimUrlScheme(scheme: string): boolean;
  /** Hands a scheme back to whatever client had it before. */
  releaseUrlScheme(scheme: string): void;
}

export interface EasyshellPlugin {
  /** Stable id, also the key the settings page toggles. */
  id: string;
  /** i18n keys for the settings page row. */
  labelKey: string;
  descriptionKey: string;
  /** On unless the user turns it off; `false` is for opt-in capabilities. */
  enabledByDefault: boolean;
  /**
   * The schemes the plugin wants claimed, given the current settings. A plugin
   * reads its own mapping from `settings.plugins`; the runtime only diffs.
   */
  urlSchemes(settings: Settings): readonly string[];
  /** A CLI switch that hands those schemes back to the OS. */
  releaseFlag?: string;
  /** Lines appended to `--help`: this plugin's own entry points. */
  helpLines?(settings: Settings): readonly string[];
  /** True when this token is the plugin's to decode. */
  claims(arg: string, settings: Settings): boolean;
  /** The login the token describes, or null when it is not usable. */
  parse(arg: string, settings: Settings): SshLoginFields | null;
  /** Called when the plugin comes on (startup or a switch). */
  activate?(host: PluginHost): void;
  /** Called when the plugin goes off, before its schemes are released. */
  deactivate?(host: PluginHost): void;
}
