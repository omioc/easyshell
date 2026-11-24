import { describe, expect, it } from 'vitest';
import { distroBrand, sshHostBrand } from '../../src/renderer/src/lib/sessions';

// Names as `wsl.exe -l` reports them, plus the spellings a store install and a
// hand-imported rootfs use for the same distribution.
const cases: readonly (readonly [string, string])[] = [
  ['docker-desktop', 'docker'],
  ['docker-desktop-data', 'docker'],
  ['Ubuntu', 'ubuntu'],
  ['Ubuntu-22.04', 'ubuntu'],
  ['Debian', 'debian'],
  ['kali-linux', 'kali'],
  ['Alpine', 'alpine'],
  ['Arch', 'arch'],
  ['archlinux', 'arch'],
  ['FedoraLinux-42', 'fedora'],
  ['openSUSE-Tumbleweed', 'opensuse'],
  ['openSUSE-Leap-15.6', 'opensuse'],
  ['SLES-15', 'opensuse'],
  ['suse', 'opensuse'],
  ['Rocky-9', 'rocky'],
  ['AlmaLinux-9', 'alma'],
  ['CentOS-8', 'centos'],
  ['RedHat-9', 'centos'],
  ['OracleLinux_9_1', 'linux'],
  ['Amazon-Linux-2023', 'linux'],
  ['NixOS', 'linux'],
  ['Void', 'linux'],
  ['', 'linux'],
  // Distribution names as a Linux host prints them in `PRETTY_NAME`, which is
  // what the SSH probe reads, after the version and codename are stripped.
  ['Ubuntu', 'ubuntu'],
  ['Debian GNU/Linux', 'debian'],
  ['Rocky Linux', 'rocky'],
  ['Alpine Linux', 'alpine'],
  ['Fedora Linux', 'fedora'],
  ['openSUSE Tumbleweed', 'opensuse'],
  ['Arch Linux', 'arch'],
  ['Kylin Linux Advanced Server V10', 'kylin'],
  // `rockylinux` contains the letters `kylin`: Rocky must still win.
  ['rockylinux', 'rocky'],
  ['openKylin', 'kylin'],
];

describe('the tile a distribution gets', () => {
  it.each(cases)('maps %s to %s', (distribution, brand) => {
    expect(distroBrand(distribution)).toBe(brand);
  });

  it('never borrows the Ubuntu mark for a distribution it does not recognise', () => {
    expect(distroBrand('SomeCustomRootfs')).not.toBe('ubuntu');
  });

  it('matches distribution words case-insensitively', () => {
    expect(distroBrand('DEBIAN')).toBe('debian');
    expect(distroBrand('Debian')).toBe('debian');
    expect(distroBrand('debían'.normalize('NFD'))).toBe('linux');
  });
});

describe('the tile a saved SSH host gets', () => {
  it('has none until a session identified the machine', () => {
    expect(sshHostBrand(undefined)).toBeNull();
  });

  it('uses the distribution tile for a Linux host that named itself', () => {
    expect(sshHostBrand({ linux: true, distribution: 'Ubuntu', at: 1 })).toBe('ubuntu');
    expect(sshHostBrand({ linux: true, distribution: 'Rocky Linux', at: 1 })).toBe('rocky');
  });

  it('falls back to the generic Linux tile for an unnamed Linux host', () => {
    expect(sshHostBrand({ linux: true, at: 1 })).toBe('linux');
    expect(sshHostBrand({ linux: true, distribution: 'Oracle Linux', at: 1 })).toBe('linux');
  });

  it('has none for a host that is not Linux', () => {
    expect(sshHostBrand({ linux: false, at: 1 })).toBeNull();
    expect(sshHostBrand({ linux: false, distribution: 'FreeBSD', at: 1 })).toBeNull();
  });
});
