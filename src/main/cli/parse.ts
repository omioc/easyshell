/**
 * Command line parsing.
 *
 * Bastion portals do not speak a protocol: they spawn a process with a command
 * line that was copied from the client they think they are talking to. This
 * module turns those shapes into `SessionSpec` values.
 *
 * Supported shapes (all verified against real portals / clients):
 *   easyshell -newtab "sshpass -p TOKEN ssh -p 60022 user_TOKEN@198.18.0.7"   MobaXterm
 *   easyshell -newtab "ssh -i ~/.ssh/id_ed25519 -p 22 root@198.18.0.7"
 *   easyshell -url ssh://root@198.18.0.7:22 -pw secret                      Xshell
 *   easyshell -ssh 198.18.0.7 -l root -p 22 -pw secret                      Xshell (legacy)
 *   easyshell --wsl Ubuntu | --local powershell | --ssh root@198.18.0.7     native
 *   easyshell ls | info <id> | exec <id> -- uname -a | probe <id>          control client
 *
 * Pure functions only: no Electron, no I/O, so the whole matrix is unit tested.
 */

import type { HostKeyPolicy, Locale, SessionSpec, ShellProfile } from '../../shared/types';

/**
 * A link shape one plugin adds to the command line.
 *
 * The parser knows none of them: a plugin says which tokens are its own
 * (`sso://…`) and what login they describe, and the same `SessionSpec` a
 * copied `ssh` line produces comes out. A token a plugin claims but cannot
 * decode is dropped on purpose — falling through would open a local shell on
 * the text of a broken bastion link, which is worse than nothing.
 */
export interface CliLinkPlugin {
  /** Stable id, also the key the settings page toggles. */
  id: string;
  claims(arg: string): boolean;
  parse(arg: string): SshLoginFields | null;
}

export interface CliParseContext {
  defaultSshPort: number;
  hostKeyPolicy: HostKeyPolicy;
  defaultUsername: string;
  profiles: ShellProfile[];
  defaultProfileId: string;
  defaultDistribution?: string;
  /** Plugins the user has left on; absent means none. */
  plugins?: readonly CliLinkPlugin[];
}

export type CliCommand =
  | { type: 'spawn'; specs: SessionSpec[]; activate: boolean; locale?: Locale }
  | { type: 'api'; command: 'ls' | 'info' | 'exec' | 'probe' | 'input'; args: string[] }
  | { type: 'help' }
  | { type: 'version' }
  | { type: 'none' };

type Origin = { type: 'cli'; raw: string; via: 'newtab' | 'xshell' | 'url' | 'native' };

const TRUE_FLAGS = new Set(['-N', '-v', '-vv', '-A', '-4', '-6', '-T', '-q', '-C']);

/** Shell-like tokenizer: single quotes, double quotes, backslash escapes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < line.length) {
        i += 1;
        current += line[i];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      if (current.length > 0 || hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    if (char === '\\' && i + 1 < line.length) {
      i += 1;
      current += line[i];
      continue;
    }
    current += char;
  }
  if (current.length > 0 || hasContent) tokens.push(current);
  return tokens;
}

export interface SshLoginFields {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  remoteCommand?: string;
}

function splitUserHost(target: string): { username?: string; host?: string } {
  const at = target.lastIndexOf('@');
  if (at < 0) return { host: target || undefined };
  const username = target.slice(0, at);
  const host = target.slice(at + 1);
  return { username: username || undefined, host: host || undefined };
}

/** Parses the inner command line of `-newtab "<command>"`. */
export function parseSshCommandLine(line: string): SshLoginFields | null {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;

  // telnet host [port]
  if (tokens[0] === 'telnet') {
    const host = tokens[1];
    const port = Number(tokens[2]);
    return host ? { host, port: Number.isFinite(port) ? port : undefined } : null;
  }

  let index = 0;
  let password: string | undefined;

  // sshpass -p TOKEN ssh ...
  while (index < tokens.length && tokens[index] !== 'ssh' && tokens[index] !== 'mosh' && tokens[index] !== 'plink') {
    const token = tokens[index];
    if (index === 0 && token !== 'sshpass') return null;
    if (token === '-p' || token === '-P' || token === '--password') {
      password = tokens[index + 1];
      index += 2;
      continue;
    }
    index += 1;
  }
  if (index >= tokens.length) return null;

  index += 1;
  const fields: SshLoginFields = { password };
  const trailing: string[] = [];

  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (fields.host) {
      // Everything after the destination is a remote command.
      trailing.push(token);
      index += 1;
      continue;
    }
    if (token === '-p' || token === '-P' || token === '--port') {
      const value = Number(tokens[index + 1]);
      if (Number.isFinite(value) && value > 0) fields.port = value;
      index += 2;
      continue;
    }
    if (token === '-l' || token === '--user') {
      fields.username = tokens[index + 1];
      index += 2;
      continue;
    }
    if (token === '-pw' || token === '--password') {
      fields.password = tokens[index + 1];
      index += 2;
      continue;
    }
    if (token === '-i' || token === '--identity') {
      fields.privateKeyPath = tokens[index + 1];
      index += 2;
      continue;
    }
    if (token === '-o' || token === '-O' || token === '-L' || token === '-R' || token === '-D' || token === '-W' || token === '-b' || token === '-c') {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      // Unknown switches are single tokens: a portal's extra flag must never
      // swallow the destination that follows it.
      index += 1;
      continue;
    }
    if (!fields.host) {
      const { username, host } = splitUserHost(token);
      fields.host = host;
      if (username) fields.username = username;
      index += 1;
      continue;
    }
    trailing.push(token);
    index += 1;
  }

  if (trailing.length > 0) fields.remoteCommand = trailing.join(' ');
  return fields.host ? fields : null;
}

export function parseSshUrl(url: string): SshLoginFields | null {
  const match = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\/?$/i.exec(url.trim());
  if (!match) return null;
  const [, username, host, port] = match;
  const parsedPort = port ? Number(port) : undefined;
  return { username: username ?? undefined, host: host ?? undefined, port: parsedPort };
}

function buildSshSpec(
  fields: SshLoginFields,
  ctx: CliParseContext,
  origin: Origin,
): SessionSpec {
  const host = fields.host as string;
  const username = fields.username ?? ctx.defaultUsername;
  const auth = fields.password
    ? ({ type: 'password', password: fields.password } as const)
    : fields.privateKeyPath
      ? ({ type: 'key', privateKeyPath: fields.privateKeyPath } as const)
      : ({ type: 'agent' } as const);

  return {
    kind: 'ssh',
    target: {
      host,
      port: fields.port ?? ctx.defaultSshPort,
      username,
      auth,
      hostKeyPolicy: ctx.hostKeyPolicy,
    },
    title: `${username}@${host}`,
    // `ssh host uptime` means "run this and exit"; the closest thing a
    // terminal can do is type it into the fresh shell.
    initialCommand: fields.remoteCommand,
    origin,
  };
}

function buildLocalSpec(ctx: CliParseContext, origin: Origin, command?: string): SessionSpec {
  const profile =
    ctx.profiles.find((item) => item.id === ctx.defaultProfileId) ?? ctx.profiles[0];
  return {
    kind: 'local',
    profileId: profile?.id ?? 'default',
    command: profile?.command ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
    args: profile?.args ?? [],
    title: profile?.label,
    initialCommand: command,
    origin,
  };
}

function buildWslSpec(ctx: CliParseContext, origin: Origin, distribution?: string): SessionSpec {
  return {
    kind: 'wsl',
    distribution: distribution ?? ctx.defaultDistribution ?? '',
    origin,
  };
}

/**
 * Offers one token to the plugins, in registration order.
 *
 * Returns true when a plugin claimed it, whether or not the link decodes: a
 * claimed token is the plugin's to drop, and a broken bastion link must not fall
 * through to the local-shell branch that would type `sso://…` into a shell.
 */
function pluginLink(arg: string, ctx: CliParseContext, raw: string, specs: SessionSpec[]): boolean {
  for (const plugin of ctx.plugins ?? []) {
    if (!plugin.claims(arg)) continue;
    const fields = plugin.parse(arg);
    if (fields) specs.push(buildSshSpec(fields, ctx, { type: 'cli', raw, via: 'url' }));
    return true;
  }
  return false;
}

export function parseInvocation(argv: readonly string[], ctx: CliParseContext): CliCommand {
  const args = [...argv];
  if (args.length === 0) return { type: 'none' };

  const raw = args.join(' ');
  let locale: Locale | undefined;
  let activate = true;
  const specs: SessionSpec[] = [];
  let xshell: { host?: string; port?: number; username?: string; password?: string } | null = null;

  const takeValue = (index: number): string | undefined => args[index + 1];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const lower = arg.toLowerCase();

    // A link handed over by a plugin: `sso://…` from a bastion page, whether it
    // arrived as an argv token or through the OS `open-url` event.
    if (pluginLink(arg, ctx, raw, specs)) continue;

    if (lower === '--help' || lower === '-h' || lower === '/?' || lower === 'help') return { type: 'help' };
    if (lower === '--version' || lower === '-v' || lower === '-version') return { type: 'version' };
    if (lower === 'ls' || lower === 'list') return { type: 'api', command: 'ls', args: args.slice(i + 1) };
    if (lower === 'info' || lower === 'probe' || lower === 'input') {
      return { type: 'api', command: lower === 'probe' ? 'probe' : lower === 'input' ? 'input' : 'info', args: args.slice(i + 1) };
    }
    if (lower === 'exec') return { type: 'api', command: 'exec', args: args.slice(i + 1) };

    if (lower === '--lang' || lower === '-lang') {
      const value = takeValue(i);
      if (value === 'zh' || value === 'en') locale = value;
      i += 1;
      continue;
    }
    if (lower === '--no-activate') {
      activate = false;
      continue;
    }

    if (lower === '-newtab' || lower === '--newtab' || lower === '-new-tab') {
      const value = takeValue(i);
      if (value) {
        const fields = parseSshCommandLine(value);
        const origin: Origin = { type: 'cli', raw, via: 'newtab' };
        const linked: SessionSpec[] = [];
        if (!fields && pluginLink(value, ctx, raw, linked)) {
          // A portal that wraps its link in `-newtab` still reaches the plugin.
          specs.push(...linked);
        } else {
          specs.push(fields ? buildSshSpec(fields, ctx, origin) : buildLocalSpec(ctx, origin, value));
        }
      }
      i += 1;
      continue;
    }

    if (lower === '-url' || lower === '--url') {
      const value = takeValue(i);
      const fields = value ? parseSshUrl(value) : null;
      const linked: SessionSpec[] = [];
      if (value && !fields && pluginLink(value, ctx, raw, linked)) {
        specs.push(...linked);
      } else if (fields) {
        const pendingPassword = args.find((item, index) => index > i && (item === '-pw' || item === '--password'));
        if (pendingPassword) {
          fields.password = args[args.indexOf(pendingPassword) + 1];
        }
        specs.push(buildSshSpec(fields, ctx, { type: 'cli', raw, via: 'url' }));
      }
      i += 1;
      continue;
    }

    if (lower === '-ssh' || lower === '--ssh') {
      const value = takeValue(i);
      if (value) {
        xshell ??= {};
        const { username, host } = splitUserHost(value);
        xshell.host = host;
        if (username) xshell.username = username;
      }
      i += 1;
      continue;
    }
    if (lower === '-p' || lower === '--port') {
      const value = Number(takeValue(i));
      if (Number.isFinite(value) && value > 0) {
        xshell ??= {};
        xshell.port = value;
      }
      i += 1;
      continue;
    }
    if (lower === '-l' || lower === '--user' || lower === '-user') {
      const value = takeValue(i);
      if (value) {
        xshell ??= {};
        xshell.username = value;
      }
      i += 1;
      continue;
    }
    if (lower === '-pw' || lower === '--password' || lower === '-pass') {
      const value = takeValue(i);
      if (value !== undefined) {
        xshell ??= {};
        xshell.password = value;
      }
      i += 1;
      continue;
    }

    if (lower === '--local' || lower === '--local-shell') {
      const value = takeValue(i);
      const origin: Origin = { type: 'cli', raw, via: 'native' };
      const known = value ? ctx.profiles.find((profile) => profile.id === value) : undefined;
      if (known) {
        specs.push({
          kind: 'local',
          profileId: known.id,
          command: known.command,
          args: known.args,
          title: known.label,
          origin,
        });
        i += 1;
      } else {
        specs.push(buildLocalSpec(ctx, origin));
      }
      continue;
    }
    if (lower === '--wsl') {
      const value = takeValue(i);
      specs.push(buildWslSpec(ctx, { type: 'cli', raw, via: 'native' }, value));
      if (value) i += 1;
      continue;
    }
    if (lower === '--new-ssh') {
      const value = takeValue(i);
      const fields = value ? parseSshUrl(value) ?? (() => {
        const { username, host } = splitUserHost(value);
        return { username, host };
      })() : null;
      if (fields) specs.push(buildSshSpec(fields, ctx, { type: 'cli', raw, via: 'native' }));
      i += 1;
      continue;
    }

    // Unknown flag: skip a value if it looks like one, so a portal's extra
    // switches never turn into a bogus session.
    if (arg.startsWith('-') && !arg.startsWith('--')) continue;
  }

  if (xshell?.host) {
    specs.push(buildSshSpec(xshell, ctx, { type: 'cli', raw, via: 'xshell' }));
  }

  if (specs.length === 0) {
    if (locale) return { type: 'spawn', specs: [], activate, locale };
    return { type: 'none' };
  }
  return { type: 'spawn', specs, activate, locale };
}

/** Maps process.argv to the arguments the app should parse. */
export function extractCliArgs(argv: readonly string[], isPackaged: boolean): string[] {
  return argv.slice(isPackaged ? 1 : 2);
}