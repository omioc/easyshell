import { describe, expect, it } from 'vitest';
import { BANNER_HINT, LOGIN_SIGNATURE, distroName, parseLoginBanner } from '../../src/main/metadata/banner';

// The exact shape of an Ubuntu login over ssh, escapes and all.
const UBUNTU_LOGIN = [
  '\u001b[?2004hWelcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\r\n',
  '\r\n',
  ' * Documentation:  https://help.ubuntu.com\r\n',
  ' * Management:     https://landscape.canonical.com\r\n',
  ' * Support:        https://ubuntu.com/pro\r\n',
  '\r\n',
  'System information as of Mon Nov 16 08:48:18 AM CST 2026\r\n',
  '\r\n',
  '  System load:  0.15               Processes:             240\r\n',
  '  Usage of /:   31.6% of 27.86GB   Users logged in:       0\r\n',
  '  Memory usage: 36%                IPv4 address for eth0: 203.0.113.3\r\n',
  '  Swap usage:   0%\r\n',
  '\r\n',
  '71 updates can be applied immediately.\r\n',
  'Failed to connect to https://changelogs.ubuntu.com/meta-release-lts.\r\n',
  '\r\n',
  'Last login: Mon Nov 16 08:47:05 2026 from 203.0.113.2\r\n',
  '\u001b[32m\u001b[1mroot@node-01\u001b[m:~# ',
].join('');

describe('parseLoginBanner', () => {
  it('reads the distribution, kernel and kernel arch', () => {
    const { os } = parseLoginBanner(UBUNTU_LOGIN);
    expect(os.os).toBe('Ubuntu 22.04.3 LTS');
    expect(os.osVersion).toBe('22.04');
    expect(os.kernel).toBe('Linux 5.15.0-91-generic');
    expect(os.arch).toBe('x86_64');
  });

  it('reads the address the host printed about itself', () => {
    expect(parseLoginBanner(UBUNTU_LOGIN).os.ips).toEqual(['203.0.113.3']);
  });

  it('reads user and host from the prompt', () => {
    const { os } = parseLoginBanner(UBUNTU_LOGIN);
    expect(os.user).toBe('root');
    expect(os.hostname).toBe('node-01');
  });

  it('keeps the MOTD numbers it does understand', () => {
    const { extra } = parseLoginBanner(UBUNTU_LOGIN);
    expect(extra['banner.load']).toBe('0.15');
    expect(extra['banner.memory']).toBe('36%');
    expect(extra['banner.disk']).toBe('31.6% of 27.86GB');
    expect(extra['banner.updates']).toBe('71');
    expect(extra['banner.lastLogin']).toBe('Mon Nov 16 08:47:05 2026 from 203.0.113.2');
  });

  it('copes with a host that prints no banner at all', () => {
    const { os, extra } = parseLoginBanner('root@minimal:~# ');
    expect(os.os).toBeUndefined();
    expect(os.kernel).toBeUndefined();
    expect(extra).toEqual({});
    expect(os.hostname).toBe('minimal');
  });

  it('reads a non-Ubuntu banner and a Linux version line', () => {
    const rhel = parseLoginBanner(
      'Welcome to Rocky Linux 9.3 (Blue Onyx)\nLinux version 5.14.0-362.el9.x86_64 (mockbuild@x) #1 SMP x86_64\n',
    );
    expect(rhel.os.os).toBe('Rocky Linux 9.3');
    expect(rhel.os.kernel).toBe('Linux 5.14.0-362.el9.x86_64');
    expect(rhel.os.arch).toBe('x86_64');
  });
  it('reads the bracketed prompt CentOS, RHEL and Kylin print', () => {
    const { os } = parseLoginBanner(
      [
        'Welcome to Alibaba Cloud Elastic Compute Service !\r\n',
        'Last login: Thu Nov 12 16:50:31 2026 from 192.0.2.5\r\n',
        '[bob@demo-instance bob]$ ',
      ].join(''),
    );
    expect(os.user).toBe('bob');
    expect(os.hostname).toBe('demo-instance');
  });

});

describe('BANNER_HINT', () => {
  it('only lets plausible banner text through', () => {
    expect(BANNER_HINT.test(UBUNTU_LOGIN)).toBe(true);
    expect(BANNER_HINT.test('root@node-01:~# ls -la\r\n')).toBe(false);
  });
});

describe('LOGIN_SIGNATURE', () => {
  it('matches only the lines an interactive login prints', () => {
    expect(LOGIN_SIGNATURE.test('Last login: Mon Nov 16 08:47:05 2026 from 203.0.113.2\r\n')).toBe(true);
    expect(LOGIN_SIGNATURE.test('System information as of Mon Nov 16 08:48:18 AM CST 2026')).toBe(true);
    expect(LOGIN_SIGNATURE.test('  Last login: yesterday')).toBe(true);
    expect(LOGIN_SIGNATURE.test("printf '%s' 'Last login: x'")).toBe(false);
    expect(LOGIN_SIGNATURE.test('root@node-01:~# ip addr')).toBe(false);
  });
});

describe('distroName', () => {
  it('strips the version and the parenthetical', () => {
    expect(distroName('Ubuntu 22.04.5 LTS')).toBe('Ubuntu');
    expect(distroName('Debian GNU/Linux 12 (bookworm)')).toBe('Debian GNU/Linux');
    expect(distroName('Rocky Linux 9.3 (Blue Onyx)')).toBe('Rocky Linux');
    expect(distroName('Alpine Linux v3.19')).toBe('Alpine Linux');
    expect(distroName('Arch Linux')).toBe('Arch Linux');
  });

  it('has nothing to say about an unknown host', () => {
    expect(distroName(undefined)).toBeUndefined();
    expect(distroName('   ')).toBeUndefined();
  });
  it('keeps a version number that is uppercase-suffixed', () => {
    expect(distroName('Kylin Linux Advanced Server V10 (Lance)')).toBe('Kylin Linux Advanced Server V10');
  });

});
