import { describe, expect, it } from 'vitest';
import { en, resolveLocale, translate, zh } from '../../src/shared/i18n';

describe('catalog parity', () => {
  it('has exactly the same keys in zh and en', () => {
    const english = Object.keys(en).sort();
    const chinese = Object.keys(zh).sort();
    const missingInZh = english.filter((key) => !(key in zh));
    const missingInEn = chinese.filter((key) => !(key in en));
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it('has no empty values and matching placeholders', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, key).toBeGreaterThan(0);
      const zhValue = (zh as Record<string, string>)[key] ?? '';
      const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(zhValue), key).toEqual(placeholders(value));
    }
  });
});

describe('translate', () => {
  it('interpolates parameters', () => {
    expect(translate('en', 'notice.cliSessions', { count: 3 })).toBe('Opened 3 session(s) from the command line');
    expect(translate('zh', 'notice.cliSessions', { count: 3 })).toBe('已从命令行打开 3 个会话');
  });

  it('falls back to english and then to the key', () => {
    expect(translate('zh', 'does.not.exist')).toBe('does.not.exist');
  });
});

describe('resolveLocale', () => {
  it('respects an explicit choice and otherwise follows the system', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh', 'en-US')).toBe('zh');
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh');
    expect(resolveLocale('auto', 'de-DE')).toBe('en');
  });
});