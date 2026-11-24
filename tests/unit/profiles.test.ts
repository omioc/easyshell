import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SSH_PORT,
  buildSshSpecFromProfile,
  createSshProfile,
  normalizePort,
  normalizeSshProfiles,
  removeSshProfile,
  sshProfileTarget,
  sshProfileTitle,
  upsertSshProfile,
  validateSshProfile,
} from '../../src/shared/profiles';
import type { SshProfile } from '../../src/shared/types';

function profile(partial: Partial<SshProfile> = {}): SshProfile {
  return createSshProfile({
    name: 'web-01',
    host: '198.18.0.7',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    ...partial,
  });
}

describe('normalizePort', () => {
  it('clamps and repairs', () => {
    expect(normalizePort(2222)).toBe(2222);
    expect(normalizePort('2200')).toBe(2200);
    expect(normalizePort(0)).toBe(DEFAULT_SSH_PORT);
    expect(normalizePort(-5)).toBe(DEFAULT_SSH_PORT);
    expect(normalizePort(99999)).toBe(65535);
    expect(normalizePort('abc')).toBe(DEFAULT_SSH_PORT);
    expect(normalizePort(22.7)).toBe(22);
  });
});

describe('createSshProfile', () => {
  it('fills defaults and trims text', () => {
    const created = createSshProfile({ host: '  h  ', username: ' u ', authType: 'key', privateKeyPath: ' ~/.ssh/id ' });
    expect(created.host).toBe('h');
    expect(created.username).toBe('u');
    expect(created.authType).toBe('key');
    expect(created.privateKeyPath).toBe('~/.ssh/id');
    expect(created.port).toBe(22);
    expect(created.id).toMatch(/^ssh-/);
    expect(created.createdAt).toBeGreaterThan(0);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createSshProfile().id));
    expect(ids.size).toBe(20);
  });

  it('rejects unknown auth types', () => {
    expect(createSshProfile({ authType: 'nope' as never }).authType).toBe('password');
  });
});

describe('normalizeSshProfiles', () => {
  it('drops junk, repairs duplicates and keeps order', () => {
    const list = normalizeSshProfiles([
      { id: 'a', host: 'h1', username: 'u1', password: 'p' },
      null,
      'nope',
      { id: 'a', host: 'h2', username: 'u2' },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.host).toBe('h1');
    expect(list[1]?.host).toBe('h2');
    expect(list[1]?.id).not.toBe('a');
  });

  it('returns an empty list for a non-array', () => {
    expect(normalizeSshProfiles(undefined)).toEqual([]);
    expect(normalizeSshProfiles({})).toEqual([]);
  });
});

describe('validateSshProfile', () => {
  it('needs host, user, port and a key when key auth is selected', () => {
    expect(validateSshProfile(profile())).toEqual([]);
    const broken = createSshProfile({ authType: 'key' });
    const fields = validateSshProfile(broken).map((issue) => issue.field).sort();
    expect(fields).toEqual(['host', 'privateKeyPath', 'username']);
  });

  it('reports an out-of-range port on a hand-built record', () => {
    // createSshProfile clamps, so an invalid port can only arrive from a form
    // draft or a hand-edited settings file.
    const raw = { ...profile(), port: 70_000 } as SshProfile;
    expect(validateSshProfile(raw).map((issue) => issue.key)).toContain('newSession.portInvalid');
    const zero = { ...profile(), port: 0 } as SshProfile;
    expect(validateSshProfile(zero).map((issue) => issue.key)).toContain('newSession.portInvalid');
  });
});

describe('buildSshSpecFromProfile', () => {
  const options = { hostKeyPolicy: 'accept-new' as const };

  it('maps password auth and uses the profile name as title', () => {
    const spec = buildSshSpecFromProfile(profile(), options);
    expect(spec).not.toBeNull();
    if (spec?.kind !== 'ssh') throw new Error('expected ssh spec');
    expect(spec.target).toMatchObject({
      host: '198.18.0.7',
      port: 22,
      username: 'root',
      auth: { type: 'password', password: 'secret' },
      hostKeyPolicy: 'accept-new',
    });
    expect(spec.title).toBe('web-01');
  });

  it('maps key auth with a passphrase', () => {
    const spec = buildSshSpecFromProfile(
      profile({ authType: 'key', privateKeyPath: 'C:/keys/id_ed25519', passphrase: 'pw', password: undefined }),
      options,
    );
    if (spec?.kind !== 'ssh') throw new Error('expected ssh spec');
    expect(spec.target.auth).toEqual({
      type: 'key',
      privateKeyPath: 'C:/keys/id_ed25519',
      passphrase: 'pw',
    });
  });

  it('maps agent auth and honours a per-profile host key policy', () => {
    const spec = buildSshSpecFromProfile(
      profile({ authType: 'agent', password: undefined, hostKeyPolicy: 'strict' }),
      options,
    );
    if (spec?.kind !== 'ssh') throw new Error('expected ssh spec');
    expect(spec.target.auth).toEqual({ type: 'agent' });
    expect(spec.target.hostKeyPolicy).toBe('strict');
  });

  it('refuses an incomplete profile', () => {
    expect(buildSshSpecFromProfile(createSshProfile({}), options)).toBeNull();
  });
});

describe('labels', () => {
  it('formats the target and falls back to it for the title', () => {
    expect(sshProfileTarget(profile())).toBe('root@198.18.0.7');
    expect(sshProfileTarget(profile({ port: 2222 }))).toBe('root@198.18.0.7:2222');
    expect(sshProfileTitle(profile({ name: '' }))).toBe('root@198.18.0.7');
    expect(sshProfileTitle(profile())).toBe('web-01');
  });
});

describe('list helpers', () => {
  it('upserts by id and stamps updatedAt', () => {
    const first = profile({ id: 'keep' });
    const list = upsertSshProfile([first], { ...first, name: 'renamed', updatedAt: 0 });
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('renamed');
    expect(list[0]?.updatedAt).toBeGreaterThan(0);
    expect(upsertSshProfile(list, profile({ id: 'second' }))).toHaveLength(2);
  });

  it('removes by id', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })];
    expect(removeSshProfile(list, 'a').map((item) => item.id)).toEqual(['b']);
  });
});