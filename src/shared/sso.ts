/**
 * How a bastion hands its session over, as data rather than code.
 *
 * Every vendor names things differently — a different URL scheme, a nested
 * container, `IPv4` instead of `Host`, `Ticket` instead of `SSOToken`. The
 * plugin therefore takes a small mapping from the settings file, and the default
 * one is the USM shape this app was first written against. Nothing here touches
 * Node or Electron, so the settings page, the tests and the main process all
 * read the same rules.
 */

import type { SsoPluginSettings } from './types';

/**
 * Schemes the packaged bundle declares in `Info.plist`.
 *
 * macOS only routes a URL to an app that declared its scheme at build time, so
 * this list mirrors `electron-builder.yml`. Extra schemes can be added at pack
 * time with `EASYSHELL_URL_SCHEMES="usm,jumpserver" npm run dist:mac`; a scheme
 * outside this list cannot be claimed without repackaging.
 */
export const DECLARED_SSO_SCHEMES = ['sso', 'easyshell'] as const;

/** The payload encodings a bastion link uses in practice. */
export const SSO_FORMATS = ['base64-json', 'json'] as const;

/** How many entries a mapping may hold; a hand-edited file must not explode. */
const MAX_SCHEMES = 8;
const MAX_PROTOCOLS = 8;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalises one scheme token: `SSO://` and `sso` both mean `sso`. */
export function normalizeScheme(value: unknown): string {
  return text(value)
    .toLowerCase()
    .replace(/:\/\/.*$/, '')
    .replace(/[^a-z0-9+.-]/g, '');
}

/** Repairs a comma/space separated scheme list from the settings file. */
export function normalizeSchemes(input: unknown, fallback: readonly string[]): string[] {
  const source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const seen = new Set<string>();
  for (const item of source) {
    const scheme = normalizeScheme(item);
    if (!scheme) continue;
    seen.add(scheme);
    if (seen.size >= MAX_SCHEMES) break;
  }
  if (seen.size === 0) return [...fallback];
  return [...seen];
}

function normalizeProtocols(input: unknown, fallback: readonly string[]): string[] {
  if (input === undefined || input === null) return [...fallback];
  const source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  // An empty list is meaningful: it means "accept whatever the bastion says".
  if (source.length === 0) return [];
  const seen = new Set<string>();
  for (const item of source) {
    const protocol = text(item).toLowerCase();
    if (!protocol) continue;
    seen.add(protocol);
    if (seen.size >= MAX_PROTOCOLS) break;
  }
  return seen.size === 0 ? [...fallback] : [...seen];
}

export function createDefaultSsoSettings(): SsoPluginSettings {
  return {
    schemes: ['sso'],
    format: 'base64-json',
    protocols: ['ssh'],
    container: 'NODE_COMMON',
    hostField: 'IPv4',
    portField: 'Port',
    usernameField: 'Username',
    tokenField: 'SSOToken',
  };
}

/** Repairs `plugins.sso` from whatever the settings file held. */
export function normalizeSsoSettings(input: unknown): SsoPluginSettings {
  const fallback = createDefaultSsoSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const raw = input as Partial<SsoPluginSettings>;
  const format = raw.format === 'json' ? 'json' : 'base64-json';
  return {
    schemes: normalizeSchemes(raw.schemes, fallback.schemes),
    format,
    protocols: normalizeProtocols(raw.protocols, fallback.protocols),
    // An empty container is meaningful too: the asset sits at the JSON root.
    container: typeof raw.container === 'string' ? raw.container.trim() : fallback.container,
    hostField: text(raw.hostField) || fallback.hostField,
    portField: text(raw.portField) || fallback.portField,
    usernameField: text(raw.usernameField) || fallback.usernameField,
    tokenField: text(raw.tokenField) || fallback.tokenField,
  };
}
