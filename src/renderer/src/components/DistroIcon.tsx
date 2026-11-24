/**
 * Brand tiles for the machines that have a logo: a WSL distribution, or a saved
 * SSH host whose last session identified what it runs.
 *
 * The brand lookup and the icon it resolves to live here so the sidebar and the
 * new-session menu cannot drift apart, and so a redrawn tile never needs a change
 * at a call site.
 */

import type { ComponentType } from 'react';
import type { SshProfile } from '@shared/types';
import { distroBrand, sshHostBrand, type DistroBrand } from '../lib/sessions';
import {
  IconAlma,
  IconAlpine,
  IconArch,
  IconCentos,
  IconDebian,
  IconDocker,
  IconFedora,
  IconKali,
  IconKylin,
  IconLinux,
  IconOpensuse,
  IconRocky,
  IconTerminal,
  IconUbuntu,
  type IconProps,
} from './Icons';

const brandIcons: Record<DistroBrand, ComponentType<IconProps>> = {
  docker: IconDocker,
  ubuntu: IconUbuntu,
  debian: IconDebian,
  kali: IconKali,
  kylin: IconKylin,
  alpine: IconAlpine,
  arch: IconArch,
  fedora: IconFedora,
  opensuse: IconOpensuse,
  rocky: IconRocky,
  alma: IconAlma,
  centos: IconCentos,
  linux: IconLinux,
};

export function DistroIcon({ distribution, size = 16 }: { distribution: string; size?: number }) {
  const Icon = brandIcons[distroBrand(distribution)];
  return <Icon size={size} />;
}

/**
 * The tile for a saved SSH host.
 *
 * Until a session has identified the machine there is nothing to draw but the
 * terminal: the first connection is what reveals the distribution, and the row
 * picks it up through `profile.detected` the moment the probe or the login banner
 * reports it. The terminal is one size smaller because a line icon carries more
 * edge inside the same box than a filled tile does.
 */
export function SshHostIcon({
  profile,
  size = 16,
  terminalSize = 15,
}: {
  profile: Pick<SshProfile, 'detected'>;
  size?: number;
  terminalSize?: number;
}) {
  const brand = sshHostBrand(profile.detected);
  if (!brand) return <IconTerminal size={terminalSize} />;
  const Icon = brandIcons[brand];
  return <Icon size={size} />;
}
