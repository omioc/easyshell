import { describe, expect, it } from 'vitest';
import { readHostPlatform } from '../../src/main/metadata/platform';
import { createSshProfile, recordHostFacts } from '../../src/shared/profiles';
import type { OsInfo, SshProfile } from '../../src/shared/types';

const ubuntu: OsInfo = {
  os: 'Ubuntu 22.04.5 LTS',
  osVersion: '22.04',
  kernel: 'Linux 5.15.0-91-generic',
  arch: 'x86_64',
};

describe('what a probe or a banner says the host is', () => {
  it('reads a Linux distribution out of PRETTY_NAME', () => {
    expect(readHostPlatform(ubuntu)).toEqual({ linux: true, distribution: 'Ubuntu' });
  });

  it('drops the version and the codename from the distribution', () => {
    expect(readHostPlatform({ os: 'Debian GNU/Linux 12 (bookworm)' })).toEqual({
      linux: true,
      distribution: 'Debian GNU/Linux',
    });
    expect(readHostPlatform({ os: 'Rocky Linux 9.3 (Blue Onyx)' })).toEqual({
      linux: true,
      distribution: 'Rocky Linux',
    });
    expect(readHostPlatform({ os: 'Alpine Linux v3.19.1' })).toEqual({
      linux: true,
      distribution: 'Alpine Linux',
    });
  });

  it('reports a bare Linux kernel as Linux without a distribution', () => {
    expect(readHostPlatform({ kernel: 'Linux 6.8.0-45-generic' })).toEqual({ linux: true });
  });

  it('keeps a host that only answered `uname -s` as generic Linux', () => {
    expect(readHostPlatform({ os: 'Linux', kernel: 'Linux 5.4.0-150-generic' })).toEqual({
      linux: true,
    });
  });

  it('reports a non-Linux host as not Linux', () => {
    expect(readHostPlatform({ os: 'FreeBSD', kernel: 'FreeBSD 13.2-RELEASE' })).toEqual({
      linux: false,
    });
    expect(readHostPlatform({ kernel: 'Darwin 23.4.0' })).toEqual({ linux: false });
    expect(readHostPlatform({ os: 'Microsoft Windows 11 Pro' })).toEqual({ linux: false });
  });

  it('says nothing when nothing was learned', () => {
    expect(readHostPlatform({})).toBeNull();
    expect(readHostPlatform({ os: '   ', kernel: '  ' })).toBeNull();
    expect(readHostPlatform({ os: 'SomeNAS 4.2' })).toBeNull();
  });

  it('trusts the kernel over a name that mentions Linux', () => {
    expect(readHostPlatform({ os: 'Umbrel Linux', kernel: 'FreeBSD 13.2-RELEASE' })).toEqual({
      linux: false,
    });
  });
});

const profile = (overrides: Partial<SshProfile> = {}): SshProfile =>
  createSshProfile({
    id: 'p1',
    name: 'Edge',
    host: '198.18.0.5',
    port: 22,
    username: 'demo',
    ...overrides,
  });

describe('recording what a session learned onto saved connections', () => {
  const at = 1_700_000_000_000;

  it('writes the facts onto the profile that points at that address', () => {
    const list = [profile({ id: 'a', host: '198.18.0.5' }), profile({ id: 'b', host: '198.18.0.9' })];
    const next = recordHostFacts(list, { host: '198.18.0.5', port: 22 }, { linux: true, distribution: 'Ubuntu' }, at);
    expect(next?.[0]?.detected).toEqual({ linux: true, distribution: 'Ubuntu', at });
    expect(next?.[1]?.detected).toBeUndefined();
  });

  it('matches the host case-insensitively and keeps every login user in sync', () => {
    const list = [
      profile({ id: 'root', host: 'Nas.Lan', username: 'root' }),
      profile({ id: 'demo', host: 'nas.lan', username: 'demo' }),
    ];
    const next = recordHostFacts(list, { host: 'nas.lan', port: 22 }, { linux: true, distribution: 'Debian' }, at);
    expect(next?.map((item) => item.detected?.distribution)).toEqual(['Debian', 'Debian']);
  });

  it('ignores a profile saved on another port', () => {
    const next = recordHostFacts(
      [profile({ port: 2222 })],
      { host: '198.18.0.5', port: 22 },
      { linux: true, distribution: 'Ubuntu' },
      at,
    );
    expect(next).toBeNull();
  });

  it('returns null when nothing changed, so settings are not rewritten', () => {
    const list = [
      profile({ detected: { linux: true, distribution: 'Ubuntu', at: at - 1000 } }),
    ];
    expect(recordHostFacts(list, { host: '198.18.0.5', port: 22 }, { linux: true, distribution: 'Ubuntu' }, at)).toBeNull();
  });

  it('replaces the facts when the same address comes back as another system', () => {
    const list = [
      profile({ detected: { linux: true, distribution: 'Ubuntu', at: at - 1000 } }),
    ];
    const next = recordHostFacts(list, { host: '198.18.0.5', port: 22 }, { linux: false }, at);
    expect(next?.[0]?.detected).toEqual({ linux: false, at });
  });

  it('does nothing without an address', () => {
    expect(recordHostFacts([profile()], {}, { linux: true }, at)).toBeNull();
  });

  it('drops a malformed detected block instead of trusting it', () => {
    const dirty = createSshProfile({ id: 'p', host: 'h', username: 'u', detected: { at } as never });
    expect(dirty.detected).toBeUndefined();
    const kept = createSshProfile({
      id: 'p',
      host: 'h',
      username: 'u',
      detected: { linux: true, distribution: '  Kali Linux  ', at },
    });
    expect(kept.detected).toEqual({ linux: true, distribution: 'Kali Linux', at });
  });
});
