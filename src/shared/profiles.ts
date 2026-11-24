/**
 * Saved SSH connections.
 *
 * Pure helpers shared by the renderer (list, form, menu), the main process
 * (validation on load) and the unit tests, so a profile means the same thing
 * everywhere and can be turned into a `SessionSpec` without duplicating rules.
 */

import type { HostKeyPolicy, SessionSpec, SshHostFacts, SshProfile } from './types';

export const DEFAULT_SSH_PORT = 22;

const MAX_PORT = 65535;

export function normalizePort(value: unknown, fallback = DEFAULT_SSH_PORT): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_PORT, Math.floor(parsed));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
  const trimmed = text(value);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Keeps facts that came off disk usable: a profile whose `detected` block is
 * malformed loses it rather than showing a tile for a system nobody confirmed.
 */
function normalizeHostFacts(value: unknown): SshHostFacts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const facts = value as Partial<SshHostFacts>;
  if (typeof facts.linux !== 'boolean') return undefined;
  const distribution = optionalText(facts.distribution);
  const at = typeof facts.at === 'number' && Number.isFinite(facts.at) ? facts.at : Date.now();
  return distribution ? { linux: facts.linux, distribution, at } : { linux: facts.linux, at };
}

export function createSshProfile(partial: Partial<SshProfile> = {}): SshProfile {
  const now = Date.now();
  return {
    id: optionalText(partial.id) ?? `ssh-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: text(partial.name),
    host: text(partial.host),
    port: normalizePort(partial.port),
    username: text(partial.username),
    authType: partial.authType === 'key' || partial.authType === 'agent' ? partial.authType : 'password',
    password: optionalText(partial.password),
    privateKeyPath: optionalText(partial.privateKeyPath),
    passphrase: optionalText(partial.passphrase),
    hostKeyPolicy: partial.hostKeyPolicy,
    notes: optionalText(partial.notes),
    detected: normalizeHostFacts(partial.detected),
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    lastUsedAt: partial.lastUsedAt,
  };
}

/** Repairs whatever is in `settings.json` into a usable list. */
export function normalizeSshProfiles(input: unknown): SshProfile[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: SshProfile[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const profile = createSshProfile(item as Partial<SshProfile>);
    let id = profile.id;
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    seen.add(id);
    result.push({ ...profile, id });
  }
  return result;
}

export interface SshProfileIssue {
  field: 'name' | 'host' | 'username' | 'port' | 'privateKeyPath';
  /** i18n key, resolved by the UI. */
  key: string;
}

export function validateSshProfile(profile: SshProfile): SshProfileIssue[] {
  const issues: SshProfileIssue[] = [];
  if (!text(profile.host)) issues.push({ field: 'host', key: 'newSession.hostRequired' });
  if (!text(profile.username)) issues.push({ field: 'username', key: 'newSession.userRequired' });
  const port = Number(profile.port);
  if (!Number.isFinite(port) || port <= 0 || port > MAX_PORT) {
    issues.push({ field: 'port', key: 'newSession.portInvalid' });
  }
  if (profile.authType === 'key' && !text(profile.privateKeyPath)) {
    issues.push({ field: 'privateKeyPath', key: 'newSession.keyRequired' });
  }
  return issues;
}

export function sshProfileTarget(profile: SshProfile): string {
  const user = profile.username ? `${profile.username}@` : '';
  const port = profile.port && profile.port !== DEFAULT_SSH_PORT ? `:${profile.port}` : '';
  return `${user}${profile.host}${port}`;
}

export function sshProfileTitle(profile: SshProfile): string {
  return profile.name || sshProfileTarget(profile) || profile.host;
}

export interface BuildSshSpecOptions {
  hostKeyPolicy: HostKeyPolicy;
}

/** Turns a saved profile into a session request, or `null` when it is incomplete. */
export function buildSshSpecFromProfile(
  profile: SshProfile,
  options: BuildSshSpecOptions,
): SessionSpec | null {
  if (validateSshProfile(profile).length > 0) return null;
  const auth =
    profile.authType === 'password'
      ? { type: 'password' as const, password: profile.password ?? '' }
      : profile.authType === 'key'
        ? {
            type: 'key' as const,
            privateKeyPath: profile.privateKeyPath as string,
            passphrase: profile.passphrase,
          }
        : { type: 'agent' as const };

  return {
    kind: 'ssh',
    target: {
      host: profile.host,
      port: normalizePort(profile.port),
      username: profile.username,
      auth,
      hostKeyPolicy: profile.hostKeyPolicy ?? options.hostKeyPolicy,
    },
    title: sshProfileTitle(profile),
    origin: { type: 'ui' },
  };
}

/** Upsert by id; returns a new array so React state updates reliably. */
export function upsertSshProfile(profiles: SshProfile[], profile: SshProfile): SshProfile[] {
  const stamped: SshProfile = { ...profile, updatedAt: Date.now() };
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index < 0) return [...profiles, stamped];
  const next = [...profiles];
  next[index] = stamped;
  return next;
}

export function removeSshProfile(profiles: SshProfile[], id: string): SshProfile[] {
  return profiles.filter((item) => item.id !== id);
}

/**
 * Records what a session learned about the machine, on the saved connections
 * that point at it.
 *
 * Matching is by address and port rather than by id: the same box is often saved
 * twice (once as a jump host, once per login user) and every row that opens it
 * should show what it is. Returns null when nothing changed, so a caller does not
 * rewrite settings on every probe cycle.
 */
export function recordHostFacts(
  profiles: readonly SshProfile[],
  address: { host?: string; port?: number },
  facts: { linux: boolean; distribution?: string },
  at: number,
): SshProfile[] | null {
  const host = text(address.host).toLowerCase();
  if (!host) return null;
  const port = normalizePort(address.port);
  const distribution = optionalText(facts.distribution);
  const learned: SshHostFacts = distribution
    ? { linux: facts.linux, distribution, at }
    : { linux: facts.linux, at };
  let changed = false;

  const result = profiles.map((profile) => {
    if (text(profile.host).toLowerCase() !== host) return profile;
    if (normalizePort(profile.port) !== port) return profile;
    const before = profile.detected;
    const same =
      before !== undefined &&
      before.linux === learned.linux &&
      (before.distribution ?? '') === (learned.distribution ?? '');
    if (same) return profile;
    changed = true;
    return { ...profile, detected: learned };
  });

  return changed ? result : null;
}