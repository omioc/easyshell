import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Drag-to-arrange for the sidebar inventory: the Sessions list and every
 * workspace's host list are one drag surface, so a host can be reordered where
 * it is, dropped into another workspace, or dragged back out to Sessions.
 *
 * A press only becomes a drag after 4px of travel, so every row keeps behaving
 * like the button it is (click selects, double click opens, `…` opens a menu).
 *
 * The row that is being carried is a fixed-position ghost on `document.body`;
 * the real row keeps its slot, which keeps every measurement honest and lets the
 * ghost travel over the other lists instead of being clipped by the scrolling
 * one. The rows around the gap slide on a short transform transition, and the
 * hand-off freezes that transition before the new arrangement is committed, so
 * the list paints once, already in the order it landed in.
 */

/** Travel before a press counts as a drag. Below this, it is still a click. */
const START_THRESHOLD = 4;
/**
 * Wait before handing the new arrangement over. Slightly longer than the 140ms
 * transform transition on `.side-row-wrap`, so the row has already landed when
 * the transforms are cleared and the list re-renders in the same tick.
 */
const SETTLE_MS = 160;
/** List id of the Sessions list. Workspace lists use `ws:<id>`. */
export const SESSIONS_LIST_ID = 'sessions';
const SESSIONS = SESSIONS_LIST_ID;
/** Step used when a list has no rows to measure (empty or collapsed). */
const FALLBACK_STEP = 37;

export interface InventoryWorkspace {
  id: string;
  /** Host keys (`ssh:<profileId>`) in display order. */
  keys: string[];
}

/** Every list, with its rows in order: what the sidebar should render. */
export interface InventoryArrangement {
  sessions: string[];
  workspaces: InventoryWorkspace[];
}

export interface InventoryDragOptions {
  /** Sessions row keys in render order. */
  sessions: string[];
  /** Every workspace, with its host keys in render order. */
  workspaces: InventoryWorkspace[];
  /** Whether a list will take this row: only saved hosts can join a workspace. */
  accepts: (listId: string, key: string) => boolean;
  /**
   * Blocks whose own position can move when the lists around them change size
   * (a workspace growing, the Sessions list shrinking). They are flipped from
   * where they appeared to where they land, so a drop never teleports the rest
   * of the sidebar.
   */
  flipSelector?: string;
  /** Receives the arrangement once a dropped row has landed. */
  onDrop: (next: InventoryArrangement) => void;
}

export interface InventoryDrag {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** DOM id of a workspace's drop list. */
export const listIdOfWorkspace = (workspaceId: string): string => `ws:${workspaceId}`;

const ROW_SELECTOR = '[data-drag-key]';
const LIST_SELECTOR = '[data-drag-list]';
const TARGET_SELECTOR = '[data-drag-target]';

interface RowBox {
  element: HTMLElement;
  key: string;
  listId: string;
  top: number;
  height: number;
  left: number;
  width: number;
}

interface ListBox {
  id: string;
  rect: DOMRect;
  /** Top of the first row: the content box the rows are laid out in. */
  top: number;
  step: number;
  left: number;
}

interface DropTarget {
  listId: string;
  /** Insertion index, counted in the list without the dragged row. */
  index: number;
  /** The drop is on a workspace header (collapsed or empty list). */
  viaHeader: boolean;
}

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  key: string;
  fromList: string;
  rows: RowBox[];
  lists: ListBox[];
  scope: DOMRect;
  target: DropTarget | null;
  /** The slot the row came from: a release with no move puts it back there. */
  at: DropTarget;
  /** Header currently lit as a drop zone. */
  marked: HTMLElement | null;
  /** The carried copy, and the viewport spot it started from. */
  ghost: HTMLElement | null;
  origin: { left: number; top: number };
  /** Blocks that may change position when the lists around them resize. */
  flip: HTMLElement[];
  dragging: boolean;
  settleTimer: number | null;
}

function stepOf(rows: RowBox[]): number {
  const first = rows[0];
  const second = rows[1];
  if (first && second) return second.top - first.top;
  if (first) return first.height + 1;
  return FALLBACK_STEP;
}

export function useInventoryDrag({
  sessions,
  workspaces,
  accepts,
  flipSelector,
  onDrop,
}: InventoryDragOptions): InventoryDrag {
  const stateRef = useRef({ sessions, workspaces });
  stateRef.current = { sessions, workspaces };
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const session = useRef<DragSession | null>(null);
  const listeners = useRef<Array<() => void>>([]);

  const keysOf = useCallback((listId: string): string[] => {
    const current = stateRef.current;
    if (listId === SESSIONS) return current.sessions;
    return current.workspaces.find((item) => listIdOfWorkspace(item.id) === listId)?.keys ?? [];
  }, []);

  /** Every list, with the dragged row taken out and put back at `target`. */
  const project = useCallback((key: string, target: DropTarget | null): InventoryArrangement => {
    const current = stateRef.current;
    const nextSessions = current.sessions.filter((item) => item !== key);
    const nextWorkspaces = current.workspaces.map((item) => ({
      id: item.id,
      keys: item.keys.filter((item) => item !== key),
    }));
    if (!target) return { sessions: nextSessions, workspaces: nextWorkspaces };
    if (target.listId === SESSIONS) {
      nextSessions.splice(Math.min(Math.max(target.index, 0), nextSessions.length), 0, key);
      return { sessions: nextSessions, workspaces: nextWorkspaces };
    }
    const workspace = nextWorkspaces.find((item) => listIdOfWorkspace(item.id) === target.listId);
    workspace?.keys.splice(Math.min(Math.max(target.index, 0), workspace.keys.length), 0, key);
    return { sessions: nextSessions, workspaces: nextWorkspaces };
  }, []);

  const detach = useCallback(() => {
    for (const off of listeners.current) off();
    listeners.current = [];
  }, []);

  const clearSession = useCallback((current: DragSession) => {
    if (current.settleTimer !== null) window.clearTimeout(current.settleTimer);
    if (current.marked) delete current.marked.dataset.drop;
    delete document.body.dataset.rowDragging;
    for (const row of current.rows) {
      delete row.element.dataset.dragging;
      row.element.style.transform = '';
      row.element.style.visibility = '';
    }
    current.ghost?.remove();
  }, []);

  const cancel = useCallback(() => {
    const current = session.current;
    session.current = null;
    detach();
    delete document.body.dataset.rowDragging;
    if (current) clearSession(current);
  }, [clearSession, detach]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || session.current) return;
      const target = event.target as HTMLElement;
      if (target.closest('[data-no-drag]')) return;
      const scope = event.currentTarget;
      const element = target.closest<HTMLElement>(ROW_SELECTOR);
      const key = element?.dataset.dragKey;
      if (!element || !key || !scope.contains(element)) return;
      const fromList = element.closest<HTMLElement>(LIST_SELECTOR)?.dataset.dragList;
      const fromIndex = fromList ? keysOf(fromList).indexOf(key) : -1;
      if (!fromList || fromIndex < 0) return;

      const scopeBox = scope.getBoundingClientRect();
      const rows: RowBox[] = Array.from(scope.querySelectorAll<HTMLElement>(ROW_SELECTOR))
        .filter((node) => Boolean(node.dataset.dragKey))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            element: node,
            key: node.dataset.dragKey ?? '',
            listId: node.closest<HTMLElement>(LIST_SELECTOR)?.dataset.dragList ?? '',
            top: rect.top,
            height: rect.height,
            left: rect.left,
            width: rect.width,
          };
        });

      const lists: ListBox[] = Array.from(scope.querySelectorAll<HTMLElement>(LIST_SELECTOR))
        .map((node) => {
          const id = node.dataset.dragList ?? '';
          const rect = node.getBoundingClientRect();
          const listRows = rows.filter((row) => row.listId === id);
          const first = listRows[0];
          return {
            id,
            rect,
            top: first ? first.top : rect.top,
            step: stepOf(listRows),
            left: first ? first.left : rect.left,
          };
        })
        .filter((list) => list.id.length > 0);

      const geometryOf = (listId: string): { top: number; step: number; left: number } => {
        const list = lists.find((item) => item.id === listId);
        if (list) return { top: list.top, step: list.step, left: list.left };
        // A collapsed workspace has no rows and no list: the header is the proxy.
        const header = scope.querySelector<HTMLElement>(`[data-drag-target="${listId}"]`);
        const rect = header?.getBoundingClientRect();
        return {
          top: rect ? rect.bottom + 1 : scopeBox.top,
          step: FALLBACK_STEP,
          left: rect ? rect.left + 12 : scopeBox.left,
        };
      };

      const current: DragSession = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        key,
        fromList,
        rows,
        lists,
        scope: scopeBox,
        target: null,
        at: { listId: fromList, index: fromIndex, viaHeader: false },
        marked: null,
        ghost: null,
        origin: { left: 0, top: 0 },
        flip: flipSelector ? Array.from(scope.querySelectorAll<HTMLElement>(flipSelector)) : [],
        dragging: false,
        settleTimer: null,
      };
      session.current = current;

      const clearMark = () => {
        if (current.marked) delete current.marked.dataset.drop;
        current.marked = null;
      };

      const resolveTarget = (
        pointerX: number,
        pointerY: number,
        centerY: number,
      ): DropTarget | null => {
        if (pointerX < current.scope.left - 8 || pointerX > current.scope.right + 8) return null;
        const list = current.lists.find(
          (item) => pointerY >= item.rect.top && pointerY <= item.rect.bottom,
        );
        if (list) {
          if (!acceptsRef.current(list.id, key)) return null;
          let index = 0;
          for (const row of current.rows) {
            if (row.listId !== list.id || row.key === key) continue;
            if (row.top + row.height / 2 < centerY) index += 1;
          }
          return { listId: list.id, index, viaHeader: false };
        }
        const headers = Array.from(scope.querySelectorAll<HTMLElement>(TARGET_SELECTOR));
        for (const header of headers) {
          const rect = header.getBoundingClientRect();
          if (pointerY < rect.top || pointerY > rect.bottom) continue;
          const listId = header.dataset.dragTarget ?? '';
          if (!listId || !acceptsRef.current(listId, key)) return null;
          // A header means "into this group, first": the row lands right under
          // the header the pointer is on, not at the far end of the list.
          return { listId, index: 0, viaHeader: true };
        }
        return null;
      };

      /** Slides every other row to the position the drop would give it. */
      const applyRows = (dragged: RowBox, dropTarget: DropTarget | null) => {
        const arrangement = project(key, dropTarget);
        for (const row of current.rows) {
          if (row === dragged) continue;
          const from = keysOf(row.listId);
          const fromIndex = from.indexOf(row.key);
          if (fromIndex < 0) continue;
          const projected =
            row.listId === SESSIONS
              ? arrangement.sessions
              : (arrangement.workspaces.find(
                  (item) => listIdOfWorkspace(item.id) === row.listId,
                )?.keys ?? []);
          const to = projected.indexOf(row.key);
          if (to < 0) continue;
          const delta = to - fromIndex;
          row.element.style.transform =
            delta === 0 ? '' : `translateY(${delta * geometryOf(row.listId).step}px)`;
        }
      };

      /** The carried copy: out of the list, over everything, sized like the row. */
      const lift = (dragged: RowBox) => {
        const rect = dragged.element.getBoundingClientRect();
        const ghost = dragged.element.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('data-drag-key');
        ghost.dataset.dragging = 'true';
        ghost.style.position = 'fixed';
        ghost.style.top = `${rect.top}px`;
        ghost.style.left = `${rect.left}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.margin = '0';
        ghost.style.zIndex = '80';
        ghost.style.pointerEvents = 'none';
        ghost.style.transition = 'none';
        document.body.appendChild(ghost);
        // The row keeps its slot; only its paint goes away.
        dragged.element.style.visibility = 'hidden';
        // A label following a row that is being carried somewhere else would sit
        // on top of the gap it is opening.
        document.body.dataset.rowDragging = 'true';
        current.ghost = ghost;
        current.origin = { left: rect.left, top: rect.top };
      };

      const onMove = (move: PointerEvent) => {
        if (session.current !== current || move.pointerId !== current.pointerId) return;
        const dragged = current.rows.find((row) => row.key === key);
        if (!dragged) return;
        const dy = move.clientY - current.startY;
        if (!current.dragging) {
          if (
            Math.abs(dy) < START_THRESHOLD &&
            Math.abs(move.clientX - current.startX) < START_THRESHOLD
          ) {
            return;
          }
          current.dragging = true;
          lift(dragged);
          // The click that closes this gesture must not also select the row.
          const swallow = (click: MouseEvent) => {
            click.stopPropagation();
            click.preventDefault();
            window.removeEventListener('click', swallow, true);
          };
          window.addEventListener('click', swallow, true);
          listeners.current.push(() => window.removeEventListener('click', swallow, true));
        }

        const centerY = dragged.top + dragged.height / 2 + dy;
        const next = resolveTarget(move.clientX, move.clientY, centerY);
        current.target = next;

        // A header only lights up when the host would actually join it: the gap
        // inside an open list already says where the row lands.
        const header =
          next && next.viaHeader
            ? scope.querySelector<HTMLElement>(`[data-drag-target="${next.listId}"]`)
            : null;
        if (header !== current.marked) {
          clearMark();
          if (header) {
            header.dataset.drop = 'true';
            current.marked = header;
          }
        }

        // Follow the hand at 1:1, and take on the indent of the list it is over
        // so the row previews where it would live.
        const geometry = next ? geometryOf(next.listId) : null;
        const dx =
          current.ghost && geometry && next && next.listId !== current.fromList
            ? geometry.left - current.origin.left
            : 0;
        if (current.ghost) current.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
        applyRows(dragged, next);
      };

      const onUp = (up: PointerEvent) => {
        if (session.current !== current || up.pointerId !== current.pointerId) return;
        const dragged = current.rows.find((row) => row.key === key);
        if (!current.dragging || !dragged) {
          cancel();
          return;
        }
        detach();
        // The header that took the drop keeps its highlight until the row has
        // landed: losing it at pointerup would blink right above the landing.
        // A release can arrive before the last pointermove is delivered, so the
        // drop is resolved from the release point itself.
        current.target = resolveTarget(
          up.clientX,
          up.clientY,
          dragged.top + dragged.height / 2 + (up.clientY - current.startY),
        );

        const arrangement = project(key, current.target);
        const changed =
          JSON.stringify(arrangement.sessions) !== JSON.stringify(stateRef.current.sessions) ||
          JSON.stringify(arrangement.workspaces) !== JSON.stringify(stateRef.current.workspaces);

        const ghost = current.ghost;
        if (!current.target || !changed) {
          // Nothing to commit: the row goes back to where it came from, and the
          // rows that opened the gap close it in step with the carried copy.
          if (ghost) {
            ghost.style.transition = 'transform 140ms var(--ease-out)';
            ghost.style.transform = 'translate(0px, 0px)';
          }
          applyRows(dragged, current.at);
        } else {
          const geometry = geometryOf(current.target.listId);
          const projectedKeys =
            current.target.listId === SESSIONS
              ? arrangement.sessions
              : (arrangement.workspaces.find(
                  (item) => listIdOfWorkspace(item.id) === current.target?.listId,
                )?.keys ?? []);
          const slot = Math.max(projectedKeys.indexOf(key), 0);
          if (ghost) {
            // A collapsed workspace shows no rows: the row is being folded into
            // the group, so it fades as it lands on the header instead of
            // appearing to stop in mid-air.
            const folded = !current.lists.some((list) => list.id === current.target?.listId);
            // The carried copy has the size of the row it came from; a workspace
            // list is narrower and shorter than the Sessions list, so it takes
            // the landing row's box on the way down. Without that the row snaps
            // to a different width at the hand-off.
            const landing = current.rows.find(
              (row) => row.listId === current.target?.listId && row.key !== key,
            );
            const resize =
              landing && !folded
                ? ', width 140ms var(--ease-out), height 140ms var(--ease-out)'
                : '';
            ghost.style.transition = `transform 140ms var(--ease-out), opacity 140ms ease-out${resize}`;
            if (landing && !folded) {
              ghost.style.width = `${landing.width}px`;
              ghost.style.height = `${landing.height}px`;
            }
            if (folded) ghost.style.opacity = '0';
            ghost.style.transform = `translate(${geometry.left - current.origin.left}px, ${
              geometry.top + (folded ? 0 : slot * geometry.step) - current.origin.top
            }px)`;
          }
        }

        current.settleTimer = window.setTimeout(() => {
          current.settleTimer = null;
          if (session.current !== current) return;
          session.current = null;

          // Where the anchors around the lists appear right now: the lists are
          // about to change height, and this is what keeps the rest of the
          // sidebar from teleporting when they do.
          const anchors = current.flip.map((element) => ({
            element,
            top: element.getBoundingClientRect().top,
          }));

          /*
           * Every row is already where the drop puts it: the transforms said so
           * while the gap was open. Freezing the transition before those offsets
           * are cleared is what makes the hand-off invisible. Left running, it
           * animates each row out of the slot it just landed in and drags the
           * list back into the arrangement it came from.
           */
          const frozen = current.rows.map((row) => row.element);
          for (const element of frozen) element.style.transition = 'none';

          clearSession(current);

          /*
           * Reads the style the hand-off just produced, so the transition below
           * comes back to a layout that has already been resolved and has nothing
           * left to animate. A row that did not survive the commit — a host that
           * changed list — is a new element and needs no thawing.
           */
          const thaw = () => {
            const live = frozen.find((element) => element.isConnected);
            if (live) void live.offsetHeight;
            for (const element of frozen) element.style.transition = '';
          };

          if (!current.target || !changed) {
            thaw();
            return;
          }

          // Stay "in flight" until the list has settled: hover and tooltips
          // would otherwise shuffle while the rows slide under the pointer.
          document.body.dataset.rowDragging = 'settling';
          window.setTimeout(() => {
            delete document.body.dataset.rowDragging;
          }, 240);

          // One commit: the rows lose their transforms and the list re-renders in
          // the new order inside the same tick, so the browser paints the drop
          // once, already in place.
          flushSync(() => onDropRef.current(arrangement));
          thaw();

          const moving: HTMLElement[] = [];
          for (const anchor of anchors) {
            const delta = anchor.top - anchor.element.getBoundingClientRect().top;
            if (Math.abs(delta) < 1) continue;
            anchor.element.style.transition = 'none';
            anchor.element.style.transform = `translateY(${delta}px)`;
            moving.push(anchor.element);
          }
          if (moving.length > 0) {
            window.requestAnimationFrame(() => {
              for (const element of moving) {
                element.style.transition = 'transform 180ms var(--ease-out)';
                element.style.transform = '';
              }
              window.setTimeout(() => {
                for (const element of moving) element.style.transition = '';
              }, 240);
            });
          }

          // The row takes over the lift the carried copy had, so the hand-off is
          // one continuous object. Once that has painted, it is released into an
          // ordinary row: the same element, no longer held by the drag.
          const landed = scope.querySelector<HTMLElement>(`[data-drag-key="${CSS.escape(key)}"]`);
          if (landed) {
            landed.dataset.landed = 'true';
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                if (landed.dataset.landed !== 'true') return;
                landed.dataset.landed = 'settle';
                window.setTimeout(() => {
                  if (landed.dataset.landed === 'settle') delete landed.dataset.landed;
                }, 260);
              });
            });
          }
        }, SETTLE_MS);
      };

      const onKeyDown = (keyboard: KeyboardEvent) => {
        if (session.current !== current || keyboard.key !== 'Escape') return;
        // Escape backs out of the drag first, ahead of any panel it would close.
        if (current.dragging) {
          keyboard.preventDefault();
          keyboard.stopPropagation();
        }
        cancel();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('keydown', onKeyDown, true);
      listeners.current.push(
        () => window.removeEventListener('pointermove', onMove),
        () => window.removeEventListener('pointerup', onUp),
        () => window.removeEventListener('pointercancel', onUp),
        () => window.removeEventListener('keydown', onKeyDown, true),
      );
    },
    [cancel, clearSession, detach, flipSelector, keysOf, project],
  );

  // A list that changes shape mid-drag (a host deleted, a distribution found)
  // makes the measurements meaningless: drop the gesture instead of guessing.
  const signature = JSON.stringify({ sessions, workspaces });
  useEffect(() => {
    if (session.current) cancel();
  }, [cancel, signature]);

  useEffect(() => cancel, [cancel]);

  return { onPointerDown };
}
