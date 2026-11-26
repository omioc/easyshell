import { useState } from 'react';
import { forwardEndpoint, normalizeForwardHost, validatePortForwards } from '@shared/port-forwards';
import type { SshPortForward } from '@shared/types';
import { useT } from '../i18n';
import { Field, Segmented, TextInput } from './Fields';
import { IconArrowRight, IconCheck, IconClose } from './Icons';

type Mode = SshPortForward['mode'];

/** A rule that has not been added yet. Ports stay empty until the user types one. */
interface Draft {
  mode: Mode;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

const EMPTY_DRAFT: Draft = {
  mode: 'local',
  bindHost: '127.0.0.1',
  bindPort: 0,
  targetHost: '127.0.0.1',
  targetPort: 0,
};

/**
 * The tunnels a saved host opens with.
 *
 * One composer stays on screen, and the rules the host already has are listed
 * under it as records. That is the shape of the thing itself: a forwarding rule
 * is a short line, not a form, and a card per rule meant the form was mostly
 * empty boxes. Adding is a tick at the end of the line you just filled in;
 * removing is a control on the record, where the rule is.
 */
export function PortForwardEditor({
  value = [],
  submitted,
  onChange,
}: {
  value?: SshPortForward[];
  submitted: boolean;
  onChange: (rules: SshPortForward[]) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [attempted, setAttempted] = useState(false);

  /**
   * Why the draft cannot be added: the same rules the saved list is held to,
   * asked of the line that would be appended, so a duplicate listener is caught
   * before it exists instead of after it fails to bind.
   */
  const draftIssues = validatePortForwards([...value, draft]).filter(
    (issue) => issue.index === value.length,
  );

  /**
   * A save attempt reveals a leftover draft too — but only one the user has
   * actually started: the hosts are pre-filled, and an empty composer must not
   * raise two port errors on every save.
   */
  const draftStarted = draft.bindPort > 0 || draft.targetPort > 0;
  const showIssues = attempted || (submitted && draftStarted);

  const errorFor = (field: keyof SshPortForward): string | null => {
    if (!showIssues) return null;
    const issue = draftIssues.find((item) => item.field === field);
    return issue ? t(issue.key) : null;
  };

  /** The sentences under the row: one per distinct problem, in issue order. */
  const messages = showIssues
    ? [...new Set(draftIssues.map((issue) => t(issue.key)))]
    : [];

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const add = () => {
    if (draftIssues.length > 0) {
      setAttempted(true);
      return;
    }
    onChange([
      ...value,
      {
        mode: draft.mode,
        bindHost: normalizeForwardHost(draft.bindHost),
        bindPort: draft.bindPort,
        targetHost: normalizeForwardHost(draft.targetHost),
        targetPort: draft.targetPort,
      },
    ]);
    // The next rule is usually the same shape on another port; the addresses
    // stay, the ports go, so the line is ready for the next pair.
    setAttempted(false);
    setDraft((current) => ({ ...current, bindPort: 0, targetPort: 0 }));
  };

  const remove = (index: number) => onChange(value.filter((_, at) => at !== index));

  return (
    <section className="conn-group forward-group" aria-labelledby="cm-forwarding-title">
      <h3 className="conn-group-label" id="cm-forwarding-title">
        <span className="conn-group-mark" aria-hidden="true" />
        {t('connections.forwarding')}
      </h3>
      <p className="conn-group-hint">
        {t(draft.mode === 'local' ? 'connections.forwardLocalHint' : 'connections.forwardRemoteHint')}
      </p>

      <div className="forward-composer">
        <Segmented<Mode>
          name="cm-forward-mode"
          ariaLabel={t('connections.forwardMode')}
          value={draft.mode}
          onChange={(mode) => patch({ mode })}
          options={[
            { value: 'local', label: t('connections.forwardLocal'), testId: 'forward-local' },
            { value: 'remote', label: t('connections.forwardRemote'), testId: 'forward-remote' },
          ]}
        />

        <div className="forward-tuple">
          {(['bind', 'target'] as const).map((side) => {
            const hostField = side === 'bind' ? 'bindHost' : 'targetHost';
            const portField = side === 'bind' ? 'bindPort' : 'targetPort';
            return (
              <div className="forward-endpoint" key={side} data-side={side}>
                <Field label={t(`connections.forward.${hostField}`)} htmlFor={`cm-forward-${hostField}`}>
                  <TextInput
                    id={`cm-forward-${hostField}`}
                    testId={`forward-${hostField}`}
                    value={draft[hostField]}
                    mono
                    placeholder="127.0.0.1"
                    invalid={Boolean(errorFor(hostField))}
                    onValueChange={(host) => patch({ [hostField]: host })}
                    onEnter={add}
                  />
                </Field>
                <span className="forward-colon" aria-hidden="true">
                  :
                </span>
                <Field label={t(`connections.forward.${portField}`)} htmlFor={`cm-forward-${portField}`}>
                  <input
                    id={`cm-forward-${portField}`}
                    data-testid={`forward-${portField}`}
                    className="input input-number"
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="21380"
                    value={draft[portField] || ''}
                    aria-invalid={Boolean(errorFor(portField))}
                    data-invalid={errorFor(portField) ? 'true' : undefined}
                    onChange={(event) => patch({ [portField]: Number(event.target.value) })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') add();
                    }}
                  />
                </Field>
              </div>
            );
          })}

          <IconArrowRight size={12} className="forward-arrow" />

          <button
            type="button"
            className="forward-confirm"
            data-testid="forward-add"
            aria-label={t('connections.forwardConfirm')}
            data-tip={t('connections.forwardConfirm')}
            onClick={add}
          >
            <IconCheck size={14} />
          </button>
        </div>

        {/*
         * What is wrong belongs to the line, not to one narrow column: an error
         * under a 82px port field wraps into a paragraph and pushes the row out
         * of alignment. The fields carry the red border; the sentence sits here.
         */}
        {messages.length > 0 ? (
          <p className="field-error" role="alert">
            {messages.join(' · ')}
          </p>
        ) : null}
      </div>

      {value.length > 0 ? (
        <ul className="forward-records">
          {value.map((rule, index) => (
            <li
              // A rule has no id of its own; its listener plus its place in the
              // list is what tells two records apart while one is being removed.
              key={`${rule.mode}-${rule.bindHost}-${rule.bindPort}-${index}`}
              className="forward-record"
              data-testid={`forward-record-${index}`}
            >
              <span className="forward-record-flag">{rule.mode === 'remote' ? '-R' : '-L'}</span>
              <span className="forward-record-endpoint">
                {forwardEndpoint(rule.bindHost, rule.bindPort)}
              </span>
              <IconArrowRight size={11} className="forward-record-arrow" />
              <span className="forward-record-endpoint">
                {forwardEndpoint(rule.targetHost, rule.targetPort)}
              </span>
              <button
                type="button"
                className="icon-button forward-record-remove"
                aria-label={t('connections.forwardRemove', { index: index + 1 })}
                data-tip={t('connections.forwardRemoveHint')}
                data-testid={`forward-remove-${index}`}
                onClick={() => remove(index)}
              >
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="conn-group-hint">{t('connections.forwardLifetime')}</p>
    </section>
  );
}
