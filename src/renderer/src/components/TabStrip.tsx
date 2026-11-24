import { useEffect, useRef } from 'react';
import type { SessionInfo } from '@shared/types';
import { useT } from '../i18n';
import { IconChevronDown, IconClose, IconEllipsis, IconPlus } from './Icons';
import type { PopoverAnchor } from './Overlay';
import { RenameField } from './RenameField';

export interface TabStripProps {
  sessions: SessionInfo[];
  activeId: string | null;
  renamingId: string | null;
  /** True while the `▾` popover is open, for `aria-expanded`. */
  menuOpen: boolean;
  /** Fast path: opens the default local shell without a menu. */
  onNewTab: () => void;
  onActivate: (id: string) => void;
  onOpenMenu: (id: string, anchor: PopoverAnchor) => void;
  onOpenNewMenu: (anchor: PopoverAnchor) => void;
  onBeginRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onClose: (id: string) => void;
}

function anchorBelow(element: HTMLElement): PopoverAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left - 6, y: rect.bottom + 6, origin: 'top left' };
}

export function TabStrip({
  sessions,
  activeId,
  renamingId,
  menuOpen,
  onNewTab,
  onActivate,
  onOpenMenu,
  onOpenNewMenu,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onClose,
}: TabStripProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab visible: with many tabs open, a new session would
  // otherwise land outside the strip and look like nothing happened. Opening the
  // side sheet narrows the strip (its own tab row owns that column), so a
  // shrink is the other way the front tab can slide out of view.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const reveal = () => {
      const active = scroller.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!active) return;
      const box = scroller.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      if (tab.left < box.left) scroller.scrollLeft -= box.left - tab.left;
      else if (tab.right > box.right) scroller.scrollLeft += tab.right - box.right;
    };
    reveal();
    // Growing never hides the front tab, and it must not yank the strip back
    // while the user is reading one further down the list.
    let width = scroller.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = scroller.clientWidth;
      if (next < width) reveal();
      width = next;
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [activeId, sessions.length]);

  // A mouse wheel over the strip scrolls the tabs sideways: the strip has no
  // vertical extent, so a vertical wheel has nowhere else to go. Registered as a
  // native non-passive listener because React's onWheel cannot preventDefault.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const rawStep = event.deltaMode === 1 ? event.deltaY * 24 : event.deltaY;
      const step = Math.max(-180, Math.min(180, rawStep));
      if (step === 0) return;
      event.preventDefault();
      scroller.scrollLeft += step;
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="tabstrip">
      <div className="tabstrip-scroll" role="tablist" aria-label={t('tabs.sessions')} ref={scrollRef}>
        {sessions.map((session, index) => {
          const active = session.id === activeId;
          const renaming = session.id === renamingId;
          return (
            <div
              key={session.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="tab"
              data-active={active ? 'true' : undefined}
              data-status={session.status}
              onClick={() => onActivate(session.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onActivate(session.id);
                onOpenMenu(session.id, { x: event.clientX, y: event.clientY, origin: 'top left' });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onActivate(session.id);
                }
              }}
              onDoubleClick={() => onBeginRename(session.id)}
              data-tip={session.title}
            >
              {/* The tab's position, not its identity: closing any tab renumbers
                  the rest from 1 again, and the agent composer refers to a tab
                  by this number. */}
              <span className="tab-index tnum">{index + 1}</span>
              <span className="tab-dot" data-status={session.status} aria-hidden="true" />
              {renaming ? (
                <RenameField
                  value={session.title}
                  className="tab-rename"
                  onCommit={(value) => onCommitRename(session.id, value)}
                  onCancel={onCancelRename}
                />
              ) : (
                <span className="tab-title">{session.title}</span>
              )}
              <span className="tab-actions">
                <button
                  type="button"
                  className="tab-action"
                  aria-label={t('tab.menu.more')}
                  data-tip={t('tab.menu.more')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onActivate(session.id);
                    onOpenMenu(session.id, anchorBelow(event.currentTarget));
                  }}
                >
                  <IconEllipsis size={14} />
                </button>
                <button
                  type="button"
                  className="tab-action tab-action-close"
                  aria-label={t('tab.menu.close')}
                  data-tip={t('tab.menu.close')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(session.id);
                  }}
                >
                  <IconClose size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {/* New session sits right after the last tab, so it moves as tabs come and go. */}
      <div className="tab-rail" data-testid="rail">
        <button
          type="button"
          className="rail-button"
          data-testid="new-tab"
          aria-label={t('tabs.new')}
          data-tip={t('tabs.new')}
          onClick={onNewTab}
        >
          <IconPlus size={15} />
        </button>
        <button
          type="button"
          className="rail-button rail-button-menu"
          data-testid="new-tab-menu"
          aria-label={t('tabs.newMenu')}
          data-tip={t('tabs.newMenu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => onOpenNewMenu(anchorBelow(event.currentTarget))}
        >
          <IconChevronDown size={12} />
        </button>
      </div>

      {/* Empty room to the right of the rail: still a window drag handle. */}
      <div className="tabstrip-drag" aria-hidden="true" />
    </div>
  );
}