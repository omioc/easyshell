import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './Overlay';

/**
 * The first hint waits; the next one does not.
 *
 * A tooltip that appears the instant the pointer crosses a button fires on every
 * trip across the toolbar. Once one is open, though, the pointer is already
 * there and moving between neighbours should feel instant, not deliberate.
 */
const OPEN_DELAY = 420;
/** Two hovers closer together than this are one gesture across one toolbar. */
const NEIGHBOUR_WINDOW = 700;
/** Space between the chip and the thing it describes. */
const GAP = 8;
/** Never let the chip touch the window edge. */
const EDGE = 8;

interface Tip {
  text: string;
  kbd: string | null;
  anchor: DOMRect;
}

/**
 * The app's only tooltip: one delegated layer, driven by `data-tip`.
 *
 * Native `title` bubbles are drawn by the OS: an unstyleable yellow-grey box,
 * a one-second delay nobody can tune, and a different look on every platform.
 * They also cannot show a shortcut. Any element can opt in instead:
 *
 *     <button data-tip="Close" data-tip-kbd="Ctrl+W" …>
 *
 * `data-tip` carries the label, `data-tip-kbd` an optional shortcut. Nothing
 * else is needed - the layer is mounted once, at the root of the app.
 *
 * Placement is above the element by default and below when there is no room,
 * horizontally clamped to the window. It grows out of the element it describes
 * (transform-origin at the trigger) and lives 125ms, the range where a hint
 * reads as instant instead of as a small dialog.
 */
export function TooltipLayer() {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const { mounted, shown } = usePresence(open, 100);
  const chip = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    placement: 'top' | 'bottom';
  } | null>(null);

  // Placed before the first paint, so the chip never flashes in a corner.
  useLayoutEffect(() => {
    if (!tip) return;
    const node = chip.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const above = tip.anchor.top - height - GAP >= EDGE;
    const top = above ? tip.anchor.top - height - GAP : tip.anchor.bottom + GAP;
    const centered = tip.anchor.left + tip.anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(EDGE, centered), window.innerWidth - width - EDGE);
    setPos({ left, top, placement: above ? 'top' : 'bottom' });
    // `mounted` is a dependency because the chip does not exist yet on the first
    // pass: there is nothing to measure until the presence hook lets it in.
  }, [tip, mounted]);

  useEffect(() => {
    // Touch-first devices fire hover on tap: a hint there is a lie.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const anchorOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;

    let timer = 0;
    let current: HTMLElement | null = null;
    let lastShownAt = 0;

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setOpen(false);
    };

    const schedule = (element: HTMLElement) => {
      const text = element.getAttribute('data-tip')?.trim();
      if (!text) return;
      current = element;
      const instant = performance.now() - lastShownAt < NEIGHBOUR_WINDOW;
      timer = window.setTimeout(
        () => {
          // The element may have left the DOM while the pointer sat still on it
          // (a closing tab, a list that re-sorted). Nothing to point at.
          if (!element.isConnected) return;
          lastShownAt = performance.now();
          setTip({
            text,
            kbd: element.getAttribute('data-tip-kbd'),
            anchor: element.getBoundingClientRect(),
          });
          setOpen(true);
        },
        instant ? 0 : OPEN_DELAY,
      );
    };

    const onOver = (event: PointerEvent) => {
      const element = anchorOf(event.target);
      if (!element) {
        if (current) hide();
        return;
      }
      // Crossing into a child of the same trigger is not a new trigger.
      if (element === current) return;
      window.clearTimeout(timer);
      setOpen(false);
      schedule(element);
    };

    // Leaving the window has no `pointerover` to follow it.
    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', hide, true);
    // Capture: any scrolled container under the pointer moves the trigger away.
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  if (!mounted || !tip) return null;

  return createPortal(
    <div
      ref={chip}
      className="tooltip"
      role="tooltip"
      data-shown={shown ? 'true' : 'false'}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? undefined : 'hidden',
        transformOrigin: pos?.placement === 'bottom' ? 'center top' : 'center bottom',
      }}
    >
      {tip.text}
      {tip.kbd ? <kbd className="tooltip-kbd">{tip.kbd}</kbd> : null}
    </div>,
    document.body,
  );
}
