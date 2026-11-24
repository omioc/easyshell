import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../src/shared/defaults';
import { generateToken, mergeSettings, normalizeSettings } from '../../src/main/settings';

describe('mergeSettings', () => {
  const base = createDefaultSettings('linux');

  it('merges nested objects', () => {
    const merged = mergeSettings(base, { appearance: { fontSize: 16 } });
    expect(merged.appearance.fontSize).toBe(16);
    expect(merged.appearance.colorScheme).toBe(base.appearance.colorScheme);
  });

  it('replaces arrays instead of concatenating', () => {
    const merged = mergeSettings(base, {
      shell: { profiles: [{ id: 'x', label: 'X', kind: 'local', command: '/bin/x', args: [] }] },
    });
    expect(merged.shell.profiles).toHaveLength(1);
    expect(merged.shell.profiles[0]?.id).toBe('x');
  });

  it('ignores undefined values so a partial patch cannot erase defaults', () => {
    const merged = mergeSettings(base, { appearance: { fontFamily: undefined } });
    expect(merged.appearance.fontFamily).toBe(base.appearance.fontFamily);
  });
});

describe('normalizeSettings', () => {
  it('creates an api token when missing', () => {
    const settings = normalizeSettings({}, 'win32');
    expect(settings.api.token.length).toBeGreaterThan(20);
  });

  it('clamps nonsense values', () => {
    const settings = normalizeSettings(
      { api: { port: 99999 }, appearance: { fontSize: 200 }, probe: { intervalMs: 1 } },
      'win32',
    );
    expect(settings.api.port).toBe(65535);
    expect(settings.appearance.fontSize).toBe(32);
    expect(settings.probe.intervalMs).toBe(5000);
  });

  it('repairs a default profile that no longer exists', () => {
    const settings = normalizeSettings(
      {
        shell: {
          profiles: [{ id: 'only', label: 'Only', kind: 'local', command: '/bin/sh', args: [] }],
          defaultProfileId: 'missing',
        },
      },
      'linux',
    );
    expect(settings.shell.defaultProfileId).toBe('only');
  });

  it('keeps an existing token', () => {
    const token = generateToken();
    const settings = normalizeSettings({ api: { token } }, 'linux');
    expect(settings.api.token).toBe(token);
  });

  it('keeps the sidebar order the user arranged', () => {
    const settings = normalizeSettings(
      { layout: { sidebarCollapsed: true, sessionOrder: ['ssh:b', 'local:a', 'wsl:Ubuntu'] } },
      'linux',
    );
    expect(settings.layout.sessionOrder).toEqual(['ssh:b', 'local:a', 'wsl:Ubuntu']);
    expect(settings.layout.sidebarCollapsed).toBe(true);
  });

  it('drops junk, duplicates and runaway lengths from the sidebar order', () => {
    const settings = normalizeSettings(
      {
        layout: {
          sessionOrder: [
            'ssh:a',
            'ssh:a',
            '',
            '  ssh:b  ',
            42,
            null,
            ...Array.from({ length: 300 }, (_, index) => `ssh:n${index}`),
          ] as unknown as string[],
        },
      },
      'linux',
    );
    expect(settings.layout.sessionOrder.slice(0, 2)).toEqual(['ssh:a', 'ssh:b']);
    expect(settings.layout.sessionOrder).toHaveLength(200);
    expect(settings.layout.sessionOrder.every((key) => typeof key === 'string')).toBe(true);
  });

  it('an old settings file gets an empty sidebar order', () => {
    const settings = normalizeSettings({ layout: { sidebarCollapsed: false } }, 'linux');
    expect(settings.layout.sessionOrder).toEqual([]);
  });
});