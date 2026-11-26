import { describe, expect, it } from 'vitest';
import {
  credentialKey,
  credentialLabel,
  credentialPort,
  findCredential,
  hasPassword,
  normalizeCredentials,
  removeCredential,
  touchCredential,
  upsertCredential,
} from '../../src/shared/credentials';
import type { SshCredential } from '../../src/shared/types';

function entry(partial: Partial<SshCredential> = {}): SshCredential {
  return {
    id: 'cred-1',
    username: 'root',
    host: '198.51.100.9',
    password: 'hunter2',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe('what a remembered password is keyed on', () => {
  it('is the login, case-insensitively, with 22 left out', () => {
    expect(credentialKey({ username: ' Root ', host: 'HOST.example', port: 22 })).toBe(
      'root@host.example',
    );
    expect(credentialKey({ username: 'root', host: 'host.example' })).toBe('root@host.example');
    expect(credentialKey({ username: 'root', host: 'host.example', port: 2222 })).toBe(
      'root@host.example:2222',
    );
  });

  it('says the login the way a person writes it', () => {
    expect(credentialLabel({ username: 'alice', host: '198.51.100.9', port: 22 })).toBe('alice@198.51.100.9');
    expect(credentialLabel({ username: 'alice', host: '198.51.100.9', port: 2200 })).toBe(
      'alice@198.51.100.9:2200',
    );
  });

  it('ignores a port that cannot be a port', () => {
    expect(credentialPort(0)).toBeUndefined();
    expect(credentialPort('x')).toBeUndefined();
    expect(credentialPort(70000)).toBeUndefined();
    expect(credentialPort(2222.7)).toBe(2222);
  });
});

describe('repairing what disk holds', () => {
  it('drops entries that cannot answer anything', () => {
    const list = normalizeCredentials([
      entry(),
      { id: 'no-password', username: 'root', host: 'x' },
      { id: 'no-host', username: 'root', password: 'p' },
      { id: 'no-user', host: 'x', password: 'p' },
      'nonsense',
      null,
    ]);
    expect(list.map((item) => item.id)).toEqual(['cred-1']);
  });

  it('keeps one entry per login, newest wins', () => {
    const list = normalizeCredentials([
      entry({ id: 'old', password: 'old', updatedAt: 1 }),
      entry({ id: 'new', password: 'new', updatedAt: 10 }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]?.password).toBe('new');
    // The id of the row is the one the UI is already pointing at.
    expect(list[0]?.id).toBe('old');
  });

  it('gives an unkeyed entry an id of its own', () => {
    const list = normalizeCredentials([{ username: 'root', host: 'h', password: 'p' }]);
    expect(list[0]?.id).toMatch(/^cred-/);
  });
});

describe('the vault as a list', () => {
  it('finds a password by login and by nothing else', () => {
    const list = [entry()];
    expect(findCredential(list, { username: 'root', host: '198.51.100.9' })?.password).toBe('hunter2');
    expect(findCredential(list, { username: 'root', host: '198.51.100.10' })).toBeUndefined();
    expect(findCredential(list, { username: 'deploy', host: '198.51.100.9' })).toBeUndefined();
  });

  it('replaces rather than appends, keeping the entry in place', () => {
    const first = upsertCredential([], entry({ id: '' }));
    const second = upsertCredential(
      [...first, entry({ id: 'other', username: 'deploy', host: '198.51.100.10' })],
      entry({ id: '', password: 'changed' }),
    );
    expect(second).toHaveLength(2);
    expect(findCredential(second, { username: 'root', host: '198.51.100.9' })?.password).toBe('changed');
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it('knows whether a password is already the one stored', () => {
    const list = [entry()];
    expect(hasPassword(list, entry(), 'hunter2')).toBe(true);
    expect(hasPassword(list, entry(), 'other')).toBe(false);
  });

  it('forgets one login and records the last use of another', () => {
    const list = [entry(), entry({ id: 'cred-2', username: 'deploy', host: '198.51.100.10' })];
    expect(removeCredential(list, 'cred-1').map((item) => item.id)).toEqual(['cred-2']);
    const used = touchCredential(list, 'cred-2');
    expect(used[1]?.lastUsedAt).toBeGreaterThan(0);
    expect(used[0]?.lastUsedAt).toBeUndefined();
  });
});
