import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronRight } from './Icons';

/**
 * Mount/visible pair for CSS enter+exit transitions. The node stays mounted for
 * `exitMs` after `open` turns false so the exit can play, and `shown` only flips
 * after a frame so the browser sees a real transition instead of a jump.
 */
export function usePresence(open: boolean, exitMs = 120): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted, shown };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  /** Stable hook for UI tests (`connection-manager`, ...). */
  testId?: string;
  children: ReactNode;
}

/** Centered dialog with a focus trap and focus restoration. Escape is owned by
 * App so a single handler can decide which layer closes. */
export function Modal({ open, onClose, labelledBy, className, testId, children }: ModalProps) {
  const { mounted, shown } = usePresence(open, 130);
  const surface = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!mounted) return;
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreTo.current?.focus();
  }, [mounted]);

  useEffect(() => {
    if (!shown || !surface.current) return;
    const preferred = surface.current.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? surface.current).focus();
  }, [shown]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !surface.current) return;
    const nodes = focusables(surface.current);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="scrim" data-shown={shown ? 'true' : 'false'} onPointerDown={onClose}>
      <div
        ref={surface}
        className={`modal ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-shown={shown ? 'true' : 'false'}
        data-testid={testId}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface PopoverAnchor {
  x: number;
  y: number;
  /** CSS transform-origin so the menu grows out of its trigger. */
  origin: string;
}

export interface PopoverProps {
  open: boolean;
  anchor: PopoverAnchor | null;
  onClose: () => void;
  label: string;
  className?: string;
  /** Pointer downs inside a nested layer matching this selector keep the menu open. */
  keepOpenWithin?: string;
  /**
   * What the surface is. A menu of actions by default; a `listbox` when it is a
   * dropdown of choices, which is also what decides how the items are walked:
   * a menu starts on its first item, a listbox starts on the selected one.
   */
  role?: 'menu' | 'listbox';
  children: ReactNode;
}

/** The elements arrow keys move between, per surface kind. */
function itemsOf(root: HTMLElement, role: 'menu' | 'listbox'): HTMLElement[] {
  const selector =
    role === 'listbox' ? '[role="option"]:not([aria-disabled="true"])' : '[role="menuitem"]:not([disabled])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/** Anchored menu surface: clamps into the viewport, closes on outside pointer
 * down, and supports arrow-key navigation between items. */
export function Popover({
  open,
  anchor,
  onClose,
  label,
  className,
  keepOpenWithin,
  role = 'menu',
  children,
}: PopoverProps) {
  const { mounted, shown } = usePresence(open, 110);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const focused = useRef(false);

  useLayoutEffect(() => {
    if (!mounted || !anchor) return;
    const node = ref.current;
    const width = node?.offsetWidth ?? 220;
    const height = node?.offsetHeight ?? 180;
    const margin = 8;
    const left = Math.min(Math.max(margin, anchor.x), window.innerWidth - width - margin);
    const top = Math.min(Math.max(margin, anchor.y), window.innerHeight - height - margin);
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [mounted, anchor, children]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      if (
        keepOpenWithin &&
        event.target instanceof Element &&
        event.target.closest(keepOpenWithin)
      ) {
        return;
      }
      onClose();
    };
    const onWindowChange = () => onClose();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onWindowChange);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onWindowChange);
    };
  }, [open, onClose]);

  // Focus the item the surface should start on once it is placed and visible;
  // focusing a `visibility: hidden` element is a no-op, so this waits for `pos`.
  // A menu starts at its first item, a listbox at the chosen one: reopening a
  // dropdown with the pointer already on the trigger should land on "what is
  // this set to", not on the top of the list.
  useEffect(() => {
    if (!shown) {
      focused.current = false;
      return;
    }
    if (!pos || focused.current || !ref.current) return;
    const items = itemsOf(ref.current, role);
    const target =
      role === 'listbox'
        ? (items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0])
        : items[0];
    if (!target) return;
    target.focus();
    focused.current = true;
  }, [shown, pos, role]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const items = itemsOf(ref.current, role);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = items[(index + step + items.length) % items.length];
      next?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    }
  };

  if (!mounted || !anchor) return null;

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className ?? ''}`}
      role={role}
      aria-label={label}
      data-shown={shown ? 'true' : 'false'}
      style={{
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y,
        transformOrigin: anchor.origin,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps {
  onSelect: (element: HTMLElement) => void;
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /** Trailing chevron: this item opens a nested list instead of acting at once. */
  chevron?: boolean;
  /** Pointer enters or the item takes focus — used to open a nested list. */
  onHover?: (element: HTMLElement) => void;
}

export function MenuItem({
  onSelect,
  children,
  icon,
  danger,
  disabled,
  shortcut,
  chevron,
  onHover,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      data-tone={danger ? 'danger' : undefined}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      onMouseEnter={onHover ? (event) => onHover(event.currentTarget) : undefined}
      onFocus={onHover ? (event) => onHover(event.currentTarget) : undefined}
    >
      {icon ? <span className="menu-item-icon">{icon}</span> : null}
      <span className="menu-item-label">{children}</span>
      {shortcut ? <span className="menu-item-shortcut">{shortcut}</span> : null}
      {chevron ? (
        <span className="menu-item-chevron" aria-hidden="true">
          <IconChevronRight size={13} />
        </span>
      ) : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

export interface MenuSectionProps {
  children: ReactNode;
}

/** Small uppercase group label inside a menu. Not a menuitem: skipped by the
 * arrow-key cycle and by `getByRole('menuitem')` assertions. */
export function MenuSection({ children }: MenuSectionProps) {
  return (
    <div className="menu-section" aria-hidden="true">
      {children}
    </div>
  );
}

export interface MenuFlyoutProps {
  /** Viewport point the flyout grows from: the right edge of the parent item. */
  anchor: { x: number; y: number } | null;
  label: string;
  children: ReactNode;
}

/**
 * Secondary menu opened from a `chevron` item. It appears to the right of that
 * item, stays inside the viewport, scrolls when the list is long, and marks
 * itself as a nested layer so the parent menu treats clicks inside it as
 * "inside" rather than as an outside click.
 */
export function MenuFlyout({ anchor, label, children }: MenuFlyoutProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const node = ref.current;
    const width = node?.offsetWidth ?? 200;
    const height = node?.offsetHeight ?? 180;
    const margin = 8;
    const left = Math.min(Math.max(margin, anchor.x), window.innerWidth - width - margin);
    const top = Math.min(Math.max(margin, anchor.y), window.innerHeight - height - margin);
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [anchor, children]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={ref}
      className="popover menu-flyout"
      data-menu-layer="submenu"
      role="menu"
      aria-label={label}
      style={{
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuRowProps {
  onSelect: () => void;
  icon?: ReactNode;
  /** Primary label; truncates before it ever wraps. */
  title: ReactNode;
  /** Muted second line: the target, the command, the state. */
  subtitle?: ReactNode;
  /** Leading status dot next to the title. */
  status?: 'idle' | 'connected' | 'error';
  testId?: string;
  data?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Two-line menu entry for a saved connection or a local shell. Still a real
 * `<button role="menuitem">`, so keyboard navigation and the existing menu
 * tests keep working unchanged.
 */
export function MenuRow({
  onSelect,
  icon,
  title,
  subtitle,
  status,
  testId,
  data,
  disabled,
}: MenuRowProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-row"
      disabled={disabled}
      data-testid={testId}
      {...data}
      onClick={onSelect}
    >
      {icon ? <span className="menu-row-icon">{icon}</span> : null}
      <span className="menu-row-text">
        <span className="menu-row-title">
          {status ? <span className="menu-row-dot" data-status={status} aria-hidden="true" /> : null}
          {title}
        </span>
        {subtitle ? <span className="menu-row-subtitle">{subtitle}</span> : null}
      </span>
    </button>
  );
}