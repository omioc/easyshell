import { useMemo, useState } from 'react';
import {
  createSshProfile,
  normalizeLoginCommands,
  normalizePort,
  removeSshProfile,
  sshProfileTarget,
  sshProfileTitle,
  upsertSshProfile,
  validateSshProfile,
} from '@shared/profiles';
import type { SshProfileIssue } from '@shared/profiles';
import type { ConnectionTestResult, HostKeyPolicy, SshProfile } from '@shared/types';
import { useT } from '../i18n';
import { Field, NumberInput, Segmented, Select, TextInput } from './Fields';
import { IconCheck, IconClose, IconEye, IconEyeOff, IconFolder } from './Icons';
import { LoginCommandsEditor } from './LoginCommandsEditor';
import { PortForwardEditor } from './PortForwardEditor';
import { normalizePortForwards } from '@shared/port-forwards';

type AuthMode = 'password' | 'key' | 'agent';

const HOST_KEY_POLICIES = ['accept-new', 'strict', 'insecure'] as const;

export interface ConnectionEditorProps {
  /** `create` starts from a blank draft, `edit` loads `profileId`. */
  mode: 'create' | 'edit';
  /** The saved host being edited. Ignored in create mode. */
  profileId?: string;
  profiles: SshProfile[];
  defaultPort: number;
  /** Whether this machine seals the password this form writes. */
  secretsEncrypted: boolean;
  onClose: () => void;
  /** Writes the whole list back through `settings.ssh.profiles`. */
  onPersist: (profiles: SshProfile[]) => void;
  onConnect: (profile: SshProfile) => void;
  onSaved: () => void;
  onDeleted: () => void;
  onPickKey: () => Promise<string | null>;
  /** Opens a connection to the draft and hangs up; `App` also toasts the answer. */
  onTestConnection: (profile: SshProfile) => Promise<ConnectionTestResult>;
}

/**
 * Editor for one saved SSH host.
 *
 * The inventory in the sidebar owns the list of hosts and the menus that open
 * them, so this surface is only the form: no list, no search, no second way to
 * pick a host. It is a page in the main area rather than a dialog — the same
 * frame settings wears — so filling in a host never covers the terminal with a
 * floating box and a scrim.
 */
export function ConnectionEditor({
  mode,
  profileId,
  profiles,
  defaultPort,
  secretsEncrypted,
  onClose,
  onPersist,
  onConnect,
  onSaved,
  onDeleted,
  onPickKey,
  onTestConnection,
}: ConnectionEditorProps) {
  const t = useT();
  // The page mounts when it opens, so the mount is the only moment that seeds
  // the draft: nothing later can overwrite what the user is typing.
  /*
   * A new draft starts empty except for the port and the auth mode: the account
   * this machine logs in with is not the account a server wants, and guessing it
   * is how people save a host that cannot connect.
   */
  const [draft, setDraft] = useState<SshProfile>(() => {
    const existing = mode === 'edit' ? profiles.find((profile) => profile.id === profileId) : undefined;
    return existing ?? createSshProfile({ port: defaultPort, authType: 'password' });
  });
  const [secretVisible, setSecretVisible] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState(false);

  const issues = useMemo(() => validateSshProfile(draft), [draft]);
  const nameMissing = draft.name.trim().length === 0;
  const isSaved = profiles.some((profile) => profile.id === draft.id);

  const patch = (next: Partial<SshProfile>) => {
    // Any edit invalidates the tick: the old fields earned it, not these.
    setTestOk(false);
    setDraft((current) => ({ ...current, ...next }));
  };

  const errorFor = (field: SshProfileIssue['field']): string | null => {
    if (!submitted) return null;
    const found = issues.find((item) => item.field === field);
    return found ? t(found.key) : null;
  };
  const nameError = submitted && nameMissing ? t('connections.nameRequired') : null;

  /** Validates and writes; returns the persisted profile or null when blocked. */
  const save = (): SshProfile | null => {
    setSubmitted(true);
    if (nameMissing || issues.length > 0) return null;
    const saved: SshProfile = {
      ...draft,
      name: draft.name.trim(),
      host: draft.host.trim(),
      username: draft.username.trim(),
      port: normalizePort(draft.port, defaultPort),
      portForwards: normalizePortForwards(draft.portForwards),
      loginCommands: normalizeLoginCommands(draft.loginCommands),
      updatedAt: Date.now(),
    };
    onPersist(upsertSshProfile(profiles, saved));
    setDraft(saved);
    onSaved();
    return saved;
  };

  const saveAndConnect = () => {
    const saved = save();
    if (!saved) return;
    onConnect(saved);
    onClose();
  };

  const deleteProfile = () => {
    onPersist(removeSshProfile(profiles, draft.id));
    onDeleted();
    setConfirmDelete(false);
    onClose();
  };

  const pickKey = async () => {
    try {
      const path = await onPickKey();
      if (path) patch({ privateKeyPath: path });
    } catch {
      /* the native dialog was dismissed; keep the current path */
    }
  };

  /**
   * Asks the host to open a connection and hang up again. Only the connection
   * fields have to be valid - a host does not need a name to answer.
   */
  const runTest = async () => {
    setSubmitted(true);
    if (issues.length > 0) return;
    setTesting(true);
    setTestOk(false);
    try {
      const result = await onTestConnection(draft);
      setTestOk(result.ok);
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  };

  const title = isSaved ? sshProfileTitle(draft) : t('connections.newTitle');
  const subtitle = isSaved ? sshProfileTarget(draft) : t('connections.emptyHint');

  return (
    <section
      className="settings-page connections-page"
      aria-labelledby="connections-title"
      data-testid="connection-manager"
    >
      <header className="settings-page-head">
        <h2 className="settings-page-title" id="connections-title">
          {title}
        </h2>
        <p className="settings-page-hint">{subtitle}</p>
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

      <div className="settings-content connections-content">
        <div className="connections-form">
          <section className="conn-group" aria-labelledby="cm-basic-title">
            <h3 className="conn-group-label" id="cm-basic-title">
              <span className="conn-group-mark" aria-hidden="true" />
              {t('connections.basic')}
            </h3>

            <Field label={t('connections.name')} error={nameError} htmlFor="cm-name">
              <TextInput
                id="cm-name"
                testId="profile-name"
                value={draft.name}
                placeholder={t('connections.namePlaceholder')}
                invalid={Boolean(nameError)}
                autoFocus
                onValueChange={(value) => patch({ name: value })}
              />
            </Field>

            <div className="field-grid">
              <Field label={t('newSession.host')} error={errorFor('host')} htmlFor="cm-host">
                <TextInput
                  id="cm-host"
                  testId="profile-host"
                  value={draft.host}
                  mono
                  spellCheck={false}
                  placeholder={t('connections.hostPlaceholder')}
                  invalid={Boolean(errorFor('host'))}
                  onValueChange={(value) => patch({ host: value })}
                />
              </Field>
              <Field label={t('newSession.port')} error={errorFor('port')} htmlFor="cm-port">
                <NumberInput
                  id="cm-port"
                  testId="profile-port"
                  value={draft.port}
                  min={1}
                  max={65535}
                  onCommit={(value) => patch({ port: value })}
                />
              </Field>
            </div>

            <Field label={t('newSession.user')} error={errorFor('username')} htmlFor="cm-user">
              <TextInput
                id="cm-user"
                testId="profile-user"
                value={draft.username}
                mono
                spellCheck={false}
                placeholder={t('connections.userPlaceholder')}
                invalid={Boolean(errorFor('username'))}
                onValueChange={(value) => patch({ username: value })}
              />
            </Field>

            <Field label={t('newSession.auth')}>
              <Segmented<AuthMode>
                name="cm-auth"
                ariaLabel={t('newSession.auth')}
                value={draft.authType}
                onChange={(value) => patch({ authType: value })}
                options={[
                  { value: 'password', label: t('newSession.auth.password'), testId: 'auth-password' },
                  { value: 'key', label: t('newSession.auth.key'), testId: 'auth-key' },
                  { value: 'agent', label: t('newSession.auth.agent'), testId: 'auth-agent' },
                ]}
              />
            </Field>

            {draft.authType === 'password' ? (
              <>
                <Field label={t('newSession.password')} htmlFor="cm-password">
                  <div className="input-with-action">
                    <TextInput
                      id="cm-password"
                      testId="profile-password"
                      type={secretVisible ? 'text' : 'password'}
                      value={draft.password ?? ''}
                      onValueChange={(value) => patch({ password: value })}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={secretVisible ? t('connections.hideSecret') : t('connections.showSecret')}
                      data-tip={secretVisible ? t('connections.hideSecret') : t('connections.showSecret')}
                      aria-pressed={secretVisible}
                      onClick={() => setSecretVisible((value) => !value)}
                    >
                      {secretVisible ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </button>
                  </div>
                </Field>
                <p className="secret-note">
                  {t(secretsEncrypted ? 'connections.secretNote' : 'connections.secretNotePlain')}
                </p>
              </>
            ) : null}

            {draft.authType === 'key' ? (
              <>
                <Field
                  label={t('newSession.privateKey')}
                  error={errorFor('privateKeyPath')}
                  htmlFor="cm-key-path"
                >
                  <div className="input-with-action">
                    <TextInput
                      id="cm-key-path"
                      testId="profile-key-path"
                      value={draft.privateKeyPath ?? ''}
                      mono
                      readOnly
                      placeholder={t('connections.pickKeyHint')}
                      invalid={Boolean(errorFor('privateKeyPath'))}
                      onValueChange={(value) => patch({ privateKeyPath: value })}
                    />
                    <button
                      type="button"
                      className="button"
                      data-testid="profile-pick-key"
                      onClick={() => void pickKey()}
                    >
                      <IconFolder size={13} />
                      {t('connections.pickKey')}
                    </button>
                  </div>
                </Field>
                <Field label={t('newSession.passphrase')} htmlFor="cm-passphrase">
                  <TextInput
                    id="cm-passphrase"
                    testId="profile-passphrase"
                    type="password"
                    value={draft.passphrase ?? ''}
                    onValueChange={(value) => patch({ passphrase: value })}
                  />
                </Field>
                <p className="secret-note">
                  {t(secretsEncrypted ? 'connections.secretNote' : 'connections.secretNotePlain')}
                </p>
              </>
            ) : null}

            {draft.authType === 'agent' ? (
              <p className="secret-note">{t('connections.agentHint')}</p>
            ) : null}

            <Field label={t('connections.hostKeyOverride')} htmlFor="cm-host-key">
              <Select
                id="cm-host-key"
                testId="profile-host-key"
                value={draft.hostKeyPolicy ?? ''}
                onChange={(value) =>
                  patch({ hostKeyPolicy: value === '' ? undefined : (value as HostKeyPolicy) })
                }
                options={[
                  { value: '', label: t('connections.hostKeyDefault') },
                  ...HOST_KEY_POLICIES.map((policy) => ({
                    value: policy,
                    label: t(`settings.connection.hostKeyPolicy.${policy}`),
                  })),
                ]}
              />
            </Field>
          </section>

          <PortForwardEditor
            value={draft.portForwards}
            submitted={submitted}
            onChange={(portForwards) => patch({ portForwards })}
          />

          <LoginCommandsEditor
            value={draft.loginCommands}
            onChange={(loginCommands) =>
              patch({ loginCommands: loginCommands.length > 0 ? loginCommands : undefined })
            }
          />
        </div>
      </div>

      <footer className="connections-foot">
        {isSaved ? (
          confirmDelete ? (
            <div className="confirm-inline">
              <span className="confirm-text">
                {t('connections.deleteConfirm', { name: sshProfileTitle(draft) })}
              </span>
              <button
                type="button"
                className="button button-danger"
                data-testid="profile-delete-confirm"
                onClick={deleteProfile}
              >
                {t('connections.delete')}
              </button>
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button"
              data-testid="profile-delete"
              onClick={() => setConfirmDelete(true)}
            >
              {t('connections.delete')}
            </button>
          )
        ) : null}

        <div className="connections-actions">
          {/*
           * The two ways out of the page are gone on purpose: the header's X
           * closes, and starting the tab is the only thing worth saving for.
           * The test stands next to it and reports with a tick.
           */}
          <button
            type="button"
            className="button connections-test"
            data-testid="profile-test"
            data-ok={testOk ? 'true' : undefined}
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testOk ? <IconCheck size={13} /> : null}
            {testing ? t('connections.testing') : t('connections.test')}
          </button>
          <button
            type="button"
            className="button button-primary"
            data-testid="profile-save-connect"
            onClick={saveAndConnect}
          >
            {t('connections.saveAndConnect')}
          </button>
        </div>
      </footer>
    </section>
  );
}
