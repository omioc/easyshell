/**
 * Remembered passwords, kept by login rather than by tab.
 *
 * The key is `username@host[:port]`, which is the one thing a password prompt
 * actually tells you and the one thing the answer belongs to: the same account
 * on the same machine wants the same password whether it was reached directly
 * or through a bastion. Everything here is pure so the rules are the same in
 * the main process, the settings page and the tests.
 */

import type { SshCredential } from './types';

/** How many logins may be remembered; enough for years of ad-hoc hosts. */
const MAX_CREDENTIALS = 200;

const DEFAULT_SSH_PORT = 22;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The port a login is on, as the vault records it: absent means 22. */
export function credentialPort(port: unknown): number | undefined {
  const parsed = typeof port === 'number' ? port : Number.parseInt(String(port ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return Math.floor(parsed) === DEFAULT_SSH_PORT ? undefined : Math.floor(parsed);
}

/** What tells two remembered logins apart. Case-insensitive, port included. */
export function credentialKey(target: { username: string; host: string; port?: number }): string {
  const port = credentialPort(target.port);
  return `${text(target.username).toLowerCase()}@${text(target.host).toLowerCase()}${
    port === undefined ? '' : `:${port}`
  }`;
}

/** `user@host`, or `user@host:port` when the login is not on 22. */
export function credentialLabel(target: { username: string; host: string; port?: number }): string {
  const port = credentialPort(target.port);
  return `${text(target.username)}@${text(target.host)}${port === undefined ? '' : `:${port}`}`;
}

export function sameCredentialTarget(
  a: { username: string; host: string; port?: number },
  b: { username: string; host: string; port?: number },
): boolean {
  return credentialKey(a) === credentialKey(b);
}

/** A credential that can actually be used, from whatever is on disk. */
function repair(input: unknown): SshCredential | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<SshCredential>;
  const username = text(raw.username);
  const host = text(raw.host);
  const password = typeof raw.password === 'string' ? raw.password : '';
  // An entry with no password would fill nothing into a prompt, and one with no
  // host cannot be matched: both would only take up room.
  if (!username || !host || !password) return null;
  const now = Date.now();
  const at = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    id: text(raw.id) || `cred-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    host,
    port: credentialPort(raw.port),
    password,
    createdAt: at(raw.createdAt, now),
    updatedAt: at(raw.updatedAt, now),
    lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : undefined,
  };
}

/**
 * Repairs whatever `settings.json` holds.
 *
 * Duplicates are impossible by construction — the same login can only have one
 * password — so the last entry for a key wins, which is what a file edited by
 * hand (or an older app) leaves behind.
 */
export function normalizeCredentials(input: unknown): SshCredential[] {
  if (!Array.isArray(input)) return [];
  const byKey = new Map<string, SshCredential>();
  for (const item of input) {
    const entry = repair(item);
    if (!entry) continue;
    const key = credentialKey(entry);
    const previous = byKey.get(key);
    if (previous && previous.updatedAt > entry.updatedAt) continue;
    byKey.set(key, { ...entry, id: previous?.id ?? entry.id });
  }
  return [...byKey.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CREDENTIALS);
}

export function findCredential(
  credentials: readonly SshCredential[],
  target: { username: string; host: string; port?: number },
): SshCredential | undefined {
  const key = credentialKey(target);
  return credentials.find((entry) => credentialKey(entry) === key);
}

export function hasPassword(
  credentials: readonly SshCredential[],
  target: { username: string; host: string; port?: number },
  password: string,
): boolean {
  return credentials.some(
    (entry) => credentialKey(entry) === credentialKey(target) && entry.password === password,
  );
}

/** Adds or replaces the password for one login; returns a new list. */
export function upsertCredential(
  credentials: readonly SshCredential[],
  entry: SshCredential,
): SshCredential[] {
  const key = credentialKey(entry);
  const existing = credentials.find((item) => credentialKey(item) === key);
  const stamped: SshCredential = existing
    ? { ...entry, id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() }
    : { ...entry, updatedAt: Date.now() };
  // Replacing keeps the entry where it was, so the list does not reshuffle under
  // the pointer while a password is being updated.
  const next = existing
    ? credentials.map((item) => (credentialKey(item) === key ? stamped : item))
    : [...credentials, stamped];
  return next.slice(-MAX_CREDENTIALS).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function removeCredential(credentials: readonly SshCredential[], id: string): SshCredential[] {
  return credentials.filter((entry) => entry.id !== id);
}
/** Marks one entry as just used; returns a new list. */
export function touchCredential(
  credentials: readonly SshCredential[],
  id: string,
): SshCredential[] {
  const now = Date.now();
  return credentials.map((entry) =>
    entry.id === id ? { ...entry, lastUsedAt: now } : entry,
  );
}
