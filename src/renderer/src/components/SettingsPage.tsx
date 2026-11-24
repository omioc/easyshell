import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { AgentCliDetection } from '@shared/agents';
import { agentCliById, isDetectedAgentSelected } from '@shared/agents';
import type {
  ApplyIdentityResult,
  DeepPartial,
  IdentityMetadata,
  PlatformInfo,
  Settings,
  ShellProfile,
  ThemeMode,
} from '@shared/types';
import { COLOR_SCHEMES, resolveScheme } from '@shared/themes';
import { LOCALE_LABELS } from '@shared/i18n';
import { getBridge } from '../bridge';
import { useT } from '../i18n';
import { IDENTITY_FIELDS, IDENTITY_PRESETS, matchPreset, presetValues } from '../lib/identityPresets';
import type { IdentityPresetId } from '../lib/identityPresets';
import { formatDateTime } from '../lib/format';
import { effectiveDarkMode } from '../lib/theme';
import {
  DebouncedInput,
  Field,
  NumberInput,
  Select,
  Switch,
} from './Fields';
import { InfoRow } from './InfoRows';
import {
  IconAgent,
  IconCheck,
  IconClose,
  IconFolder,
  IconInfo,
  IconPalette,
  IconPlus,
  IconRefresh,
  IconServer,
  IconTerminal,
  IconUser,
} from './Icons';
import type { IconProps } from './Icons';

type SettingsSection = 'appearance' | 'shell' | 'connection' | 'agent' | 'identity' | 'about';

/**
 * The page list, with the same ingredients as a sidebar row: one 16px glyph, one
 * 13px label, 36px of height. Same shapes, same rhythm - the settings page is a
 * different surface, not a different product.
 */
const SECTIONS: Array<{
  id: SettingsSection;
  labelKey: string;
  icon: ComponentType<IconProps>;
}> = [
  { id: 'appearance', labelKey: 'settings.tab.appearance', icon: IconPalette },
  { id: 'shell', labelKey: 'settings.tab.shell', icon: IconTerminal },
  { id: 'connection', labelKey: 'settings.tab.connection', icon: IconServer },
  { id: 'agent', labelKey: 'settings.tab.agent', icon: IconAgent },
  { id: 'identity', labelKey: 'settings.tab.identity', icon: IconUser },
  { id: 'about', labelKey: 'settings.tab.about', icon: IconInfo },
];

const HOST_KEY_POLICIES = ['accept-new', 'strict', 'insecure'] as const;

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter((part) => part.length > 0);
}

type IdentityFieldKey = (typeof IDENTITY_FIELDS)[number]['key'];

export interface SettingsPageProps {
  settings: Settings;
  /** Whether the OS itself is dark, so the picker knows which schemes can apply. */
  systemDark: boolean;
  platform: PlatformInfo;
  wslDistributions: string[];
  onClose: () => void;
  patch: (patch: DeepPartial<Settings>) => void;
  onApplyIdentity: () => Promise<ApplyIdentityResult>;
  onRevealIdentity: () => void;
  onRefreshSettings: () => Promise<void>;
}

/**
 * One card per known ACP agent CLI.
 *
 * Detection happens in the main process and only reads PATH, so opening this
 * page cannot hang on a CLI that wants a login. A card that cannot be started is
 * still drawn — that is how the user learns it exists — but it cannot be picked,
 * and it says what to install instead, or that the CLI was simply not found
 * when there is no one-line install command to print.
 */
function AgentCliCards({
  agent,
  onPick,
}: {
  agent: Settings['agent'];
  onPick: (detection: AgentCliDetection) => void;
}) {
  const t = useT();
  const [detections, setDetections] = useState<AgentCliDetection[] | null>(null);
  const [busy, setBusy] = useState(false);

  const detect = useCallback(async () => {
    setBusy(true);
    try {
      setDetections(await getBridge().detectAgentClis());
    } catch {
      setDetections([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  return (
    <div className="settings-cli">
      <div className="settings-cli-head">
        <div className="settings-cli-heading">
          <h3 className="settings-cli-title">{t('settings.agent.cli.title')}</h3>
          <p className="settings-note">{t('settings.agent.cli.hint')}</p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => void detect()}
          disabled={busy}
          aria-busy={busy ? 'true' : undefined}
        >
          <IconRefresh size={13} />
          {busy ? t('settings.agent.cli.detecting') : t('settings.agent.cli.redetect')}
        </button>
      </div>

      {detections === null ? (
        <p className="settings-note">{t('settings.agent.cli.detecting')}</p>
      ) : (
        <div
          className="settings-cli-grid"
          role="radiogroup"
          aria-label={t('settings.agent.cli.title')}
        >
          {detections.map((detection) => {
            const definition = agentCliById(detection.id);
            if (!definition) return null;
            const usable = detection.state === 'available';
            const selected = isDetectedAgentSelected(detection, agent);
            /*
             * Both clamped lines below carry the rest in their tooltip, so the
             * copy is built once here instead of inline in the markup.
             */
            const description = t(definition.descriptionKey);
            const footer =
              detection.state === 'available'
                ? null
                : detection.state === 'adapter-missing'
                  ? t('settings.agent.cli.adapterHint', {
                      host: definition.hostBin ?? '',
                      command: detection.install,
                    })
                  : detection.state === 'missing' && detection.desktopApp
                    ? t('settings.agent.cli.desktopHint', {
                        path: detection.desktopApp,
                        command: detection.install,
                      })
                    : detection.state === 'missing' && detection.install
                      ? t('settings.agent.cli.installHint', { command: detection.install })
                      : detection.state === 'missing'
                        ? t('settings.agent.cli.missingHint')
                        : t('settings.agent.cli.unsupportedHint');
            const footerText = footer ?? detection.command;
            return (
              <button
                key={detection.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className="settings-cli-card"
                data-state={detection.state}
                data-selected={selected ? 'true' : undefined}
                disabled={!usable}
                onClick={() => {
                  if (usable) onPick(detection);
                }}
              >
                <span className="settings-cli-card-top">
                  <span className="settings-cli-name">{definition.name}</span>
                  {selected ? <IconCheck size={13} /> : null}
                </span>
                <span className="settings-cli-desc" data-tip={description}>
                  {description}
                </span>
                <span className="settings-cli-state" data-state={detection.state}>
                  {t(`settings.agent.cli.state.${detection.state}`)}
                </span>
                <span className="settings-cli-foot" data-tip={footerText}>
                  {footer === null ? (
                    <code className="settings-cli-path">{detection.command}</code>
                  ) : (
                    footer
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SettingsPage({
  settings,
  systemDark,
  platform,
  wslDistributions,
  onClose,
  patch,
  onApplyIdentity,
  onRevealIdentity,
  onRefreshSettings,
}: SettingsPageProps) {
  const t = useT();
  const [section, setSection] = useState<SettingsSection>('appearance');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(
    null,
  );

  const appearance = settings.appearance;
  // The picker follows the mode the window is in, and the tick marks the scheme
  // on screen rather than the stored id, which may belong to the other mode.
  const darkMode = effectiveDarkMode(appearance.theme, systemDark);
  const activeSchemeId = resolveScheme(appearance.colorScheme, darkMode).id;
  const patchAppearance = (next: Partial<Settings['appearance']>) => {
    patch({ appearance: { ...appearance, ...next } });
  };
  const patchShell = (next: Partial<Settings['shell']>) => {
    patch({ shell: { ...settings.shell, ...next } });
  };
  const patchProbe = (next: Partial<Settings['probe']>) => {
    patch({ probe: { ...settings.probe, ...next } });
  };
  const patchAgent = (next: Partial<Settings['agent']>) => {
    patch({ agent: { ...settings.agent, ...next } });
  };
  const patchIdentity = (next: Partial<IdentityMetadata>) => {
    patch({ identity: { ...settings.identity, ...next } });
  };
  const patchIdentityField = (key: IdentityFieldKey, value: string) => {
    const next = { ...settings.identity } as unknown as Record<string, unknown>;
    next[key] = value;
    patch({ identity: next as unknown as IdentityMetadata });
  };

  const profiles = settings.shell.profiles;
  const preset = matchPreset(settings.identity);

  const updateProfile = (index: number, next: Partial<ShellProfile>) => {
    const updated = profiles.map((profile, position) =>
      position === index ? { ...profile, ...next } : profile,
    );
    patchShell({ profiles: updated });
  };

  const addProfile = () => {
    let index = profiles.length + 1;
    while (profiles.some((profile) => profile.id === `custom-${index}`)) index += 1;
    const profile: ShellProfile = {
      id: `custom-${index}`,
      label: t('newSession.local'),
      kind: 'local',
      command: '',
      args: [],
    };
    patchShell({ profiles: [...profiles, profile] });
  };

  const removeProfile = (id: string) => {
    const updated = profiles.filter((profile) => profile.id !== id);
    const defaultProfileId =
      settings.shell.defaultProfileId === id ? updated[0]?.id ?? '' : settings.shell.defaultProfileId;
    patchShell({ profiles: updated, defaultProfileId });
  };

  const applyPreset = (id: IdentityPresetId) => {
    if (id === 'custom') return;
    const values = presetValues(id);
    if (values) patchIdentity(values);
  };

  const applyMetadata = async () => {
    setApplying(true);
    try {
      const result = await onApplyIdentity();
      setApplyResult({
        tone: result.portable ? 'warn' : 'ok',
        text: t(result.messageKey, result.params),
      });
      await onRefreshSettings();
    } catch (error) {
      setApplyResult({
        tone: 'error',
        text: t('settings.identity.result.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-page-head">
        <h2 className="settings-page-title" id="settings-title">
          {t('settings.title')}
        </h2>
        <p className="settings-page-hint">{t('settings.pageHint')}</p>
        <button
          type="button"
          className="icon-button"
          aria-label={t('common.close')}
          data-tip={t('common.close')}
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="settings-nav-item"
                data-active={section === item.id ? 'true' : undefined}
                aria-current={section === item.id ? 'true' : undefined}
                onClick={() => setSection(item.id)}
              >
                <span className="settings-nav-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <span className="settings-nav-label">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          {section === 'appearance' ? (
            <section className="settings-section">
              <div className="settings-field-row">
                <Field label={t('settings.language')} htmlFor="set-language" inline>
                  <Select
                    id="set-language"
                    value={settings.locale}
                    onChange={(value) => patch({ locale: value as Settings['locale'] })}
                    options={[
                      { value: 'auto', label: t('settings.language.auto') },
                      { value: 'zh', label: LOCALE_LABELS.zh },
                      { value: 'en', label: LOCALE_LABELS.en },
                    ]}
                  />
                </Field>
                <Field label={t('settings.theme')} htmlFor="set-theme" inline>
                  <Select
                    id="set-theme"
                    value={appearance.theme}
                    onChange={(value) => patchAppearance({ theme: value as ThemeMode })}
                    options={[
                      { value: 'system', label: t('settings.theme.system') },
                      { value: 'light', label: t('settings.theme.light') },
                      { value: 'dark', label: t('settings.theme.dark') },
                    ]}
                  />
                </Field>
              </div>

              <div className="settings-block">
                <p className="settings-block-title">{t('settings.colorScheme')}</p>
                <div className="scheme-grid">
                  {COLOR_SCHEMES.map((scheme) => {
                    const selected = scheme.id === activeSchemeId;
                    // A light scheme in a dark window would be swapped out for a
                    // dark one the moment it was picked, so it is not offered.
                    const usable = scheme.mode === (darkMode ? 'dark' : 'light');
                    return (
                      <button
                        key={scheme.id}
                        type="button"
                        className="scheme-card"
                        data-selected={selected ? 'true' : undefined}
                        data-mode={scheme.mode}
                        aria-pressed={selected}
                        disabled={!usable}
                        onClick={() => patchAppearance({ colorScheme: scheme.id })}
                      >
                        <span
                          className="scheme-swatch"
                          style={{ background: scheme.terminal.background }}
                        >
                          <span
                            className="scheme-swatch-bar"
                            style={{ background: scheme.ui.accent }}
                          />
                          <span className="scheme-swatch-dots">
                            <span style={{ background: scheme.terminal.red }} />
                            <span style={{ background: scheme.terminal.yellow }} />
                            <span style={{ background: scheme.terminal.green }} />
                          </span>
                        </span>
                        <span className="scheme-card-top">
                          <span className="scheme-name">{scheme.name}</span>
                          {selected ? <IconCheck size={12} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="settings-block">
                <div className="settings-field-row" data-columns="3">
                  <Field label={t('settings.fontSize')} htmlFor="set-font-size" inline>
                    <NumberInput
                      id="set-font-size"
                      value={appearance.fontSize}
                      min={10}
                      max={28}
                      onCommit={(value) => patchAppearance({ fontSize: value })}
                    />
                  </Field>
                  <Field label={t('settings.lineHeight')} htmlFor="set-line-height" inline>
                    <NumberInput
                      id="set-line-height"
                      value={appearance.lineHeight}
                      min={1}
                      max={2}
                      step={0.05}
                      onCommit={(value) => patchAppearance({ lineHeight: value })}
                    />
                  </Field>
                  <Field label={t('settings.letterSpacing')} htmlFor="set-letter-spacing" inline>
                    <NumberInput
                      id="set-letter-spacing"
                      value={appearance.letterSpacing}
                      min={0}
                      max={4}
                      step={1}
                      onCommit={(value) => patchAppearance({ letterSpacing: value })}
                    />
                  </Field>
                </div>
                <Field label={t('settings.fontFamily')} htmlFor="set-font-family">
                  <DebouncedInput
                    id="set-font-family"
                    value={appearance.fontFamily}
                    mono
                    onCommit={(value) => patchAppearance({ fontFamily: value })}
                  />
                </Field>
                <div className="settings-field-row">
                  <Field label={t('settings.cursorStyle')} htmlFor="set-cursor" inline>
                    <Select
                      id="set-cursor"
                      value={appearance.cursorStyle}
                      onChange={(value) =>
                        patchAppearance({ cursorStyle: value as Settings['appearance']['cursorStyle'] })
                      }
                      options={[
                        { value: 'bar', label: t('settings.cursorStyle.bar') },
                        { value: 'block', label: t('settings.cursorStyle.block') },
                        { value: 'underline', label: t('settings.cursorStyle.underline') },
                      ]}
                    />
                  </Field>
                  <Field label={t('settings.cursorBlink')} inline>
                    <Switch
                      checked={appearance.cursorBlink}
                      label={t('settings.cursorBlink')}
                      onChange={(checked) => patchAppearance({ cursorBlink: checked })}
                    />
                  </Field>
                </div>
                <div
                  className="term-preview"
                  style={{
                    fontFamily: appearance.fontFamily,
                    fontSize: `${appearance.fontSize}px`,
                    lineHeight: appearance.lineHeight,
                    letterSpacing: `${appearance.letterSpacing}px`,
                  }}
                >
                  <span className="term-preview-label">{t('settings.preview')}</span>
                  <div className="term-preview-line">
                    <span className="term-preview-path">demo@DEMO-PC</span>
                    <span className="term-preview-sep">:</span>
                    <span className="term-preview-path">~</span>
                    <span className="term-preview-prompt">$</span>
                    <span> {t('settings.previewSample')}</span>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {section === 'shell' ? (
            <section className="settings-section">
              <Field label={t('settings.shell.default')} htmlFor="set-default-profile" inline>
                <Select
                  id="set-default-profile"
                  value={settings.shell.defaultProfileId}
                  onChange={(value) => patchShell({ defaultProfileId: value })}
                  options={profiles.map((profile) => ({ value: profile.id, label: profile.label }))}
                />
              </Field>
              <Field label={t('settings.shell.wslDefault')} htmlFor="set-wsl-default" inline>
                <Select
                  id="set-wsl-default"
                  value={settings.shell.wslDefaultDistribution ?? ''}
                  onChange={(value) =>
                    patchShell({ wslDefaultDistribution: value === '' ? undefined : value })
                  }
                  options={[
                    { value: '', label: t('common.none') },
                    ...wslDistributions.map((name) => ({ value: name, label: name })),
                  ]}
                />
              </Field>

              <div className="settings-block">
                <p className="settings-block-title">{t('settings.shell.profiles')}</p>
                <div className="profile-list">
                  <div className="profile-row profile-row-head" aria-hidden="true">
                    <span>{t('settings.shell.profileLabel')}</span>
                    <span>{t('settings.shell.command')}</span>
                    <span>{t('settings.shell.args')}</span>
                    <span />
                  </div>
                  {profiles.map((profile, index) => (
                    <div className="profile-row" key={profile.id}>
                      <DebouncedInput
                        value={profile.label}
                        onCommit={(value) => updateProfile(index, { label: value })}
                      />
                      <DebouncedInput
                        value={profile.command}
                        mono
                        onCommit={(value) => updateProfile(index, { command: value })}
                      />
                      <DebouncedInput
                        value={profile.args.join(' ')}
                        mono
                        onCommit={(value) => updateProfile(index, { args: splitArgs(value) })}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`${t('settings.shell.remove')} ${profile.label}`}
                        data-tip={t('settings.shell.remove')}
                        disabled={profiles.length <= 1}
                        onClick={() => removeProfile(profile.id)}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  ))}
                </div>
                <button type="button" className="button profile-add" onClick={addProfile}>
                  <IconPlus size={14} />
                  {t('settings.shell.addProfile')}
                </button>
              </div>
            </section>
          ) : null}

          {section === 'connection' ? (
            <section className="settings-section">
              <Field label={t('settings.connection.hostKeyPolicy')} htmlFor="set-host-key" inline>
                <Select
                  id="set-host-key"
                  value={settings.ssh.hostKeyPolicy}
                  onChange={(value) =>
                    patch({ ssh: { ...settings.ssh, hostKeyPolicy: value as Settings['ssh']['hostKeyPolicy'] } })
                  }
                  options={HOST_KEY_POLICIES.map((policy) => ({
                    value: policy,
                    label: t(`settings.connection.hostKeyPolicy.${policy}`),
                  }))}
                />
              </Field>
              <div className="settings-field-row">
                <Field label={t('settings.connection.defaultPort')} htmlFor="set-ssh-port" inline>
                  <NumberInput
                    id="set-ssh-port"
                    value={settings.ssh.defaultPort}
                    min={1}
                    max={65535}
                    onCommit={(value) => patch({ ssh: { ...settings.ssh, defaultPort: value } })}
                  />
                </Field>
                <Field label={t('settings.connection.keepAlive')} htmlFor="set-keepalive" inline>
                  <NumberInput
                    id="set-keepalive"
                    value={settings.ssh.keepAliveSeconds}
                    min={0}
                    max={600}
                    onCommit={(value) => patch({ ssh: { ...settings.ssh, keepAliveSeconds: value } })}
                  />
                </Field>
              </div>

              <p className="settings-note">{t('settings.connection.manageHint')}</p>

              <div className="settings-block">
                <p className="settings-block-title">{t('settings.probe.title')}</p>
                <Field label={t('settings.probe.enabled')} inline>
                  <Switch
                    checked={settings.probe.enabled}
                    label={t('settings.probe.enabled')}
                    onChange={(checked) => patchProbe({ enabled: checked })}
                  />
                </Field>
                <Field label={t('settings.probe.nested')} inline>
                  <Switch
                    checked={settings.probe.nestedDetection}
                    label={t('settings.probe.nested')}
                    onChange={(checked) => patchProbe({ nestedDetection: checked })}
                  />
                </Field>
                <Field label={t('settings.probe.interval')} htmlFor="set-probe-interval" inline>
                  <NumberInput
                    id="set-probe-interval"
                    value={Math.round(settings.probe.intervalMs / 1000)}
                    min={5}
                    max={600}
                    onCommit={(value) => patchProbe({ intervalMs: value * 1000 })}
                  />
                </Field>
                <p className="settings-note">{t('settings.probe.hint')}</p>
              </div>
            </section>
          ) : null}

          {section === 'agent' ? (
            <section className="settings-section">
              <Field label={t('settings.agent.enabled')} inline>
                <Switch
                  checked={settings.agent.enabled}
                  label={t('settings.agent.enabled')}
                  onChange={(checked) => patchAgent({ enabled: checked })}
                />
              </Field>

              <AgentCliCards
                agent={settings.agent}
                onPick={(detection) =>
                  patchAgent({
                    command: detection.command,
                    args: detection.args,
                    enabled: true,
                  })
                }
              />

              <details className="settings-cli-custom">
                <summary>{t('settings.agent.cli.custom')}</summary>
                <Field
                  label={t('settings.agent.command')}
                  htmlFor="set-agent-command"
                  hint={t('settings.agent.commandHint')}
                >
                  <DebouncedInput
                    id="set-agent-command"
                    value={settings.agent.command}
                    mono
                    onCommit={(value) => patchAgent({ command: value })}
                  />
                </Field>

                <Field label={t('settings.agent.args')} htmlFor="set-agent-args">
                  <DebouncedInput
                    id="set-agent-args"
                    value={settings.agent.args.join(' ')}
                    mono
                    onCommit={(value) => patchAgent({ args: splitArgs(value) })}
                  />
                </Field>
              </details>

              <p className="settings-note">{t('settings.agent.hint')}</p>
              <p className="settings-note">{t('settings.agent.modeHint')}</p>
            </section>
          ) : null}

          {section === 'identity' ? (
            <section className="settings-section">
              <p className="settings-note">{t('settings.identity.hint')}</p>

              <div className="settings-block">
                <p className="settings-block-title">{t('settings.identity.preset')}</p>
                <div className="preset-row">
                  {IDENTITY_PRESETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="chip"
                      data-active={preset === item.id ? 'true' : undefined}
                      aria-pressed={preset === item.id}
                      onClick={() => applyPreset(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="identity-grid">
                {IDENTITY_FIELDS.map((field) => (
                  <Field key={field.key} label={t(field.labelKey)} htmlFor={`id-${field.key}`}>
                    <DebouncedInput
                      id={`id-${field.key}`}
                      value={settings.identity[field.key]}
                      mono
                      onCommit={(value) => patchIdentityField(field.key, value)}
                    />
                  </Field>
                ))}
              </div>

              <div className="identity-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void applyMetadata()}
                  disabled={applying}
                  aria-busy={applying ? 'true' : undefined}
                >
                  {applying ? t('settings.identity.applying') : t('settings.identity.apply')}
                </button>
                <button type="button" className="button" onClick={onRevealIdentity}>
                  <IconFolder size={14} />
                  {t('settings.identity.reveal')}
                </button>
              </div>

              {applyResult ? (
                <p className="identity-result" data-tone={applyResult.tone} role="status">
                  {applyResult.text}
                </p>
              ) : null}

              <p className="settings-note">
                {settings.identity.lastAppliedPath
                  ? t('settings.identity.lastApplied', { path: settings.identity.lastAppliedPath })
                  : t('settings.identity.neverApplied')}
                {settings.identity.lastAppliedAt ? (
                  <span className="tnum"> {'\u00b7'} {formatDateTime(settings.identity.lastAppliedAt)}</span>
                ) : null}
              </p>
              <p className="settings-note">{t(`settings.identity.platform.${platform.os}`)}</p>
            </section>
          ) : null}

          {section === 'about' ? (
            <section className="settings-section">
              <dl className="info-list">
                <InfoRow label={t('settings.about.version')} value={platform.appVersion} mono />
                <InfoRow label={t('settings.about.electron')} value={platform.electron} mono />
                <InfoRow label={t('settings.about.node')} value={platform.node} mono />
                <InfoRow
                  label={t('settings.about.platform')}
                  value={`${platform.os} \u00b7 ${platform.arch}`}
                  mono
                />
                <InfoRow label={t('settings.about.hostname')} value={platform.hostname} mono />
                <InfoRow label={t('settings.about.user')} value={platform.username} mono />
                <InfoRow label={t('settings.about.launchPath')} value={platform.launchPath} mono />
                <InfoRow
                  label={t('settings.about.wslDistributions')}
                  value={wslDistributions.join(', ')}
                />
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}