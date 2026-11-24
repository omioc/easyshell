/**
 * Turning "an executable on PATH" into something `spawn()` can actually start.
 *
 * On Windows an npm bin is `foo.cmd`, and `spawn('foo.cmd')` throws `EINVAL`
 * because Node will not hand a batch file to CreateProcess. Passing it to
 * `cmd.exe /c` instead breaks on paths containing spaces. So the shim is read
 * once and its JavaScript entry is launched directly with a Node runtime: the
 * `node` on PATH when there is one, the app's own Electron runtime
 * (`ELECTRON_RUN_AS_NODE=1`) when there is not. A shim that only forwards to a
 * native binary (ByteDance's Trae CLI ships one) is read as that binary.
 *
 * Everything here is injectable so it can be tested without touching the real
 * PATH or the real file system.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentCliLookup } from '../../shared/agents';
import type { PlatformOs } from '../../shared/types';

/** Windows file extensions PATH lookup has to try, in CreateProcess order. */
const DEFAULT_PATH_EXT = ['.com', '.exe', '.bat', '.cmd'];

/** A batch file is the only thing that cannot be handed to spawn directly. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);

export interface LaunchContext extends AgentCliLookup {
  /** Runtime used when `nodePath` is null: Electron, with ELECTRON_RUN_AS_NODE. */
  execPath: string;
  nodePath: string | null;
  readFile(path: string): string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  /** Extra environment for this launch only. */
  env: Record<string, string>;
}

export interface ExecLookup {
  platform: PlatformOs;
  pathEnv: string;
  pathExt?: string;
  isFile(path: string): boolean;
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Absolute path of the first candidate found on PATH, or null. */
export function findExecutable(bins: string[], lookup: ExecLookup): string | null {
  const dirs = lookup.pathEnv
    .split(delimiter)
    .map((dir) => dir.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
  const extensions =
    lookup.platform === 'win32'
      ? (lookup.pathExt ?? DEFAULT_PATH_EXT.join(';'))
          .split(';')
          .map((ext) => ext.trim().toLowerCase())
          .filter(Boolean)
      : [''];

  for (const bin of bins) {
    if (!bin) continue;
    if (isAbsolute(bin)) {
      if (lookup.isFile(bin)) return bin;
      continue;
    }
    const candidates = /\.[a-z0-9]+$/i.test(bin) ? [''] : extensions;
    for (const dir of dirs) {
      for (const ext of candidates) {
        const candidate = join(dir, `${bin}${ext}`);
        if (lookup.isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * The script an npm shim runs when its bin has no file extension.
 *
 * Tencent's CodeBuddy ships `bin/codebuddy`, a shebang script with no suffix,
 * so the extension pattern in `parseShimEntry` finds nothing and the shim would
 * fall through to `cmd.exe`. A `%dp0%` tail in a subdirectory whose last
 * segment carries no dot is that script; `%dp0%\node.exe`, which the same shim
 * also names, has one and is skipped.
 */
function bareShimEntry(shimText: string): string | null {
  for (const match of shimText.matchAll(/%(?:~)?dp0%?([^"'<>\r\n|*%]+)/gi)) {
    const tail = match[1] ?? '';
    if (!/[\\/]/.test(tail)) continue;
    const base = tail.split(/[\\/]/).pop() ?? '';
    if (!base || base.includes('.')) continue;
    return tail;
  }
  return null;
}

/**
 * The JavaScript entry an npm-style batch shim runs.
 *
 * npm writes `"%dp0%\..\<pkg>\<file>.js"`; pnpm writes a `%~dp0`-relative path
 * as well, which is why both markers are accepted. A bin with no extension at
 * all (`bin/codebuddy`) is read the same way. Anything else returns null and
 * the caller falls back to `cmd.exe`.
 */
export function parseShimEntry(shimText: string, shimPath: string): string | null {
  // `%dp0%` is the shim's own directory including the trailing separator, so the
  // captured tail either starts with one (`\..\pkg\index.js`) or not
  // (`mock-acp-agent.mjs`).
  const match = /%(?:~)?dp0%?([^"'<>\r\n|*%]*\.(?:js|mjs|cjs))/i.exec(shimText);
  const tail = match?.[1] ?? bareShimEntry(shimText);
  if (!tail) return null;
  const relative = tail.replace(/\//g, '\\');
  const entry = /^[\\/]/.test(relative)
    ? resolve(dirname(shimPath), `.${relative}`)
    : resolve(dirname(shimPath), relative);
  return isAbsolute(entry) ? entry : null;
}

/** Lines of a batch file that do something, with the usual noise dropped. */
const SHIM_NOISE = /^@?(?:echo\s+off|setlocal|endlocal|title|rem\b|::|exit\b)/i;

function shimCommandLines(shimText: string): string[] {
  return shimText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').trim())
    .filter((line) => line.length > 0 && !SHIM_NOISE.test(line));
}

/**
 * The executable a forwarding shim starts.
 *
 * Some installers ship a native binary next to a `foo.cmd` that exists only to
 * forward to it (`"%~dp0foox.exe" %*`). Reading such a shim as the exe it names
 * is better than handing it to `cmd.exe`, which cannot cope with a path
 * containing spaces and which `kill()` leaves the real process behind.
 *
 * Only a shim whose single remaining line is that forwarding call qualifies:
 * an npm shim, or a batch file that does actual work, returns null.
 */
export function parseShimExecutable(shimText: string, shimPath: string): string | null {
  const lines = shimCommandLines(shimText);
  const forwarding = lines.length === 1 ? lines[0] : undefined;
  if (!forwarding) return null;
  const match = /^@?"?%(?:~)?dp0%?([^"|&<>*]*?\.exe)"?(?:\s+%\*)?\s*$/i.exec(forwarding);
  const tail = match?.[1]?.replace(/\//g, '\\');
  if (!tail) return null;
  const target = tail.startsWith('\\')
    ? resolve(dirname(shimPath), `.${tail}`)
    : resolve(dirname(shimPath), tail);
  return isAbsolute(target) ? target : null;
}

/**
 * How to start `command`.
 *
 * Non-Windows and native binaries are spawned as given. A batch shim becomes a
 * runtime invocation, or the executable it only forwards to; a shim readable as
 * neither degrades to `cmd.exe`, which works as long as the path has no spaces.
 */
export function planLaunch(command: string, args: string[], ctx: LaunchContext): LaunchPlan {
  if (ctx.platform !== 'win32') return { command, args: [...args], env: {} };
  const extension = /(\.[a-z0-9]+)$/i.exec(command)?.[1]?.toLowerCase() ?? '';
  if (!SHIM_EXTENSIONS.has(extension)) return { command, args: [...args], env: {} };

  let shimText = '';
  try {
    shimText = ctx.readFile(command);
  } catch {
    shimText = '';
  }
  const entry = parseShimEntry(shimText, command);
  if (!entry) {
    const forwarded = parseShimExecutable(shimText, command);
    if (forwarded) return { command: forwarded, args: [...args], env: {} };
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args], env: {} };
  }
  if (ctx.nodePath) {
    return { command: ctx.nodePath, args: [entry, ...args], env: {} };
  }
  return {
    command: ctx.execPath,
    args: [entry, ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function platformOf(): PlatformOs {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

/**
 * Electron does not inherit a login shell's PATH: on macOS a GUI launch sees a
 * bare `/usr/bin:/bin:/usr/sbin:/sbin`, and on any platform a user-level install
 * directory may be missing. These are appended to the lookup, not to the child
 * environment, so a detected path is still spawned by absolute path.
 */
function defaultSearchDirs(): string[] {
  const home = homedir();
  const dirs = [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')];
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'npm'));
  }
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

/** The real machine: real PATH, real files, the app's own runtime. */
export function defaultLaunchContext(platform: PlatformOs = platformOf()): LaunchContext {
  const pathEnv = [process.env.PATH ?? process.env.Path ?? '', ...defaultSearchDirs()].join(
    delimiter,
  );
  const pathExt = process.env.PATHEXT;
  const lookup: ExecLookup = { platform, pathEnv, pathExt, isFile: isFileSync };
  return {
    ...lookup,
    execPath: process.execPath,
    nodePath: findExecutable(['node'], lookup),
    readFile: readTextFile,
  };
}
