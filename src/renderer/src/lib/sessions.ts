/**
 * Small, pure lookups used by the sidebar launchers and the new-session menu so a
 * local shell, a WSL distribution and a saved SSH host all get the same icon
 * wherever they are drawn.
 */

import type { SessionInfo, ShellProfile, SshHostFacts } from '@shared/types';

/** What kind of shell a local profile starts, for the row and menu icon. */
export type ShellBrand = 'powershell' | 'cmd' | 'shell';

export function shellBrand(profile: Pick<ShellProfile, 'command' | 'label'>): ShellBrand {
  const command = profile.command.toLowerCase();
  const label = profile.label.toLowerCase();
  if (command.includes('cmd') || label.includes('cmd')) return 'cmd';
  if (command.includes('pwsh') || command.includes('powershell')) return 'powershell';
  if (label.includes('powershell')) return 'powershell';
  return 'shell';
}

/**
 * The brand tile a Linux machine gets, by distribution.
 *
 * Docker Desktop's own WSL distributions (`docker-desktop`, `docker-desktop-data`)
 * are still Docker to the user, not a Linux distro. Everything without a glyph of
 * its own lands on `linux`, which draws Tux, instead of borrowing another mark.
 */
export type DistroBrand =
  | 'docker'
  | 'ubuntu'
  | 'debian'
  | 'kali'
  | 'alpine'
  | 'arch'
  | 'fedora'
  | 'opensuse'
  | 'rocky'
  | 'alma'
  | 'centos'
  | 'kylin'
  | 'linux';

/**
 * Patterns are tried in order, first match wins, so the specific names have to
 * come before the ones they contain: `openSUSE` carries the `SUSE` word, and a
 * Docker distribution can be named after the distro it hosts.
 *
 * `SUSE Linux Enterprise` shares the openSUSE chameleon because the two are one
 * brand family and a legible chameleon beats an illegible wordmark at 16px.
 */
const distroBrands: readonly (readonly [RegExp, DistroBrand])[] = [
  [/docker/i, 'docker'],
  [/ubuntu/i, 'ubuntu'],
  [/debian/i, 'debian'],
  [/kali/i, 'kali'],
  [/alpine/i, 'alpine'],
  [/arch/i, 'arch'],
  [/fedora/i, 'fedora'],
  [/opensuse/i, 'opensuse'],
  [/suse|sles/i, 'opensuse'],
  [/rocky/i, 'rocky'],
  [/alma/i, 'alma'],
  [/centos|red ?hat|rhel/i, 'centos'],
  // `rockylinux` contains the letters `kylin`, so Kylin is matched last: every
  // distribution whose name could swallow it has already been tried.
  [/kylin/i, 'kylin'],
];

export function distroBrand(name: string): DistroBrand {
  for (const [pattern, brand] of distroBrands) {
    if (pattern.test(name)) return brand;
  }
  return 'linux';
}

/**
 * The tile for a saved SSH host, or null for the plain terminal.
 *
 * Facts are only written by a session that identified the machine, so null covers
 * both "never connected" and "connected, but the host did not say what it runs".
 * A host that named itself as something other than Linux is null too: the tiles
 * in this set are Linux distributions.
 */
export function sshHostBrand(facts?: SshHostFacts): DistroBrand | null {
  if (!facts || !facts.linux) return null;
  return distroBrand(facts.distribution ?? '');
}

/**
 * The 1-based position of a session in the tab strip.
 *
 * It is a position, not an id: closing any tab renumbers everything after it, so
 * the number a prompt was written against can never point at a different
 * terminal than the one on screen. `0` means the session is gone.
 */
export function tabNumber(sessions: SessionInfo[], id: string | null): number {
  if (!id) return 0;
  const index = sessions.findIndex((session) => session.id === id);
  return index < 0 ? 0 : index + 1;
}
