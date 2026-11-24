/**
 * Passive login metadata.
 *
 * After a nested login the side channel still describes the outer host, and the
 * app deliberately does not type anything into the user's shell to ask. What is
 * left is the text the remote host prints by itself: the login banner, the MOTD
 * block (`System information as of …`, `IPv4 address for eth0: …`) and the
 * prompt. That is enough for a useful — if incomplete — picture, and it costs
 * the terminal nothing.
 */

import type { OsInfo } from '../../shared/types';

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export interface BannerFacts {
  os: Partial<OsInfo>;
  extra: Record<string, string>;
}

/**
 * A line only an interactive login prints. Used together with a prompt whose
 * `user@host` changed: that pair is a nested login the typed line never told us
 * about (a command the app typed itself, a paste the detector split, a race).
 */
export const LOGIN_SIGNATURE = /(?:^|[\r\n])[^\S\r\n]*(?:Last login:|System information as of )/;

/**
 * The distribution part of a `PRETTY_NAME`: `Ubuntu 22.04.5 LTS` → `Ubuntu`,
 * `Debian GNU/Linux 12 (bookworm)` → `Debian GNU/Linux`.
 */
export function distroName(prettyName?: string): string | undefined {
  if (!prettyName) return undefined;
  const name = prettyName.trim();
  if (!name) return undefined;
  const version = name.search(/\s+v?\d/);
  const distro = (version > 0 ? name.slice(0, version) : name).replace(/\s*\(.*\)\s*$/, '').trim();
  return distro || undefined;
}

/** Cheap gate: only text that can plausibly carry facts is parsed. */
export const BANNER_HINT =
  /(?:Welcome to|System information as of|IPv4 address|Last login|Linux version|GNU\/Linux)/;

const DISTROS =
  '(?:Ubuntu|Debian GNU/Linux|Debian|CentOS(?: Linux)?|Rocky Linux|AlmaLinux|Fedora(?: Linux)?|Red Hat Enterprise Linux|Amazon Linux|openSUSE(?: Leap| Tumbleweed)?|Alpine Linux|Arch Linux|Oracle Linux)';

/** Reads what a login banner and a prompt can tell us, without asking anyone. */
export function parseLoginBanner(rawText: string): BannerFacts {
  const text = rawText.replace(ANSI_ESCAPE, '').replace(/\r/g, '');
  const os: Partial<OsInfo> = {};
  const extra: Record<string, string> = {};

  // Debian/Ubuntu: "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)"
  const welcome = new RegExp(`Welcome to (${DISTROS}[^\\n()]{0,40}?)\\s*(?:\\(GNU/Linux ([^)\\n]+)\\))?\\s*$`, 'm').exec(
    text,
  );
  const named = welcome ?? new RegExp(`(${DISTROS}\\s+\\d[\\w.]*)`).exec(text);
  if (named) {
    const name = (named[1] ?? '').trim();
    if (name) {
      os.os = name;
      const version = /\b(\d+\.\d+)(?:\.\d+)?/.exec(name);
      if (version) os.osVersion = version[1];
    }
    // "GNU/Linux 5.15.0-91-generic x86_64" -> "Linux 5.15.0-91-generic" / "x86_64"
    const kernel = welcome?.[2]?.trim();
    if (kernel) {
      const [release, arch] = kernel.split(/\s+/);
      if (release) os.kernel = `Linux ${release}`;
      if (arch) os.arch = arch;
    }
  }

  // "Linux version 5.15.0-91-generic (buildd@...) (gcc ...) #1 SMP ... x86_64"
  const linuxVersion = /Linux version (\S+).*?\b(x86_64|aarch64|arm64|armv7l|i[3-6]86)\b/.exec(text);
  if (linuxVersion) {
    os.kernel ??= `Linux ${linuxVersion[1]}`;
    os.arch ??= linuxVersion[2];
  }

  // MOTD block: "IPv4 address for eth0: 203.0.113.3"
  const ips = new Set<string>();
  for (const match of text.matchAll(/IPv4 address for \S+\s*:\s*([\d.]+)/g)) {
    if (match[1]) ips.add(match[1]);
  }
  if (ips.size > 0) os.ips = [...ips];

  const load = /System load:\s*([\d.]+)/.exec(text);
  if (load?.[1]) extra['banner.load'] = load[1];

  const memory = /Memory usage:\s*(\d+)%/.exec(text);
  if (memory?.[1]) extra['banner.memory'] = `${memory[1]}%`;

  const disk = /Usage of \S+:\s*([\d.]+% of [\d.]+\w*)/.exec(text);
  if (disk?.[1]) extra['banner.disk'] = disk[1];

  const updates = /(\d+) updates can be applied immediately/.exec(text);
  if (updates?.[1]) extra['banner.updates'] = updates[1];

  const lastLogin = /Last login:\s*([^\n]{4,60})/.exec(text);
  if (lastLogin?.[1]) extra['banner.lastLogin'] = lastLogin[1].trim();

  // The last prompt-shaped `user@host` line is the machine the user is on now.
  // Requiring the prompt punctuation keeps ordinary output out of it. Both the
  // `user@host:~$` and the bracketed `[user@host cwd]#` shape count: the second
  // is the default on CentOS / RHEL / Kylin, and ignoring it loses the hostname.
  const promptLine = [...text.matchAll(/^[\s]*[[(]?([\w.-]{1,32})@([\w.-]{1,64})[: \t][^\n]*?[#$%>]\s*$/gm)].pop();
  if (promptLine) {
    os.user ??= promptLine[1];
    os.hostname ??= promptLine[2];
  }

  return { os, extra };
}
