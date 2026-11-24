/**
 * What a probe or a login banner says the machine is.
 *
 * The probe prints `PRETTY_NAME` from `/etc/os-release` and falls back to
 * `uname -s`, and it also reports the kernel. A host that answered at all
 * therefore either names its distribution or names its kernel; only a positive
 * answer is reported here, because a host nobody could identify must keep the
 * plain terminal tile instead of being guessed at.
 */

import type { OsInfo } from '../../shared/types';
import { distroName } from './banner';

export interface HostPlatform {
  /** The host answered as Linux. */
  linux: boolean;
  /** Distribution the host printed, e.g. `Ubuntu`, `Rocky Linux`. */
  distribution?: string;
}

/** Words that mean "this is a Linux box", whether or not the kernel is known. */
const LINUX_WORDS =
  /\blinux\b|ubuntu|debian|centos|red ?hat|rhel|fedora|suse|alpine|arch|rocky|alma|oracle|kali|gentoo|nixos|void|mint|manjaro|photon|euler|anolis|kylin|deepin|uos/i;

/** Systems that are definitely not Linux, whatever else their output mentions. */
const OTHER_WORDS =
  /windows|darwin|mac ?os|freebsd|openbsd|netbsd|dragonfly|solaris|sunos|\baix\b|haiku|android/i;

export function readHostPlatform(os: OsInfo): HostPlatform | null {
  const name = (os.os ?? '').trim();
  const kernel = (os.kernel ?? '').trim();
  if (!name && !kernel) return null;

  // `uname -s` answers exactly this on a host without /etc/os-release, so it
  // names the family but no distribution.
  const named = distroName(name);
  const distribution = named && !/^linux$/i.test(named) ? named : undefined;
  const linux = (): HostPlatform => (distribution ? { linux: true, distribution } : { linux: true });

  // The kernel is the stronger signal: `uname -sr` cannot mention a derivative
  // the way a PRETTY_NAME can, so a Linux kernel settles the family outright.
  if (kernel) {
    if (/\blinux\b/i.test(kernel)) return linux();
    if (OTHER_WORDS.test(kernel) || /\bbsd\b/i.test(kernel)) return { linux: false };
  }

  if (OTHER_WORDS.test(name)) return { linux: false };
  if (LINUX_WORDS.test(name)) return linux();

  return null;
}
