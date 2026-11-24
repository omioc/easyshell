import { describe, expect, it } from 'vitest';
import { parseProbeOutput, probeLooksValid } from '../../src/main/metadata/probe';

const POSIX_OUTPUT = [
  'hostname=dev-box',
  'fqdn=dev-box.internal',
  'user=alice',
  'os=Ubuntu 24.04.1 LTS',
  'osVersion=24.04',
  'kernel=Linux 6.8.0-45-generic',
  'arch=x86_64',
  'shell=/bin/bash',
  'uptimeSeconds=123456',
  'cpuCount=8',
  'memoryKb=16318156',
  'timezone=Asia/Shanghai',
  'ips=198.18.0.5,198.18.1.5,',
].join('\n');

describe('parseProbeOutput', () => {
  it('maps every documented key', () => {
    const info = parseProbeOutput(POSIX_OUTPUT);
    expect(info).toMatchObject({
      hostname: 'dev-box',
      fqdn: 'dev-box.internal',
      user: 'alice',
      os: 'Ubuntu 24.04.1 LTS',
      osVersion: '24.04',
      kernel: 'Linux 6.8.0-45-generic',
      arch: 'x86_64',
      shell: '/bin/bash',
      uptimeSeconds: 123456,
      cpuCount: 8,
      timezone: 'Asia/Shanghai',
      memoryMb: 15936,
    });
    expect(info.ips).toEqual(['198.18.0.5', '198.18.1.5']);
    expect(typeof info.probedAt).toBe('number');
  });

  it('survives CRLF output and stray lines', () => {
    const info = parseProbeOutput('garbage\r\nhostname=win-box\r\n\r\nuser=alice\r\n');
    expect(info.hostname).toBe('win-box');
    expect(info.user).toBe('alice');
  });

  it('ignores unusable numbers', () => {
    const info = parseProbeOutput('hostname=h\ncpuCount=many\nuptimeSeconds=');
    expect(info.cpuCount).toBeUndefined();
    expect(info.uptimeSeconds).toBeUndefined();
  });

  it('reports validity', () => {
    expect(probeLooksValid(parseProbeOutput('hostname=h'))).toBe(true);
    expect(probeLooksValid(parseProbeOutput('nothing here'))).toBe(false);
  });
});