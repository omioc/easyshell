import { useEffect, useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useT } from '../i18n';
import { IconAgent, IconFolderSync, IconInfo } from './Icons';
import type { IconProps } from './Icons';

/** The three things the docked right sheet can show. */
export type SidePanelTab = 'tasks' | 'terminal' | 'sftp';

/**
 * Reading order of the sheet's own row: what this terminal is, the files of the
 * machine it is on, then the assistant. All three are icons - the window's top
 * row has no room for more word-shaped pills, and the tooltip says the name the
 * moment it is wanted.
 */
const TABS: SidePanelTab[] = ['terminal', 'sftp', 'tasks'];

/** The icon the app already uses wherever it points at the same thing. */
const TAB_ICONS: Record<SidePanelTab, ComponentType<IconProps>> = {
  terminal: IconInfo,
  sftp: IconFolderSync,
  tasks: IconAgent,
};

export interface SidePanelTabsProps {
  tab: SidePanelTab;
  onSelectTab: (tab: SidePanelTab) => void;
}

/**
 * The sheet's tab row, docked in the window's top row rather than inside the
 * card.
 *
 * The sheet below is one uninterrupted body: its header used to repeat what the
 * tabs already said and cost 30px of body height. Up here the tabs are the same
 * kind of object as the terminal tabs - a pill standing on the canvas, the
 * active one lifted onto a surface - at the same height, so the top row reads as
 * one line of chrome instead of two unrelated control groups.
 *
 * The row slides in from the right on the same curve as the sheet, because the
 * two arrive together. Switching tabs does not animate: it happens constantly.
 */
export function SidePanelTabs({ tab, onSelectTab }: SidePanelTabsProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const tabRefs = useRef(new Map<SidePanelTab, HTMLButtonElement>());

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // A tab list is one tab stop: arrow keys move between tabs.
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    const target = TABS[next];
    if (!target) return;
    event.preventDefault();
    onSelectTab(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <div
      className="side-tabs"
      data-shown={shown ? 'true' : 'false'}
      role="tablist"
      aria-label={t('sidePanel.aria')}
      onKeyDown={onTabKeyDown}
    >
      {TABS.map((id) => {
        const Icon = TAB_ICONS[id];
        const label = t(`sidePanel.${id}`);
        return (
          <button
            key={id}
            id={`side-panel-tab-${id}`}
            ref={(node) => {
              if (node) tabRefs.current.set(id, node);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`side-panel-${id}`}
            aria-label={label}
            data-tip={label}
            tabIndex={tab === id ? 0 : -1}
            className="side-tab"
            data-active={tab === id ? 'true' : undefined}
            onClick={() => onSelectTab(id)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}

export interface SidePanelProps {
  tab: SidePanelTab;
  /** The active tab's body: it owns its own scrolling and footer. */
  children: ReactNode;
}

/**
 * Docked right sheet.
 *
 * It owns the frame only, and the frame is now a single body: the tab row lives
 * in the window's top row (see `SidePanelTabs`) and there is no close button,
 * because the panel toggle in that same row already closes it - closing a thing
 * from a second place 300px away taught nothing.
 *
 * The body mounts on open, so only the first mount slides in.
 */
export function SidePanel({ tab, children }: SidePanelProps) {
  const t = useT();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <aside
      className="info-panel"
      data-shown={shown ? 'true' : 'false'}
      aria-label={t('sidePanel.aria')}
    >
      <div
        className="side-panel-body"
        role="tabpanel"
        id={`side-panel-${tab}`}
        aria-labelledby={`side-panel-tab-${tab}`}
      >
        {children}
      </div>
    </aside>
  );
}
