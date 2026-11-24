import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostKeyPolicy } from '../../shared/types';

interface KnownHostEntry {
  host: string;
  port: number;
  fingerprint: string;
  addedAt: number;
  updatedAt: number;
}

type KnownHostsFile = Record<string, KnownHostEntry>;

export type HostKeyVerdict =
  | { ok: true; changed: boolean; firstSeen: boolean }
  | { ok: false; changed: boolean; previousFingerprint: string };

/**
 * Tiny trust-on-first-use store.
 *
 * OpenSSH's `known_hosts` format is not reused on purpose: bastion session
 * ports hand out different backend hosts on every ticket, so the store is keyed
 * by `host:port` and rewritten in place instead of accumulating conflicts.
 */
export class KnownHostsStore {
  private store: KnownHostsFile;

  constructor(private readonly file: string) {
    this.store = this.load();
  }

  static fingerprint(key: Buffer | string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  verify(
    host: string,
    port: number,
    key: Buffer | string,
    policy: HostKeyPolicy,
  ): HostKeyVerdict {
    if (policy === 'insecure') return { ok: true, changed: false, firstSeen: false };

    const id = `${host}:${port}`;
    const fingerprint = KnownHostsStore.fingerprint(key);
    const existing = this.store[id];
    const now = Date.now();

    if (!existing) {
      this.store[id] = { host, port, fingerprint, addedAt: now, updatedAt: now };
      this.persist();
      return { ok: true, changed: false, firstSeen: true };
    }
    if (existing.fingerprint === fingerprint) return { ok: true, changed: false, firstSeen: false };
    if (policy === 'strict') {
      return { ok: false, changed: true, previousFingerprint: existing.fingerprint };
    }

    existing.fingerprint = fingerprint;
    existing.updatedAt = now;
    this.persist();
    return { ok: true, changed: true, firstSeen: false };
  }

  private load(): KnownHostsFile {
    try {
      if (!existsSync(this.file)) return {};
      return JSON.parse(readFileSync(this.file, 'utf8')) as KnownHostsFile;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.store, null, 2), 'utf8');
    } catch {
      // Trust state is best effort; failing to write must not block a session.
    }
  }
}