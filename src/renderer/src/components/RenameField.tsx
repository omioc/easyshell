import { useEffect, useRef } from 'react';

export interface RenameFieldProps {
  /** Text the field opens with; also its accessible name. */
  value: string;
  className: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}

/**
 * One-line inline rename, shared by the tab strip and the sidebar.
 *
 * Renaming is a mode, and a mode has to end reliably: Escape cancels, Enter and
 * leaving the field commit. "Leaving" is watched from the document rather than
 * from the input's own `blur` alone, because not every press in this window
 * moves DOM focus. The terminal's scrollbar cancels the `mousedown` behind a
 * pointer press (so the terminal keeps its selection), and the window's drag
 * strips are consumed by the frame before the page sees them. In both cases the
 * field would keep DOM focus while the user believes they clicked away, and the
 * rename would stay open forever.
 */
export function RenameField({ value, className, onCommit, onCancel }: RenameFieldProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  /** Committing through two watchers must not send the same rename twice. */
  const settled = useRef(false);
  // Handlers change identity on every parent render; keep them out of the
  // subscription below so a re-render never tears the watchers down.
  const latest = useRef({ value, onCommit, onCancel });
  latest.current = { value, onCommit, onCancel };

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    const settle = (commit: boolean) => {
      if (settled.current) return;
      settled.current = true;
      const handlers = latest.current;
      if (commit) handlers.onCommit(ref.current?.value ?? handlers.value);
      else handlers.onCancel();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      settle(true);
    };
    // Alt-tabbing away does not produce a blur on the element in Electron.
    const onWindowBlur = () => settle(true);

    // While the field is open the window's drag strips step aside, so a press
    // there reaches the page and counts as a press somewhere else.
    const root = document.documentElement;
    root.dataset.inlineEdit = 'true';

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
      delete root.dataset.inlineEdit;
    };
  }, []);

  return (
    <input
      ref={ref}
      className={className}
      defaultValue={value}
      aria-label={value}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (settled.current) return;
        settled.current = true;
        latest.current.onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (settled.current) return;
          settled.current = true;
          latest.current.onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (settled.current) return;
          settled.current = true;
          latest.current.onCancel();
        }
      }}
    />
  );
}
