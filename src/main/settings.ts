import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { API_DEFAULT_PORT, SETTINGS_VERSION, createDefaultSettings } from '@shared/defaults';
import { isAgentPermissionMode } from '@shared/agent';
import type { DeepPartial, PlatformOs, Settings } from '@shared/types';
import { normalizeSshProfiles } from '../shared/profiles';
import { normalizeCredentials } from '../shared/credentials';
import { normalizeWorkspaces, pruneWorkspaces } from '../shared/workspaces';
import { paths } from './paths';
import { type SecretCipher, createSecretCipher, isSealed } from './secrets';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge where arrays are replaced, not concatenated. */
export function mergeSettings<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch as T) ?? base;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergeSettings(current, value) : value;
  }
  return result as T;
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Terminal stacks this app shipped as defaults before it bundled a face.
 *
 * A family that still matches one of these was never edited by the user, so it
 * follows the app to the bundled font instead of pinning an install to the
 * system monospace it was created with.
 */
const LEGACY_TERMINAL_FONTS = new Set([
  'Cascadia Mono, Consolas, JetBrains Mono, monospace',
  'SF Mono, Menlo, JetBrains Mono, monospace',
]);
/** Fills in missing fields and repairs values that would break at runtime. */
export function normalizeSettings(input: DeepPartial<Settings>, platform: PlatformOs): Settings {
  const defaults = createDefaultSettings(platform);
  const merged = mergeSettings(defaults, input);
  merged.version = SETTINGS_VERSION;
  if (!Array.isArray(merged.shell.profiles) || merged.shell.profiles.length === 0) {
    merged.shell.profiles = defaults.shell.profiles;
  }
  if (!merged.shell.profiles.some((profile) => profile.id === merged.shell.defaultProfileId)) {
    merged.shell.defaultProfileId = merged.shell.profiles[0]?.id ?? defaults.shell.defaultProfileId;
  }
  merged.ssh.profiles = normalizeSshProfiles(merged.ssh.profiles);
  merged.workspaces = pruneWorkspaces(normalizeWorkspaces(merged.workspaces), merged.ssh.profiles);
  // Remembered logins are repaired like hosts are: an entry without a password,
  // a username or a host cannot answer anything and is dropped.
  merged.vault = { credentials: normalizeCredentials(merged.vault?.credentials) };
  if (!merged.api.token) merged.api.token = generateToken();
  merged.api.port = clampNumber(merged.api.port, 1, 65535, API_DEFAULT_PORT);
  merged.probe.intervalMs = clampNumber(merged.probe.intervalMs, 5000, 600000, defaults.probe.intervalMs);
  merged.ssh.defaultPort = clampNumber(merged.ssh.defaultPort, 1, 65535, 22);
  merged.ssh.keepAliveSeconds = clampNumber(merged.ssh.keepAliveSeconds, 0, 3600, 30);
  merged.appearance.fontSize = clampNumber(merged.appearance.fontSize, 8, 32, 13);
  merged.appearance.lineHeight = clampNumber(merged.appearance.lineHeight, 1, 2.4, 1.25);
  merged.appearance.letterSpacing = clampNumber(merged.appearance.letterSpacing, 0, 4, 1);
  if (LEGACY_TERMINAL_FONTS.has(merged.appearance.fontFamily.trim())) {
    merged.appearance.fontFamily = defaults.appearance.fontFamily;
  }
  merged.agent = normalizeAgentSettings(merged.agent, defaults);
  merged.layout = {
    sidebarCollapsed: Boolean(merged.layout?.sidebarCollapsed),
    sessionOrder: normalizeSessionOrder(merged.layout?.sessionOrder),
  };
  return merged;
}

/**
 * The sidebar order is a list of keys the user arranged by hand: keep the
 * strings, drop anything else, and never let a duplicate or a runaway file
 * fight the drag that produced it.
 */
function normalizeSessionOrder(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    if (order.length >= 200) break;
  }
  return order;
}

/**
 * The agent block is the one place where a half-written value can spawn a
 * process or lift the permission gate, so every field is repaired here rather
 * than trusted from disk or from a settings patch.
 */
function normalizeAgentSettings(input: Settings['agent'], defaults: Settings): Settings['agent'] {
  const fallback = defaults.agent;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...fallback };
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const args = Array.isArray(input.args) ? input.args.filter((arg) => typeof arg === 'string') : [];
  const env: Record<string, string> = {};
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return {
    enabled: Boolean(input.enabled) && command.length > 0,
    command,
    args,
    env,
    permissionMode: isAgentPermissionMode(input.permissionMode)
      ? input.permissionMode
      : fallback.permissionMode,
    commandTimeoutMs: clampNumber(
      input.commandTimeoutMs,
      5_000,
      1_800_000,
      fallback.commandTimeoutMs,
    ),
    classifyTimeoutMs: clampNumber(
      input.classifyTimeoutMs,
      3_000,
      120_000,
      fallback.classifyTimeoutMs,
    ),
    contextTailLines: clampNumber(input.contextTailLines, 0, 200, fallback.contextTailLines),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/* ------------------------------------------------------------ secrets at rest */

/** The host fields that hold a secret. A name, a port, a hostname are all safe. */
const PROFILE_SECRET_FIELDS = ['password', 'passphrase'] as const;

/** A remembered login has exactly one secret. */
const CREDENTIAL_SECRET_FIELDS = ['password'] as const;

/** Rewrites the named string fields of one object, keeping everything else. */
function rewriteSecretFields<T>(item: T, fields: readonly string[], rewrite: (value: string) => string): T {
  if (!isPlainObject(item)) return item;
  const next: Record<string, unknown> = { ...item };
  for (const field of fields) {
    const value = next[field];
    if (typeof value === 'string' && value.length > 0) next[field] = rewrite(value);
  }
  return next as T;
}

/** Rewrites every secret the settings file carries: hosts and the vault. */
function mapSecretFields(
  input: DeepPartial<Settings>,
  rewrite: (value: string) => string,
): DeepPartial<Settings> {
  let next = input;
  const profiles = input.ssh?.profiles;
  if (Array.isArray(profiles)) {
    next = {
      ...next,
      ssh: {
        ...next.ssh,
        profiles: profiles.map((profile) =>
          rewriteSecretFields(profile, PROFILE_SECRET_FIELDS, rewrite),
        ),
      },
    } as DeepPartial<Settings>;
  }
  const credentials = input.vault?.credentials;
  if (Array.isArray(credentials)) {
    next = {
      ...next,
      vault: {
        ...next.vault,
        credentials: credentials.map((entry) =>
          rewriteSecretFields(entry, CREDENTIAL_SECRET_FIELDS, rewrite),
        ),
      },
    } as DeepPartial<Settings>;
  }
  return next;
}

/** The form a host's password and passphrase take inside `settings.json`. */
export function sealSettingsSecrets(
  settings: DeepPartial<Settings>,
  cipher: SecretCipher,
): DeepPartial<Settings> {
  return mapSecretFields(settings, (value) => cipher.seal(value));
}

/** The shape the rest of the app expects: passwords it can actually type in. */
export function openSettingsSecrets(
  settings: DeepPartial<Settings>,
  cipher: SecretCipher,
): DeepPartial<Settings> {
  return mapSecretFields(settings, (value) => cipher.open(value));
}

/** True when the file still holds a value the key store has to open. */
export function hasSealedSecrets(settings: DeepPartial<Settings>): boolean {
  let found = false;
  mapSecretFields(settings, (value) => {
    if (isSealed(value)) found = true;
    return value;
  });
  return found;
}

export class SettingsStore extends EventEmitter {
  private current: Settings;
  private secretsSettled = false;

  /**
   * `cipher` is what seals the saved passwords; the default seals nothing, which
   * is what callers outside Electron (and every test) get.
   */
  constructor(
    private readonly platform: PlatformOs,
    private readonly cipher: SecretCipher = createSecretCipher(null),
  ) {
    super();
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /** True when this machine can keep saved passwords sealed on disk. */
  get secretsEncrypted(): boolean {
    return this.cipher.available();
  }

  /**
   * Finishes the secret work the constructor could not do.
   *
   * The store is built while the command line is still being parsed, and the OS
   * key store answers nothing before the app is ready. So the first load may
   * have left values sealed; this opens them, then writes the file back so a
   * password that was stored in the open is sealed for good. Called once, from
   * the ready path, before any window exists.
   */
  settleSecrets(): void {
    if (this.secretsSettled) return;
    this.secretsSettled = true;
    if (this.cipher.available()) {
      this.current = normalizeSettings(openSettingsSecrets(this.current, this.cipher), this.platform);
    }
    this.persist();
    this.emit('change', this.current);
  }

  update(patch: DeepPartial<Settings>): Settings {
    const next = normalizeSettings(mergeSettings(this.current, patch), this.platform);
    this.current = next;
    this.persist();
    this.emit('change', next);
    return next;
  }

  private load(): Settings {
    try {
      if (existsSync(paths.settingsFile)) {
        const raw = readFileSync(paths.settingsFile, 'utf8');
        const parsed = JSON.parse(raw) as DeepPartial<Settings>;
        // Before `ready` the key store opens nothing, and those values stay sealed
        // until settleSecrets() runs; a plain-text value from an older file is
        // returned as it is and sealed on the write below.
        const opened = openSettingsSecrets(parsed, this.cipher);
        const normalized = normalizeSettings(opened, this.platform);
        this.current = normalized;
        this.persist();
        return normalized;
      }
    } catch {
      // Corrupt settings must never prevent the app from starting.
    }
    const fresh = normalizeSettings({}, this.platform);
    this.current = fresh;
    this.persist();
    return fresh;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(paths.settingsFile), { recursive: true });
      const sealed = sealSettingsSecrets(this.current, this.cipher);
      writeFileSync(paths.settingsFile, JSON.stringify(sealed, null, 2), 'utf8');
    } catch {
      // Losing a settings write is annoying but not fatal.
    }
  }
}