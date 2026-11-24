import { useRef } from 'react';
import { useT } from '../i18n';
import { pastedLineCount } from '../lib/clipboard';
import { Modal } from './Overlay';

export interface PasteConfirmProps {
  /** The clipboard text waiting for a decision; `null` closes the dialog. */
  text: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The gate in front of a paste that is more than one line.
 *
 * A right-click paste is one gesture with no chance to look at what it carries,
 * and a block of lines is a script: the dialog shows exactly what would reach
 * the shell, then hands the decision back. It keeps the last text while it
 * fades out, so the preview does not blank out under the closing animation.
 */
export function PasteConfirm({ text, onCancel, onConfirm }: PasteConfirmProps) {
  const t = useT();
  const shown = useRef('');
  if (text) shown.current = text;
  const preview = text ?? shown.current;

  return (
    <Modal
      open={text !== null}
      onClose={onCancel}
      labelledBy="paste-confirm-title"
      className="modal-paste"
      testId="paste-confirm"
    >
      <header className="modal-header">
        <h2 className="modal-title" id="paste-confirm-title">
          {t('terminal.paste.title')}
        </h2>
      </header>
      <div className="modal-body">
        <p className="modal-note">
          {t('terminal.paste.multiLine', { count: preview ? pastedLineCount(preview) : 0 })}
        </p>
        <pre className="paste-preview">{preview}</pre>
      </div>
      <footer className="modal-footer">
        <button type="button" className="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="button button-primary" data-autofocus onClick={onConfirm}>
          {t('terminal.paste.confirm')}
        </button>
      </footer>
    </Modal>
  );
}
