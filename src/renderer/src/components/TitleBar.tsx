import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { PlatformInfo } from '@shared/types';
import { useT } from '../i18n';
import { getBridge } from '../bridge';
import { IconClose, IconMaximize, IconMinimize, IconPanelRight, IconRestore } from './Icons';

export interface TitleBarProps {
  platform: PlatformInfo;
  /** Whether the right sheet is open, so its toggle can show that state. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * The open sheet's own tab row. It belongs here rather than in the sheet: it
   * shares this line with the toggle that opened it, and it is right-aligned
   * over the sheet below instead of floating in the middle of the tab strip.
   */
  panelTabs?: ReactNode;
}

/**
 * The right end of the top row: the drag strip, the sheet tabs, the panel toggle
 * and the window buttons.
 *
 * The row itself belongs to the tab strip, so tabs sit at the very top of the
 * window. The session name and connection state that used to live here are gone
 * on purpose: the tab already carries the name and a status dot, and the
 * terminal carries the state overlay, so this line was saying it a third time.
 */
export function TitleBar({ platform, panelOpen, onTogglePanel, panelTabs }: TitleBarProps) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  const native = platform.os === 'darwin';

  useEffect(() => {
    let alive = true;
    void getBridge()
      .getWindowState()
      .then((state) => {
        if (alive) setMaximized(state.maximized);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {/* Dragging the window still needs a strip that is not a tab or a button. */}
      <div className="titlebar-drag" data-testid="titlebar-drag" aria-hidden="true" />

      {panelTabs}

      <div className="window-controls">
        <button
          type="button"
          className="window-button"
          data-open={panelOpen ? 'true' : undefined}
          aria-pressed={panelOpen}
          aria-label={t('window.panel')}
          data-tip={t('window.panel')}
          data-tip-kbd="Ctrl+J"
          onClick={onTogglePanel}
        >
          <IconPanelRight size={15} />
        </button>
        {native ? (
          <div className="titlebar-native-spacer" aria-hidden="true" />
        ) : (
          <>
            <button
              type="button"
              className="window-button"
              aria-label={t('window.minimize')}
              data-tip={t('window.minimize')}
              onClick={() => void getBridge().windowMinimize()}
            >
              <IconMinimize size={14} />
            </button>
            <button
              type="button"
              className="window-button"
              aria-label={maximized ? t('window.restore') : t('window.maximize')}
              data-tip={maximized ? t('window.restore') : t('window.maximize')}
              onClick={() => {
                void getBridge()
                  .windowToggleMaximize()
                  .then((next) => setMaximized(next))
                  .catch(() => undefined);
              }}
            >
              {maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
            </button>
            <button
              type="button"
              className="window-button window-button-close"
              aria-label={t('window.close')}
              data-tip={t('window.close')}
              onClick={() => void getBridge().windowClose()}
            >
              <IconClose size={14} />
            </button>
          </>
        )}
      </div>
    </>
  );
}
