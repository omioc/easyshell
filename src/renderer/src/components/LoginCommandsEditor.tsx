import { useState } from 'react';
import { useT } from '../i18n';
import { TextInput } from './Fields';
import { IconCheck, IconClose } from './Icons';

/**
 * The commands a saved host types for you once the login is up.
 *
 * One command per record, in the order they will run: a login script is a
 * sequence, and the list is the sequence. Both the composer and the records are
 * the same height as a field, so the group reads as one column of lines rather
 * than as a form with a table bolted on.
 */
export function LoginCommandsEditor({
  value = [],
  onChange,
}: {
  value?: string[];
  onChange: (commands: string[]) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const command = draft.trim();
  const duplicate = command.length > 0 && value.includes(command);

  const add = () => {
    if (!command || duplicate) return;
    onChange([...value, command]);
    setDraft('');
  };

  const remove = (index: number) => onChange(value.filter((_, at) => at !== index));

  return (
    <section className="conn-group login-group" aria-labelledby="cm-login-commands-title">
      <h3 className="conn-group-label" id="cm-login-commands-title">
        <span className="conn-group-mark" aria-hidden="true" />
        {t('connections.loginCommands')}
      </h3>

      <div className="login-composer">
        <TextInput
          testId="login-command-input"
          value={draft}
          mono
          spellCheck={false}
          placeholder={t('connections.loginCommandPlaceholder')}
          invalid={duplicate}
          onValueChange={setDraft}
          onEnter={add}
        />
        <button
          type="button"
          className="forward-confirm"
          data-testid="login-command-add"
          aria-label={t('connections.loginCommandAdd')}
          data-tip={t('connections.loginCommandAdd')}
          disabled={!command || duplicate}
          onClick={add}
        >
          <IconCheck size={14} />
        </button>
      </div>

      {duplicate ? (
        <p className="field-error" role="alert">
          {t('connections.loginCommandDuplicate')}
        </p>
      ) : null}

      {value.length > 0 ? (
        <ul className="forward-records">
          {value.map((item, index) => (
            <li className="forward-record" key={`${index}-${item}`} data-testid={`login-command-record-${index}`}>
              <span className="login-command-text">{item}</span>
              <button
                type="button"
                className="icon-button forward-record-remove"
                aria-label={t('connections.loginCommandRemove', { index: index + 1 })}
                data-testid={`login-command-remove-${index}`}
                onClick={() => remove(index)}
              >
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="conn-group-hint">{t('connections.loginCommandsHint')}</p>
    </section>
  );
}
