import type { Locale } from '../types';
import { en } from './en';
import { zh } from './zh';

export type MessageKey = keyof typeof en;
export type Messages = Record<string, string>;

export const CATALOGS: Record<Locale, Messages> = { zh, en };

export function resolveLocale(requested: 'auto' | Locale, systemLocale: string): Locale {
  if (requested === 'zh' || requested === 'en') return requested;
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const catalog = CATALOGS[locale] ?? en;
  const raw = catalog[key] ?? (en as Messages)[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Locale names are intentionally not translated: they are used in a picker. */
export const LOCALE_LABELS: Record<Locale, string> = { zh: '中文', en: 'English' };

export { en, zh };
