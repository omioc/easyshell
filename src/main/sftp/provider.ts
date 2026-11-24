/**
 * One file tree, three transports.
 *
 * The sheet shows a single kind of row no matter what it is looking at: an SSH
 * host over the session's own SFTP channel, a WSL distribution through its UNC
 * share, or this machine through `node:fs`. Everything the panel needs is
 * narrowed to `FileProvider`, so panels, menus and transfers never branch on
 * the session kind.
 *
 * Paths handed out by a provider are always the *target's* paths, joined with
 * the target's own separator: `/home/demo/notes` on a POSIX host, `C:\Users\demo`
 * locally, `/home/demo` for a WSL distribution (translated to the UNC share only
 * at the syscall boundary).
 */

import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { posix, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { FileEntry, SFTPWrapper } from 'ssh2';
import type { FilePathStyle, SftpEntry } from '../../shared/types';

/** Listing a directory with tens of thousands of entries must not hang the app. */
const MAX_ENTRIES = 4000;
/** How many `stat` calls a local listing runs at once. */
const STAT_POOL = 24;

const execFileAsync = promisify(execFile);

export interface FileProvider {
  /** Separator and path grammar of the target. */
  readonly style: FilePathStyle;
  /** Topmost directory the sheet may show. */
  readonly root: string;
  /** Where a new panel starts when the terminal reports no directory. */
  home(): Promise<string>;
  list(path: string): Promise<SftpEntry[]>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, dir: boolean): Promise<void>;
  /** Copies a local file onto the target. */
  upload(localPath: string, targetPath: string, onBytes: (bytes: number) => void): Promise<void>;
  /** Copies a target file onto this machine. */
  download(
    sourcePath: string,
    localPath: string,
    onBytes: (bytes: number) => void,
  ): Promise<void>;
  dispose(): void;
}

export function joinPath(style: FilePathStyle, base: string, name: string): string {
  return style === 'win32' ? win32.join(base, name) : posix.join(base, name);
}

/** The directory above `value`, or `null` once the tree ends. */
export function parentPath(style: FilePathStyle, value: string): string | null {
  const parent = style === 'win32' ? win32.dirname(value) : posix.dirname(value);
  if (!parent || parent === value) return null;
  return parent;
}

/** Directories first, then by name: the order every file manager agrees on. */
export function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  return entries.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/* ---------------------------------------------------------------- over SFTP */

function sftpEntry(path: string, style: FilePathStyle, entry: FileEntry): SftpEntry {
  const mode = entry.attrs.mode ?? 0;
  const dir = (mode & 0o170000) === 0o040000 || entry.longname.startsWith('d');
  const symlink = (mode & 0o170000) === 0o120000 || entry.longname.startsWith('l');
  return {
    name: entry.filename,
    path: joinPath(style, path, entry.filename),
    // A symlink is followed by `stat`, so a link to a directory still opens.
    dir,
    size: Number(entry.attrs.size ?? 0),
    modifiedAt: entry.attrs.mtime ? Number(entry.attrs.mtime) * 1000 : null,
    symlink,
    mode,
  };
}

/** The session's own SSH connection, reused for its file channel. */
export function createSftpProvider(sftp: SFTPWrapper): FileProvider {
  const realpath = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      sftp.realpath(path, (error, resolved) => {
        if (error) reject(error);
        else resolve(resolved ?? path);
      });
    });

  const stat = (path: string): Promise<{ dir: boolean; size: number; mtime: number | null } | null> =>
    new Promise((resolve) => {
      sftp.stat(path, (error, attributes) => {
        if (error || !attributes) {
          resolve(null);
          return;
        }
        const mode = attributes.mode ?? 0;
        resolve({
          dir: (mode & 0o170000) === 0o040000,
          size: Number(attributes.size ?? 0),
          mtime: attributes.mtime ? Number(attributes.mtime) * 1000 : null,
        });
      });
    });

  return {
    style: 'posix',
    root: '/',
    async home() {
      const resolved = await realpath('.');
      return resolved.startsWith('/') ? resolved : '/';
    },
    async list(path) {
      const list = await new Promise<FileEntry[]>((resolve, reject) => {
        sftp.readdir(path, (error, entries) => {
          if (error) reject(error);
          else resolve(entries ?? []);
        });
      });
      const rows = list.slice(0, MAX_ENTRIES).map((entry) => sftpEntry(path, 'posix', entry));
      // A directory symlink reports as a link: ask about the few that exist
      // rather than every row.
      const links = rows.filter((row) => row.symlink);
      await Promise.all(
        links.map(async (row) => {
          const info = await stat(row.path);
          if (!info) return;
          row.dir = info.dir;
          row.size = info.size;
          row.modifiedAt = info.mtime ?? row.modifiedAt;
        }),
      );
      return sortEntries(rows);
    },
    mkdir(path) {
      return new Promise((resolve, reject) => {
        sftp.mkdir(path, (error) => (error ? reject(error) : resolve()));
      });
    },
    createFile(path) {
      return new Promise((resolve, reject) => {
        sftp.writeFile(path, '', { flag: 'wx' }, (error) => (error ? reject(error) : resolve()));
      });
    },
    rename(from, to) {
      return new Promise((resolve, reject) => {
        sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
      });
    },
    remove(path, dir) {
      return new Promise((resolve, reject) => {
        const done = (error?: Error | null) => (error ? reject(error) : resolve());
        if (dir) sftp.rmdir(path, done);
        else sftp.unlink(path, done);
      });
    },
    upload(localPath, targetPath, onBytes) {
      return new Promise((resolve, reject) => {
        sftp.fastPut(
          localPath,
          targetPath,
          {
            step: (transferred: number) => onBytes(transferred),
          },
          (error?: Error | null) => (error ? reject(error) : resolve()),
        );
      });
    },
    download(sourcePath, localPath, onBytes) {
      return new Promise((resolve, reject) => {
        sftp.fastGet(
          sourcePath,
          localPath,
          {
            step: (transferred: number) => onBytes(transferred),
          },
          (error?: Error | null) => (error ? reject(error) : resolve()),
        );
      });
    },
    dispose() {
      // The channel belongs to the session's connection: closing the tab or the
      // SSH client ends it, and `ssh2` does the rest.
    },
  };
}

/* ------------------------------------------------------------ this machine */

export interface LocalProviderOptions {
  style: FilePathStyle;
  /** Native directory the virtual tree starts at (`\\wsl.localhost\Ubuntu`). */
  prefix?: string;
  /** Where the tree opens when the terminal reports nothing. */
  home: string;
}

/**
 * The local file system, optionally behind a native prefix.
 *
 * The prefix is what turns a WSL distribution into a browsable tree: the sheet
 * speaks Linux paths (`/etc`), and every syscall is made against
 * `\\wsl.localhost\<distro>` + the same path in Windows form.
 */
export function createLocalProvider(options: LocalProviderOptions): FileProvider {
  const { style, prefix = '' } = options;

  const toNative = (path: string): string => {
    if (!prefix) return path;
    const parts = path.split('/').filter((part) => part.length > 0);
    return parts.length === 0 ? prefix : `${prefix}\\${parts.join('\\')}`;
  };

  return {
    style,
    root: prefix ? '/' : style === 'win32' ? (win32.parse(options.home).root ?? '/') : '/',
    async home() {
      return options.home;
    },
    async list(path) {
      const dirents = await fsp.readdir(toNative(path), { withFileTypes: true });
      const sliced = dirents.slice(0, MAX_ENTRIES);
      const rows: SftpEntry[] = new Array(sliced.length);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const dirent = sliced[index];
          if (!dirent) return;
          const row: SftpEntry = {
            name: dirent.name,
            path: joinPath(style, path, dirent.name),
            dir: dirent.isDirectory(),
            size: 0,
            modifiedAt: null,
            symlink: dirent.isSymbolicLink(),
          };
          try {
            const info = await fsp.stat(toNative(row.path));
            row.dir = info.isDirectory();
            row.size = info.isDirectory() ? 0 : info.size;
            row.modifiedAt = info.mtimeMs;
          } catch {
            // A row we cannot stat is still a row: it shows without numbers.
          }
          rows[index] = row;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(STAT_POOL, Math.max(1, sliced.length)) }, worker),
      );
      return sortEntries(rows.filter((row): row is SftpEntry => Boolean(row)));
    },
    async mkdir(path) {
      await fsp.mkdir(toNative(path));
    },
    async createFile(path) {
      await fsp.writeFile(toNative(path), '', { flag: 'wx' });
    },
    async rename(from, to) {
      await fsp.rename(toNative(from), toNative(to));
    },
    async remove(path, dir) {
      if (dir) await fsp.rm(toNative(path), { recursive: true });
      else await fsp.unlink(toNative(path));
    },
    async upload(localPath, targetPath, onBytes) {
      let bytes = 0;
      const source = createReadStream(localPath);
      source.on('data', (chunk) => {
        bytes += chunk.length;
        onBytes(bytes);
      });
      await pipeline(source, createWriteStream(toNative(targetPath)));
    },
    async download(sourcePath, localPath, onBytes) {
      let bytes = 0;
      const source = createReadStream(toNative(sourcePath));
      source.on('data', (chunk) => {
        bytes += chunk.length;
        onBytes(bytes);
      });
      await pipeline(source, createWriteStream(localPath));
    },
    dispose() {
      // Nothing to release: this tree is the process's own file system.
    },
  };
}

/* -------------------------------------------------------------------- WSL */

/**
 * Where a WSL distribution keeps the login user's home.
 *
 * The Windows side of the share cannot answer this: `/home/<user>` needs the
 * distribution's own `$HOME`. Asking `wsl.exe` once costs a few hundred
 * milliseconds and is cached by the caller.
 */
export async function resolveWslHome(distro: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'wsl.exe',
      ['-d', distro, '--', 'sh', '-lc', 'printf %s "$HOME"'],
      { windowsHide: true, timeout: 6000 },
    );
    const home = stdout.replace(/\u0000/g, '').trim();
    return home.startsWith('/') ? home : null;
  } catch {
    return null;
  }
}

/**
 * The UNC path a Windows build exposes a distribution under.
 *
 * `\\wsl.localhost` is the current name; `\\wsl$` is the one older builds (and
 * some domain-joined machines) still answer to.
 */
export async function resolveWslPrefix(distro: string): Promise<string | null> {
  const candidates = [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`];
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}
