import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  level: ToastLevel;
  text: string;
}

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setLeaving(true), 4200);
    return () => window.clearTimeout(timer);
  }, [item.id]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onDismiss(item.id), 150);
    return () => window.clearTimeout(timer);
  }, [leaving, item.id, onDismiss]);

  return (
    <div
      className="toast"
      data-level={item.level}
      data-shown={shown && !leaving ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      {/* The status glyph leads the sentence instead of sitting in a column of
          its own, so wrapped text falls back to the toast's left edge and runs
          under the icon rather than leaving it stranded on an empty line. */}
      <p className="toast-text">
        <span className="toast-icon" aria-hidden="true">
          {item.level === 'error' || item.level === 'warn' ? (
            <IconAlert size={14} />
          ) : item.level === 'success' ? (
            <IconCheck size={14} />
          ) : (
            <IconInfo size={14} />
          )}
        </span>
        {item.text}
      </p>
      <button
        type="button"
        className="toast-close"
        aria-label={t('common.close')}
        onClick={() => setLeaving(true)}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

export function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" role="region" aria-live="polite">
      {items.map((item) => (
        <Toast key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}