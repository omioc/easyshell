/**
 * Bastion single sign-on, as a plugin.
 *
 * A bastion does not speak a protocol either: its web page opens a local client
 * with a link. The link carries the portal login, a one-time token and the
 * bastion's own SSH entry; the asset behind it is reached through that entry, so
 * the session is a plain password login to the bastion with the token as the
 * password — `sshpass -p <token> ssh -p <port> <user>@<host>`.
 *
 * Vendors disagree about every part of the shape, so all of it comes from
 * `settings.plugins.sso` (see `src/shared/sso.ts`): the scheme, the encoding, the
 * container key and the four field names. The defaults are the USM shape this app
 * was first written against, and field lookup falls back to common aliases, so a
 * bastion that renames `IPv4` to `Host` still works without a form.
 *
 * The one thing settings cannot change is what macOS will deliver: a scheme has
 * to be declared in `Info.plist` at build time (`EASYSHELL_URL_SCHEMES=…`), which
 * is why the settings page names the declared ones.
 *
 * Only SSH assets are handled: this app has no VNC/SFTP/RDP surface to fall back
 * to, and a token is one-time — a payload that is not an SSH login returns null
 * rather than opening something that cannot work.
 */

import { createDefaultSsoSettings } from '../../shared/sso';
import type { SshLoginFields } from '../cli/parse';
import type { SsoPluginSettings } from '../../shared/types';
import type { EasyshellPlugin } from './types';

/** Keys that name each part of the login when the configured one is absent. */
const HOST_ALIASES = ['ipv4', 'host', 'hostname', 'ip', 'address', 'addr'];
const PORT_ALIASES = ['port'];
const USER_ALIASES = ['username', 'user', 'login', 'account'];
const TOKEN_ALIASES = ['ssotoken', 'token', 'ticket', 'password', 'onetimepassword'];
const PROTOCOL_ALIASES = ['assetprotocol', 'protocol', 'type'];

type Fields = Record<string, unknown>;

function asRecord(value: unknown): Fields | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

/** One object with every key lower-cased: bastions are inconsistent about case. */
function lowerKeyed(node: Fields): Fields {
  const keyed: Fields = {};
  for (const [key, value] of Object.entries(node)) keyed[key.toLowerCase()] = value;
  return keyed;
}

/** The configured field first, then the aliases: a renamed field still lands. */
function pick(node: Fields, configured: string, aliases: readonly string[]): unknown {
  const key = configured.trim().toLowerCase();
  if (key && key in node) return node[key];
  for (const alias of aliases) {
    if (alias in node) return node[alias];
  }
  return undefined;
}

/** The scheme this link uses, or null when it is not one of ours. */
export function matchScheme(url: string, schemes: readonly string[]): string | null {
  const trimmed = url.trim();
  const index = trimmed.indexOf('://');
  if (index <= 0) return null;
  const scheme = trimmed.slice(0, index).toLowerCase();
  return schemes.includes(scheme) ? scheme : null;
}

/** The JSON a link carries, decoded according to the configured encoding. */
function decodePayload(body: string, format: SsoPluginSettings['format']): unknown {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    // The link travelled through a browser location, so even a bare JSON payload
    // may arrive percent-encoded.
    const decoded = decodeURIComponent(trimmed);
    if (format === 'json') return JSON.parse(decoded);
    // Base64url is what survives a URL unharmed; both alphabets are accepted.
    const base64 = decoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** The asset object: under the configured container, or at the payload root. */
function pickContainer(payload: unknown, container: string): Fields | null {
  const root = asRecord(payload);
  if (!root) return null;
  const key = container.trim().toLowerCase();
  if (!key) return root;
  // Some bastions omit the container even though their siblings use it: the root
  // is the better guess than refusing a login that would work.
  return asRecord(lowerKeyed(root)[key]) ?? root;
}

/** The SSH login a link describes, or null when it is not usable. */
export function parseSsoLink(
  url: string,
  config: SsoPluginSettings = createDefaultSsoSettings(),
): SshLoginFields | null {
  const scheme = matchScheme(url, config.schemes);
  if (!scheme) return null;

  const asset = pickContainer(decodePayload(url.trim().slice(scheme.length + 3), config.format), config.container);
  if (!asset) return null;

  const fields = lowerKeyed(asset);
  if (config.protocols.length > 0) {
    const protocol = String(pick(fields, '', PROTOCOL_ALIASES) ?? '').toLowerCase();
    if (protocol && !config.protocols.includes(protocol)) return null;
  }

  const host = pick(fields, config.hostField, HOST_ALIASES);
  if (typeof host !== 'string' || !host.trim()) return null;

  const port = Number(pick(fields, config.portField, PORT_ALIASES));
  const username = pick(fields, config.usernameField, USER_ALIASES);
  const token = pick(fields, config.tokenField, TOKEN_ALIASES);

  return {
    host: host.trim(),
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    username: typeof username === 'string' && username.trim() ? username.trim() : undefined,
    password: typeof token === 'string' && token ? token : undefined,
  };
}

export const ssoPlugin: EasyshellPlugin = {
  id: 'sso',
  labelKey: 'plugin.sso.label',
  descriptionKey: 'plugin.sso.description',
  enabledByDefault: true,
  urlSchemes: (settings) => settings.plugins.sso.schemes,
  releaseFlag: '--release-sso',
  helpLines: (settings) => {
    const scheme = settings.plugins.sso.schemes[0] ?? 'sso';
    return [
      `  easyshell ${scheme}://<payload>     bastion link (also via open-url)`,
      '  easyshell --release-sso       give the bastion schemes back to the vendor client',
    ];
  },
  claims: (arg, settings) => matchScheme(arg, settings.plugins.sso.schemes) !== null,
  parse: (arg, settings) => parseSsoLink(arg, settings.plugins.sso),
};
