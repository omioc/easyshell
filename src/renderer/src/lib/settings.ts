import type { DeepPartial, Settings } from '@shared/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Local, optimistic merge used before the host answers. Patches always carry a
 * complete sub-object (see `lib/settings.ts` call sites), but merging deeply
 * keeps this safe for hand-written partials too.
 */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  const target = base as unknown as Record<string, unknown>;
  const source = patch as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const patchValue = source[key];
    if (patchValue === undefined) continue;
    const baseValue = target[key];
    next[key] = isPlainObject(patchValue) && isPlainObject(baseValue)
      ? { ...baseValue, ...patchValue }
      : patchValue;
  }
  return next as unknown as Settings;
}

/** Sixteen random bytes, base64url-free: easy to paste into a header. */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
