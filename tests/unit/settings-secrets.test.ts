import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../src/shared/defaults';
import type { Settings } from '../../src/shared/types';
import { paths } from '../../src/main/paths';
import {
  SEALED_PREFIX,
  createSecretCipher,
  isSealed,
  type SecretStorage,
} from '../../src/main/secrets';
import {
  SettingsStore,
  hasSealedSecrets,
  openSettingsSecrets,
  sealSettingsSecrets,
} from '../../src/main/settings';

/** A key store that wraps rather than encrypts: enough to see the seam. */
function fakeStorage(available = true): SecretStorage & { setAvailable: (next: boolean) => void } {
  let usable = available;
  return {
    setAvailable: (next: boolean) => {
      usable = next;
    },
    isEncryptionAvailable: () => usable,
    encryptString: (plain: string) => Buffer.from(`sealed::${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('sealed::')) throw new Error('this key was sealed somewhere else');
      return text.slice('sealed::'.length);
    },
  };
}

function profile(password?: string, passphrase?: string) {
  return {
    id: 'ssh-1',
    name: 'Prod',
    host: '198.18.0.5',
    port: 22,
    username: 'root',
    authType: passphrase ? ('key' as const) : ('password' as const),
    password,
    privateKeyPath: passphrase ? 'C:/keys/id_ed25519' : undefined,
    passphrase,
    createdAt: 1,
    updatedAt: 1,
  };
}

function settingsWith(profiles: ReturnType<typeof profile>[]): Settings {
  const settings = createDefaultSettings('win32');
  return { ...settings, ssh: { ...settings.ssh, profiles } };
}

const readDisk = (): string => readFileSync(paths.settingsFile, 'utf8');

afterEach(() => {
  rmSync(paths.settingsFile, { force: true });
});

describe('a secret on its way to disk', () => {
  it('round-trips through the key store', () => {
    const cipher = createSecretCipher(fakeStorage());
    const sealed = cipher.seal('hunter2');
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(cipher.open(sealed)).toBe('hunter2');
  });

  it('leaves a value written before sealing alone', () => {
    const cipher = createSecretCipher(fakeStorage());
    expect(cipher.open('hunter2')).toBe('hunter2');
  });

  it('never wraps the same value twice', () => {
    const cipher = createSecretCipher(fakeStorage());
    const once = cipher.seal('hunter2');
    expect(cipher.seal(once)).toBe(once);
  });

  it('writes plain text when no key store is available, and says so', () => {
    const cipher = createSecretCipher(fakeStorage(false));
    expect(cipher.available()).toBe(false);
    expect(cipher.seal('hunter2')).toBe('hunter2');
  });

  it('keeps a sealed value sealed when it cannot be opened yet', () => {
    const storage = fakeStorage(false);
    const cipher = createSecretCipher(storage);
    const sealed = `${SEALED_PREFIX}${Buffer.from('sealed::hunter2', 'utf8').toString('base64')}`;
    // Before `ready` the key store answers nothing: the value must survive.
    expect(cipher.open(sealed)).toBe(sealed);
    storage.setAvailable(true);
    expect(cipher.open(sealed)).toBe('hunter2');
  });

  it('reports nothing for a value sealed on another machine', () => {
    const cipher = createSecretCipher(fakeStorage());
    const foreign = `${SEALED_PREFIX}${Buffer.from('from another keychain').toString('base64')}`;
    expect(cipher.open(foreign)).toBe('');
  });

  it('survives a key store that throws', () => {
    const broken: SecretStorage = {
      isEncryptionAvailable: () => {
        throw new Error('not ready');
      },
      encryptString: () => {
        throw new Error('not ready');
      },
      decryptString: () => {
        throw new Error('not ready');
      },
    };
    const cipher = createSecretCipher(broken);
    expect(cipher.available()).toBe(false);
    expect(cipher.seal('hunter2')).toBe('hunter2');
  });
});

describe('the fields a settings file carries as secrets', () => {
  const cipher = createSecretCipher(fakeStorage());

  it('seals the password and the passphrase, and nothing else', () => {
    const sealed = sealSettingsSecrets(settingsWith([profile('hunter2'), profile(undefined, 'phrase')]), cipher);
    const [passwordProfile, keyProfile] = sealed.ssh?.profiles ?? [];
    expect(isSealed(passwordProfile?.password ?? '')).toBe(true);
    expect(isSealed(keyProfile?.passphrase ?? '')).toBe(true);
    expect(passwordProfile?.host).toBe('198.18.0.5');
    expect(passwordProfile?.name).toBe('Prod');
  });

  it('opens both back into what the app can use', () => {
    const sealed = sealSettingsSecrets(settingsWith([profile('hunter2'), profile(undefined, 'phrase')]), cipher);
    const opened = openSettingsSecrets(sealed, cipher);
    expect(opened.ssh?.profiles?.[0]?.password).toBe('hunter2');
    expect(opened.ssh?.profiles?.[1]?.passphrase).toBe('phrase');
  });

  it('notices whether anything is still sealed', () => {
    expect(hasSealedSecrets(settingsWith([profile('hunter2')]))).toBe(false);
    expect(hasSealedSecrets(sealSettingsSecrets(settingsWith([profile('hunter2')]), cipher))).toBe(true);
  });
});

describe('a settings store that keeps its secrets sealed', () => {
  const writeFixture = (settings: Settings) => {
    mkdirSync(dirname(paths.settingsFile), { recursive: true });
    writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  };

  it('holds the password in memory and only ciphertext on disk', () => {
    writeFixture(settingsWith([profile('hunter2')]));
    const store = new SettingsStore('win32', createSecretCipher(fakeStorage()));

    expect(store.get().ssh.profiles[0]?.password).toBe('hunter2');
    expect(store.secretsEncrypted).toBe(true);
    const disk = readDisk();
    expect(disk).toContain(SEALED_PREFIX);
    expect(disk).not.toContain('hunter2');
  });

  it('migrates a plain-text file once the key store answers', () => {
    writeFixture(settingsWith([profile('hunter2')]));
    const storage = fakeStorage(false);
    const store = new SettingsStore('win32', createSecretCipher(storage));
    expect(readDisk()).toContain('hunter2'); // nothing to seal with yet

    storage.setAvailable(true);
    store.settleSecrets();

    expect(store.get().ssh.profiles[0]?.password).toBe('hunter2');
    expect(readDisk()).not.toContain('hunter2');
    expect(readDisk()).toContain(SEALED_PREFIX);
  });

  it('drops a password sealed for another machine instead of showing it', () => {
    const foreign = `${SEALED_PREFIX}${Buffer.from('from another keychain', 'utf8').toString('base64')}`;
    writeFixture(settingsWith([{ ...profile(), password: foreign }]));

    const store = new SettingsStore('win32', createSecretCipher(fakeStorage()));
    expect(store.get().ssh.profiles[0]?.password ?? '').toBe('');
  });

  it('keeps writing plain text where there is no key store at all', () => {
    writeFixture(settingsWith([profile('hunter2')]));
    const store = new SettingsStore('win32', createSecretCipher(fakeStorage(false)));
    store.settleSecrets();
    expect(store.secretsEncrypted).toBe(false);
    expect(readDisk()).toContain('hunter2');
  });
});
