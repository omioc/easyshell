import { describe, expect, it } from 'vitest';
import {
  extractCliArgs,
  parseInvocation,
  parseSshCommandLine,
  parseSshUrl,
  tokenize,
} from '../../src/main/cli/parse';
import type { CliParseContext } from '../../src/main/cli/parse';

const ctx: CliParseContext = {
  defaultSshPort: 22,
  hostKeyPolicy: 'accept-new',
  defaultUsername: 'alice',
  profiles: [
    { id: 'powershell', label: 'PowerShell', kind: 'local', command: 'powershell.exe', args: ['-NoLogo'] },
    { id: 'bash', label: 'bash', kind: 'local', command: '/bin/bash', args: ['-l'] },
  ],
  defaultProfileId: 'powershell',
};

describe('tokenize', () => {
  it('handles quotes, escapes and empty strings', () => {
    expect(tokenize(`a "b c" 'd e'`)).toEqual(['a', 'b c', 'd e']);
    expect(tokenize(`ssh -p 22 'alice_SSO_tok'@198.18.0.1`)).toEqual([
      'ssh',
      '-p',
      '22',
      'alice_SSO_tok@198.18.0.1',
    ]);
    expect(tokenize('a "say \\"hi\\"" b')).toEqual(['a', 'say "hi"', 'b']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('parseSshCommandLine', () => {
  it('reads the sshpass + ssh shape a bastion portal uses', () => {
    const fields = parseSshCommandLine(
      `sshpass -p tok123 ssh -p 60022 'alice_SSO_tok'@192.0.2.7`,
    );
    expect(fields).toMatchObject({
      host: '192.0.2.7',
      port: 60022,
      username: 'alice_SSO_tok',
      password: 'tok123',
    });
  });

  it('reads private key and user flags', () => {
    const fields = parseSshCommandLine('ssh -i ~/.ssh/id_ed25519 -l root -p 2222 198.18.0.5');
    expect(fields).toMatchObject({
      host: '198.18.0.5',
      port: 2222,
      username: 'root',
      privateKeyPath: '~/.ssh/id_ed25519',
    });
  });

  it('reads plink style switches', () => {
    const fields = parseSshCommandLine('plink -ssh -P 2200 -l admin -pw s3cret 198.18.0.9');
    expect(fields).toMatchObject({ host: '198.18.0.9', port: 2200, username: 'admin', password: 's3cret' });
  });

  it('keeps a remote command out of the destination', () => {
    const fields = parseSshCommandLine('ssh root@198.18.0.5 uptime -p');
    expect(fields?.host).toBe('198.18.0.5');
    expect(fields?.remoteCommand).toBe('uptime -p');
  });

  it('returns null for anything that is not a login', () => {
    expect(parseSshCommandLine('notepad.exe')).toBeNull();
    expect(parseSshCommandLine('')).toBeNull();
  });
});

describe('parseSshUrl', () => {
  it('parses scheme, user, host and port', () => {
    expect(parseSshUrl('ssh://root@198.18.0.5:2022')).toEqual({ username: 'root', host: '198.18.0.5', port: 2022 });
    expect(parseSshUrl('ssh://198.18.0.5')).toEqual({ username: undefined, host: '198.18.0.5', port: undefined });
    expect(parseSshUrl('http://198.18.0.5')).toBeNull();
  });
});

describe('parseInvocation', () => {
  it('turns a MobaXterm -newtab line into an ssh session', () => {
    const result = parseInvocation(
      ['-newtab', `sshpass -p tok123 ssh -p 60022 'alice_SSO_tok'@192.0.2.7`],
      ctx,
    );
    expect(result.type).toBe('spawn');
    if (result.type !== 'spawn') return;
    expect(result.specs).toHaveLength(1);
    const spec = result.specs[0];
    expect(spec?.kind).toBe('ssh');
    if (spec?.kind !== 'ssh') return;
    expect(spec.target).toMatchObject({
      host: '192.0.2.7',
      port: 60022,
      username: 'alice_SSO_tok',
      auth: { type: 'password', password: 'tok123' },
      hostKeyPolicy: 'accept-new',
    });
    expect(spec.origin).toMatchObject({ type: 'cli', via: 'newtab' });
  });

  it('collects Xshell switches into a single session', () => {
    const result = parseInvocation(['-ssh', '198.18.0.5', '-l', 'root', '-p', '2200', '-pw', 'pw'], ctx);
    if (result.type !== 'spawn') throw new Error('expected spawn');
    expect(result.specs).toHaveLength(1);
    const spec = result.specs[0];
    if (spec?.kind !== 'ssh') throw new Error('expected ssh');
    expect(spec.target).toMatchObject({ host: '198.18.0.5', port: 2200, username: 'root' });
  });

  it('accepts an ssh url with a trailing password flag', () => {
    const result = parseInvocation(['-url', 'ssh://root@198.18.0.5:2022', '-pw', 'secret'], ctx);
    if (result.type !== 'spawn') throw new Error('expected spawn');
    const spec = result.specs[0];
    if (spec?.kind !== 'ssh') throw new Error('expected ssh');
    expect(spec.target).toMatchObject({ host: '198.18.0.5', port: 2022, username: 'root' });
    expect(spec.target.auth).toEqual({ type: 'password', password: 'secret' });
  });

  it('supports the native flags', () => {
    const wsl = parseInvocation(['--wsl', 'Ubuntu'], ctx);
    if (wsl.type !== 'spawn') throw new Error('expected spawn');
    expect(wsl.specs[0]).toMatchObject({ kind: 'wsl', distribution: 'Ubuntu' });

    const local = parseInvocation(['--local', 'bash'], ctx);
    if (local.type !== 'spawn') throw new Error('expected spawn');
    expect(local.specs[0]).toMatchObject({ kind: 'local', command: '/bin/bash', args: ['-l'] });
  });

  it('falls back to a local shell for an unknown newtab command', () => {
    const result = parseInvocation(['-newtab', 'notepad.exe'], ctx);
    if (result.type !== 'spawn') throw new Error('expected spawn');
    expect(result.specs[0]).toMatchObject({ kind: 'local', initialCommand: 'notepad.exe' });
  });

  it('recognises control subcommands', () => {
    expect(parseInvocation(['ls'], ctx)).toEqual({ type: 'api', command: 'ls', args: [] });
    expect(parseInvocation(['info', 'abc'], ctx)).toEqual({ type: 'api', command: 'info', args: ['abc'] });
    expect(parseInvocation(['exec', 'abc', '--', 'uname', '-a'], ctx)).toEqual({
      type: 'api',
      command: 'exec',
      args: ['abc', '--', 'uname', '-a'],
    });
    expect(parseInvocation(['--help'], ctx).type).toBe('help');
    expect(parseInvocation(['--version'], ctx).type).toBe('version');
  });

  it('handles locale and activation flags', () => {
    const result = parseInvocation(['--lang', 'en', '--no-activate', '--wsl'], ctx);
    if (result.type !== 'spawn') throw new Error('expected spawn');
    expect(result.locale).toBe('en');
    expect(result.activate).toBe(false);
  });

  it('reports "none" for an empty or meaningless command line', () => {
    expect(parseInvocation([], ctx)).toEqual({ type: 'none' });
    expect(parseInvocation(['-unknown'], ctx)).toEqual({ type: 'none' });
  });
});

describe('extractCliArgs', () => {
  it('drops the executable and the app path when unpackaged', () => {
    expect(extractCliArgs(['electron.exe', 'app', '-newtab', 'x'], false)).toEqual(['-newtab', 'x']);
    expect(extractCliArgs(['EasyShell.exe', '-newtab', 'x'], true)).toEqual(['-newtab', 'x']);
  });
});