import type { CredentialRequest } from '@shared/types';
import { useT } from '../i18n';

/**
 * The one question a password prompt leaves to the user besides the password.
 *
 * It floats over the top of the terminal it belongs to, because that is where
 * the prompt is: the user is looking at the prompt, not at a dialog in the
 * middle of the window. It never takes the focus — the terminal keeps it — so
 * typing is how you say "I'll do it myself", and the buttons are the mouse's.
 */
export function CredentialPromptBar({
  request,
  onRespond,
}: {
  request: CredentialRequest;
  onRespond: (decision: 'accept' | 'dismiss') => void;
}) {
  const t = useT();
  const saving = request.kind === 'save';
  return (
    <div
      className="credential-bar"
      data-kind={request.kind}
      role="group"
      aria-live="polite"
      aria-label={t(saving ? 'credential.saveTitle' : 'credential.fillTitle', { label: request.label })}
    >
      <div className="credential-bar-text">
        <p className="credential-bar-title">
          {t(saving ? 'credential.saveTitle' : 'credential.fillTitle', { label: request.label })}
        </p>
        <p className="credential-bar-hint">
          {t(saving ? 'credential.saveHint' : 'credential.fillHint')}
        </p>
      </div>
      <div className="credential-bar-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="credential-accept"
          onClick={() => onRespond('accept')}
        >
          {t(saving ? 'credential.save' : 'credential.use')}
        </button>
        <button
          type="button"
          className="button"
          data-testid="credential-dismiss"
          onClick={() => onRespond('dismiss')}
        >
          {t('credential.dismiss')}
        </button>
      </div>
    </div>
  );
}
