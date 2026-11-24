/**
 * What happens to a saved password and a key passphrase on the way to disk.
 *
 * Both are sealed with the OS key store - DPAPI on Windows, the Keychain on
 * macOS, libsecret on Linux - so a copy of `settings.json` is useless on another
 * machine or another account: the key never leaves the OS. Values written before
 * this existed are still plain text and are sealed on the next save.
 *
 * The key store cannot be asked anything before the app is ready (`encryptString`
 * throws), so this module never decides that up front: `available()` is asked at
 * the moment of use, and a value that cannot be opened yet is left sealed rather
 * than dropped. `SettingsStore.settleSecrets()` is what finishes the job once the
 * app is ready.
 *
 * Where there is no key store at all - a Linux session without a keyring - the
 * app keeps working and writes the value as it is. Refusing to save a password
 * would be worse than saving it in the open, and `available()` is what the
 * editor's note reads to say which of the two happened.
 */

/** The slice of Electron's `safeStorage` this module needs. */
export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretCipher {
  /** True when a value can actually be sealed on this machine, right now. */
  available(): boolean;
  /** Plain text in, stored form out; a no-op when sealing is not possible. */
  seal(value: string): string;
  /** Stored form in, plain text out; a no-op for values written before sealing. */
  open(value: string): string;
}

/** Marks a sealed value. Anything else on disk was written before sealing. */
export const SEALED_PREFIX = 'enc:v1:';

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

export function createSecretCipher(storage: SecretStorage | null | undefined): SecretCipher {
  const usable = (): boolean => {
    if (!storage) return false;
    try {
      return storage.isEncryptionAvailable();
    } catch {
      // Asked before the app was ready: not usable yet, not broken either.
      return false;
    }
  };

  return {
    available: usable,

    seal(value) {
      // Already sealed: a second pass over the same value must not wrap it twice.
      if (!value || isSealed(value) || !usable()) return value;
      try {
        return `${SEALED_PREFIX}${storage!.encryptString(value).toString('base64')}`;
      } catch {
        // The OS refused. A password the user can still use beats one that is
        // lost to a failed seal.
        return value;
      }
    },

    open(value) {
      if (!value || !isSealed(value)) return value;
      // Not openable yet, or not openable here: keep it sealed so the next save
      // writes it back unchanged instead of erasing it.
      if (!usable()) return value;
      try {
        return storage!.decryptString(Buffer.from(value.slice(SEALED_PREFIX.length), 'base64'));
      } catch {
        // Sealed for another machine or another account. The ciphertext is of no
        // use to anyone, so the field reads as empty and the user types it again.
        return '';
      }
    },
  };
}
