/**
 * The file sheet, backed by a session.
 *
 * One instance owns every panel that is open: the providers are cached per
 * session, because opening an SFTP channel costs a round trip and every row
 * click would otherwise pay it again. A cached provider is dropped as soon as
 * its session disappears, and the tree it points at goes with it.
 *
 * Uploads and downloads are reported as transfer events instead of a return
 * value: they outlive the click that started them, and a folder copy has many
 * files but only one progress bar the user cares about.
 */

import { randomUUID } from 'node:crypto';
import { promises as fsp, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  PlatformOs,
  SftpEntry,
  SftpEvent,
  SftpListing,
  SftpOrigin,
  SftpTransfer,
} from '../../shared/types';
import type { SessionManager } from '../session/manager';
import {
  createLocalProvider,
  createSftpProvider,
  joinPath,
  parentPath,
  resolveWslHome,
  resolveWslPrefix,
  type FileProvider,
} from './provider';

/** Progress is a progress bar, not a log: four updates a second is plenty. */
const PROGRESS_INTERVAL_MS = 120;

/**
 * How long a staged copy may sit in the temporary folder.
 *
 * A native drag is a copy: the target duplicates the file it was handed, and the
 * original stays where it is. Nothing tells us the drop happened, and deleting
 * right after `startDrag` would race the copy, so the folder is swept by age
 * instead — an hour is far longer than any drag can last.
 */
const STAGE_TTL_MS = 60 * 60 * 1000;

export interface SftpManagerOptions {
  sessions: SessionManager;
  platform: PlatformOs;
  /** Home directory of this machine, for local and failed-to-resolve cases. */
  homeDir: string;
  /** Where a drag out stages its copies before the OS takes them. */
  tempDir: string;
  emit: (event: SftpEvent) => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class SftpManager {
  private readonly providers = new Map<string, Promise<FileProvider | null>>();
  private readonly transfers = new Map<string, SftpTransfer>();

  constructor(private readonly options: SftpManagerOptions) {}

  /* ------------------------------------------------------------- the tree */

  async origin(sessionId: string): Promise<SftpOrigin | null> {
    const session = this.options.sessions.get(sessionId);
    if (!session) return null;
    const provider = await this.provider(sessionId).catch(() => null);
    if (!provider) return null;
    const home = await provider.home().catch(() => null);
    if (!home) return null;
    const chain = session.metadata.endpoint.chain;
    const nested = chain.length > 1;
    return {
      kind: session.kind,
      label: chain[0]?.label ?? session.title,
      style: provider.style,
      root: provider.root,
      home,
      // A nested login lives on another connection the app does not own, so the
      // tree stays on the host the tab was opened on and stops following.
      cwd: nested ? null : session.cwd ?? null,
      canFollow: !nested,
      nested,
    };
  }

  async list(sessionId: string, path: string): Promise<SftpListing> {
    const provider = await this.require(sessionId);
    const entries = await provider.list(path);
    return { path, parent: parentPath(provider.style, path), entries };
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const provider = await this.require(sessionId);
    await provider.mkdir(path);
  }

  async createFile(sessionId: string, path: string): Promise<void> {
    const provider = await this.require(sessionId);
    await provider.createFile(path);
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const provider = await this.require(sessionId);
    await provider.rename(from, to);
  }

  async remove(sessionId: string, paths: string[]): Promise<void> {
    const provider = await this.require(sessionId);
    for (const path of paths) {
      const dir = await this.isDirectory(provider, path);
      await provider.remove(path, dir);
    }
  }

  /* ---------------------------------------------------------- transferring */

  async upload(sessionId: string, destDir: string, localPaths: string[]): Promise<void> {
    const provider = await this.require(sessionId);
    for (const localPath of localPaths) {
      await this.copyIn(provider, sessionId, localPath, destDir);
    }
  }

  async download(sessionId: string, paths: string[], destDir: string): Promise<void> {
    const provider = await this.require(sessionId);
    for (const path of paths) {
      await this.copyOut(provider, sessionId, path, destDir);
    }
  }

  /**
   * The local paths a native drag should carry.
   *
   * The OS is never handed the only copy of anything: a drop is a copy at best
   * and a *move* at worst, and the target decides which. So every entry — local
   * or remote, file or folder — is copied into the app's own folder first, where
   * losing it costs nothing, and that folder is swept by age, by a closing tab
   * and by quitting.
   */
  async stage(sessionId: string, paths: string[]): Promise<string[]> {
    const provider = await this.require(sessionId);
    await this.sweepStage();
    const stageDir = this.stageDirOf(sessionId);
    await fsp.mkdir(stageDir, { recursive: true });
    await this.download(sessionId, paths, stageDir);
    return paths.map((path) => join(stageDir, this.nameOf(provider, path)));
  }

  private stageRoot(): string {
    return join(this.options.tempDir, 'sftp-drag');
  }

  private stageDirOf(sessionId: string): string {
    return join(this.stageRoot(), sessionId);
  }

  /** Removes staged copies no drop can still be reading. See `STAGE_TTL_MS`. */
  private async sweepStage(): Promise<void> {
    const root = this.stageRoot();
    const deadline = Date.now() - STAGE_TTL_MS;
    let sessions: string[];
    try {
      sessions = await fsp.readdir(root);
    } catch {
      return;
    }
    for (const session of sessions) {
      const dir = join(root, session);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const entry = join(dir, name);
        try {
          const info = await fsp.stat(entry);
          if (info.mtimeMs < deadline) await fsp.rm(entry, { recursive: true, force: true });
        } catch {
          // Already gone: another sweep or the user got there first.
        }
      }
      // Succeeds only when this session's folder is empty again.
      await fsp.rmdir(dir).catch(() => undefined);
    }
  }

  /* ------------------------------------------------------------- internals */

  dispose(): void {
    for (const pending of this.providers.values()) {
      void pending.then((provider) => provider?.dispose()).catch(() => undefined);
    }
    this.providers.clear();
    this.transfers.clear();
    // Staged copies exist only for a drag that is still going on; after a quit
    // no drag can continue, so the whole folder goes. Synchronous on purpose:
    // this runs inside `before-quit`, where nothing would wait for a promise.
    try {
      rmSync(this.stageRoot(), { recursive: true, force: true });
    } catch {
      // A file the OS still holds lands here; the age sweep catches it later.
    }
  }

  private nameOf(provider: FileProvider, path: string): string {
    if (provider.style === 'win32') return path.split('\\').filter(Boolean).pop() ?? path;
    return path.split('/').filter(Boolean).pop() ?? path;
  }

  private async require(sessionId: string): Promise<FileProvider> {
    const provider = await this.provider(sessionId);
    if (!provider) throw new Error('this session has no file channel');
    return provider;
  }

  /**
   * The provider for a session, created once.
   *
   * A failed creation is not cached: an SSH tab that was still connecting when
   * the sheet opened must be able to answer on the next look.
   */
  private provider(sessionId: string): Promise<FileProvider | null> {
    this.prune();
    const cached = this.providers.get(sessionId);
    if (cached) return cached;
    const created = this.createProvider(sessionId);
    this.providers.set(sessionId, created);
    void created.catch(() => this.providers.delete(sessionId));
    return created;
  }

  private async createProvider(sessionId: string): Promise<FileProvider | null> {
    const session = this.options.sessions.get(sessionId);
    if (!session) return null;

    if (session.kind === 'ssh') {
      const channel = await this.options.sessions.openSftp(sessionId);
      return channel ? createSftpProvider(channel) : null;
    }

    if (session.kind === 'wsl') {
      const distro = session.metadata.endpoint.distribution ?? '';
      if (this.options.platform !== 'win32' || !distro) return null;
      const prefix = await resolveWslPrefix(distro);
      if (!prefix) return null;
      const home = (await resolveWslHome(distro)) ?? '/';
      return createLocalProvider({ style: 'posix', prefix, home });
    }

    return createLocalProvider({
      style: this.options.platform === 'win32' ? 'win32' : 'posix',
      home: this.options.homeDir,
    });
  }

  /** Forgets providers whose session is gone: their channel died with it. */
  private prune(): void {
    for (const [sessionId, pending] of this.providers) {
      if (this.options.sessions.get(sessionId)) continue;
      this.providers.delete(sessionId);
      void pending.then((provider) => provider?.dispose()).catch(() => undefined);
      // A closed tab cannot drag anything out again, so its staged copies go too.
      void fsp.rm(this.stageDirOf(sessionId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async isDirectory(provider: FileProvider, path: string): Promise<boolean> {
    try {
      await provider.list(path);
      return true;
    } catch {
      return false;
    }
  }

  private async copyIn(
    provider: FileProvider,
    sessionId: string,
    localPath: string,
    destDir: string,
  ): Promise<void> {
    const info = await fsp.stat(localPath);
    const target = joinPath(provider.style, destDir, basename(localPath));

    if (!info.isDirectory()) {
      const transfer = this.begin(sessionId, 'upload', basename(localPath), target, info.size);
      try {
        await provider.upload(localPath, target, (bytes) => this.report(transfer, bytes));
        this.settle(transfer);
      } catch (error) {
        this.settle(transfer, messageOf(error));
        throw error;
      }
      return;
    }

    // A folder arrives as a folder: its own row is created, then every child is
    // copied into it, so a dropped directory keeps its shape.
    await provider.mkdir(target).catch(() => undefined);
    for (const child of await fsp.readdir(localPath)) {
      await this.copyIn(provider, sessionId, join(localPath, child), target);
    }
  }

  private async copyOut(
    provider: FileProvider,
    sessionId: string,
    sourcePath: string,
    destDir: string,
  ): Promise<void> {
    const name = this.nameOf(provider, sourcePath);
    const localPath = join(destDir, name);

    if (!(await this.isDirectory(provider, sourcePath))) {
      const transfer = this.begin(sessionId, 'download', name, destDir, null);
      try {
        await provider.download(sourcePath, localPath, (bytes) => this.report(transfer, bytes));
        this.settle(transfer);
      } catch (error) {
        this.settle(transfer, messageOf(error));
        throw error;
      }
      return;
    }

    await fsp.mkdir(localPath, { recursive: true });
    for (const child of await provider.list(sourcePath)) {
      await this.copyOut(provider, sessionId, child.path, localPath);
    }
  }

  private begin(
    sessionId: string,
    direction: SftpTransfer['direction'],
    name: string,
    target: string,
    total: number | null,
  ): SftpTransfer {
    const transfer: SftpTransfer = {
      id: randomUUID(),
      sessionId,
      direction,
      name,
      target,
      bytes: 0,
      total,
      done: false,
    };
    this.transfers.set(transfer.id, transfer);
    this.options.emit({ type: 'sftp-transfer', transfer: { ...transfer } });
    return transfer;
  }

  private report(transfer: SftpTransfer, bytes: number): void {
    const now = Date.now();
    const last = progressAt.get(transfer.id) ?? 0;
    transfer.bytes = bytes;
    if (now - last < PROGRESS_INTERVAL_MS) return;
    progressAt.set(transfer.id, now);
    this.options.emit({ type: 'sftp-transfer', transfer: { ...transfer } });
  }

  private settle(transfer: SftpTransfer, error?: string): void {
    progressAt.delete(transfer.id);
    transfer.done = true;
    if (error !== undefined) transfer.error = error;
    this.options.emit({ type: 'sftp-transfer', transfer: { ...transfer } });
    // A finished transfer stays in the map for a moment so a second click on
    // the same row cannot resurrect a stale id, then it is forgotten.
    setTimeout(() => this.transfers.delete(transfer.id), 30_000);
  }
}

/** Per-transfer clock for the progress throttle. */
const progressAt = new Map<string, number>();

/** Re-exported so the IPC layer can describe a row without importing the provider. */
export type { SftpEntry };
