import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../src/shared/defaults';
import { isPluginEnabled, normalizeDisabledPlugins, togglePluginDisabled } from '../../src/shared/plugins';
import { createDefaultSsoSettings, normalizeSsoSettings } from '../../src/shared/sso';
import { parseInvocation } from '../../src/main/cli/parse';
import type { CliParseContext } from '../../src/main/cli/parse';
import { linkPlugins, parseSsoLink, pluginCatalog, PluginRuntime } from '../../src/main/plugins';
import type { PluginHost } from '../../src/main/plugins';
import type { PlatformOs, Settings, SsoPluginSettings } from '../../src/shared/types';

function ssoLink(payload: unknown): string {
  return `sso://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

const BASTION = {
  NODE_COMMON: {
    AssetProtocol: 'ssh',
    IPv4: '198.51.100.9',
    Port: 60022,
    Username: 'alice_SSO',
    SSOToken: 'one-time-token',
  },
};

const ctx: CliParseContext = {
  defaultSshPort: 22,
  hostKeyPolicy: 'accept-new',
  defaultUsername: 'alice',
  profiles: [{ id: 'zsh', label: 'zsh', kind: 'local', command: '/bin/zsh', args: ['-l'] }],
  defaultProfileId: 'zsh',
};

function settingsWith(
  os: PlatformOs,
  disabled: string[] = [],
  sso: Partial<SsoPluginSettings> = {},
): Settings {
  const settings = createDefaultSettings(os);
  return {
    ...settings,
    plugins: { disabled, sso: { ...createDefaultSsoSettings(), ...sso } },
  };
}

describe('parseSsoLink', () => {
  it('reads the login a USM bastion payload carries', () => {
    expect(parseSsoLink(ssoLink(BASTION))).toEqual({
      host: '198.51.100.9',
      port: 60022,
      username: 'alice_SSO',
      password: 'one-time-token',
    });
  });

  it('reads the payload bare, without a NODE_COMMON container', () => {
    expect(parseSsoLink(ssoLink({ ...BASTION.NODE_COMMON }))).toMatchObject({
      host: '198.51.100.9',
      username: 'alice_SSO',
    });
  });

  it('accepts base64url and a URL-encoded link', () => {
    const base64url = Buffer.from(JSON.stringify(BASTION), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(parseSsoLink(`sso://${encodeURIComponent(base64url)}`)).toMatchObject({
      host: '198.51.100.9',
    });
  });

  it('refuses anything that is not a usable SSH asset', () => {
    expect(parseSsoLink('sso://')).toBeNull();
    expect(parseSsoLink('sso://not-base64-json')).toBeNull();
    expect(parseSsoLink(ssoLink({ NODE_COMMON: { AssetProtocol: 'rdp', IPv4: '198.51.100.9' } }))).toBeNull();
    expect(parseSsoLink(ssoLink({ NODE_COMMON: { AssetProtocol: 'ssh', Port: 22 } }))).toBeNull();
    expect(parseSsoLink('https://example.test/')).toBeNull();
  });
});

describe('parseInvocation with plugins', () => {
  it('turns an sso:// link into an ssh session when the plugin is on', () => {
    const result = parseInvocation([ssoLink(BASTION)], { ...ctx, plugins: linkPlugins(settingsWith('darwin')) });
    if (result.type !== 'spawn') throw new Error('expected spawn');
    expect(result.specs).toHaveLength(1);
    const spec = result.specs[0];
    if (spec?.kind !== 'ssh') throw new Error('expected ssh');
    expect(spec.target).toMatchObject({
      host: '198.51.100.9',
      port: 60022,
      username: 'alice_SSO',
      auth: { type: 'password', password: 'one-time-token' },
    });
    expect(spec.origin).toMatchObject({ via: 'url' });
  });

  it('ignores the same link when the plugin is switched off', () => {
    const result = parseInvocation([ssoLink(BASTION)], { ...ctx, plugins: linkPlugins(settingsWith('darwin', ['sso'])) });
    expect(result.type).toBe('none');
  });

  it('drops a claimed but broken link instead of opening a local shell', () => {
    const result = parseInvocation(['sso://garbage'], { ...ctx, plugins: linkPlugins(settingsWith('darwin')) });
    expect(result.type).toBe('none');
  });

  it('understands the scheme the settings name, not a hard-coded one', () => {
    const link = `usm://${Buffer.from(JSON.stringify(BASTION)).toString('base64')}`;
    const settings = settingsWith('darwin', [], { schemes: ['usm'] });
    const result = parseInvocation([link], { ...ctx, plugins: linkPlugins(settings) });
    if (result.type !== 'spawn') throw new Error('expected spawn');
    expect(result.specs).toHaveLength(1);

    // And the old scheme is no longer the app's to decode.
    const before = parseInvocation([ssoLink(BASTION)], { ...ctx, plugins: linkPlugins(settings) });
    expect(before.type).toBe('none');
  });

  it('reaches the plugin through the -newtab and -url wrappers', () => {
    const link = ssoLink(BASTION);
    for (const argv of [['-newtab', link], ['-url', link]]) {
      const result = parseInvocation(argv, { ...ctx, plugins: linkPlugins(settingsWith('darwin')) });
      if (result.type !== 'spawn') throw new Error('expected spawn');
      expect(result.specs[0]?.kind).toBe('ssh');
    }
  });
});

describe('parseSsoLink with a configured mapping', () => {
  const withMap = (next: Partial<SsoPluginSettings>): SsoPluginSettings => ({
    ...createDefaultSsoSettings(),
    ...next,
  });

  it('follows a vendor scheme, container and field names', () => {
    const vendor = {
      asset: {
        Host: '203.0.113.7',
        Port: 2200,
        Login: 'bob',
        Ticket: 'tk-1',
        Type: 'ssh',
      },
    };
    const url = `usm://${encodeURIComponent(Buffer.from(JSON.stringify(vendor)).toString('base64'))}`;
    expect(
      parseSsoLink(
        url,
        withMap({
          schemes: ['usm'],
          container: 'asset',
          hostField: 'IP',
          portField: 'Port',
          usernameField: 'Login',
          tokenField: 'Ticket',
        }),
      ),
    ).toEqual({ host: '203.0.113.7', port: 2200, username: 'bob', password: 'tk-1' });
  });

  it('reads a plain JSON payload when the bastion does not base64 it', () => {
    const url = `sso://${encodeURIComponent(
      JSON.stringify({ IPv4: '198.51.100.9', Port: 22, Username: 'alice', SSOToken: 'tok' }),
    )}`;
    expect(parseSsoLink(url, withMap({ format: 'json', container: '' }))).toMatchObject({
      host: '198.51.100.9',
      username: 'alice',
    });
  });

  it('applies the protocol whitelist, and skips it when the list is empty', () => {
    const url = ssoLink(BASTION);
    expect(parseSsoLink(url, withMap({ protocols: ['vnc'] }))).toBeNull();
    expect(parseSsoLink(url, withMap({ protocols: [] }))).toMatchObject({ host: '198.51.100.9' });
  });

  it('repairs a half-written mapping instead of trusting it', () => {
    const defaults = createDefaultSsoSettings();
    expect(normalizeSsoSettings(undefined)).toEqual(defaults);
    expect(normalizeSsoSettings({ schemes: ['USM://x', ''], protocols: 'SSH' })).toMatchObject({
      schemes: ['usm'],
      protocols: ['ssh'],
    });
    expect(normalizeSsoSettings({ schemes: [] })).toMatchObject({ schemes: defaults.schemes });
    expect(normalizeSsoSettings({ protocols: [] })).toMatchObject({ protocols: [] });
    expect(normalizeSsoSettings({ format: 'bogus' })).toMatchObject({ format: 'base64-json' });
  });
});

describe('plugin settings', () => {
  const pluginSettings = (disabled: string[] = []): Settings['plugins'] => ({
    disabled,
    sso: createDefaultSsoSettings(),
  });

  it('treats the deny-list as the only exception to a plugin default', () => {
    const [plugin] = pluginCatalog();
    expect(plugin).toBeDefined();
    if (!plugin) return;
    expect(isPluginEnabled(plugin, pluginSettings())).toBe(true);
    expect(isPluginEnabled(plugin, pluginSettings([plugin.id]))).toBe(false);
    expect(isPluginEnabled({ id: 'opt-in', enabledByDefault: false }, pluginSettings())).toBe(false);
  });

  it('flips one switch without touching the others', () => {
    expect(togglePluginDisabled(['a', 'b'], 'c', false)).toEqual(['a', 'b', 'c']);
    expect(togglePluginDisabled(['a', 'b'], 'a', true)).toEqual(['b']);
  });

  it('repairs a disabled list written by hand', () => {
    expect(normalizeDisabledPlugins([' sso ', '', 42, 'sso', null])).toEqual(['sso']);
    expect(normalizeDisabledPlugins('sso')).toEqual([]);
  });
});

describe('PluginRuntime', () => {
  function harness() {
    const claimed = new Set<string>();
    const released: string[] = [];
    const host: PluginHost = {
      platform: 'darwin',
      settings: () => settingsWith('darwin'),
      claimUrlScheme: (scheme) => {
        claimed.add(scheme);
        return true;
      },
      releaseUrlScheme: (scheme) => {
        released.push(scheme);
      },
    };
    return { runtime: new PluginRuntime(host), claimed, released };
  }

  it('claims a scheme when the plugin comes on and releases it when it goes off', () => {
    const { runtime, claimed, released } = harness();
    runtime.sync(settingsWith('darwin'));
    expect(runtime.isActive('sso')).toBe(true);
    expect([...claimed]).toEqual(['sso']);

    // Unrelated settings writes must not re-claim, which would re-register the
    // scheme with LaunchServices on every patch.
    runtime.sync(settingsWith('darwin'));
    expect(released).toEqual([]);

    runtime.sync(settingsWith('darwin', ['sso']));
    expect(runtime.isActive('sso')).toBe(false);
    expect(released).toEqual(['sso']);

    runtime.sync(settingsWith('darwin'));
    expect(runtime.isActive('sso')).toBe(true);
    expect([...claimed]).toEqual(['sso']);
  });

  it('moves the claim when the configured scheme changes', () => {
    const { runtime, claimed, released } = harness();
    runtime.sync(settingsWith('darwin'));

    runtime.sync(settingsWith('darwin', [], { schemes: ['sso', 'usm'] }));
    expect([...claimed]).toEqual(['sso', 'usm']);
    expect(released).toEqual([]);

    runtime.sync(settingsWith('darwin', [], { schemes: ['usm'] }));
    expect(released).toEqual(['sso']);
    expect([...claimed]).toEqual(['sso', 'usm']);
  });
});
