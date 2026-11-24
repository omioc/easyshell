import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { ColorScheme } from '@shared/themes';
import type { Settings } from '@shared/types';
import { getBridge } from '../bridge';
import { copyText, pastedLineCount } from '../lib/clipboard';

export interface TerminalHandle {
  write: (data: string) => void;
  focus: () => void;
  /**
   * Pastes through the terminal rather than around it: xterm applies the shell's
   * bracketed-paste mode and its own line-ending rules to what it sends.
   */
  paste: (text: string) => void;
}

/**
 * A thumb shorter than this stops reading as a position and starts reading as a
 * dot, which is no use in a buffer holding thousands of lines.
 */
const MIN_THUMB_HEIGHT = 26;

/**
 * True when the caret sits in a field the user is typing in.
 *
 * Activating a pane is not a reason to take the caret away from a rename field,
 * the agent composer or a settings input: the terminal only claims focus when
 * nobody else is holding it. Its own hidden textarea does not count.
 */
function caretInEditableField(): boolean {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  if (element.closest('.xterm')) return false;
  if (element.isContentEditable) return true;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
}

/**
 * Redraws the terminal once the face it asks for has really loaded.
 *
 * Glyphs are rasterised once into the renderer's atlas and reused from there, so a
 * face that arrives late never repaints what came before it: the synthesised bold
 * painted while the 700 face was still decoding stays in the scrollback beside the
 * real one, and a listing reads as two fonts - the odd word a pixel taller than its
 * neighbours. Throwing the atlas away is the only way back to one face.
 */
function redrawWhenFaceLands(
  term: Terminal,
  webgl: WebglAddon | null,
  appearance: { fontFamily: string; fontSize: number },
  lost: () => boolean,
): void {
  const spec = `${appearance.fontSize}px ${appearance.fontFamily}`;
  if (document.fonts.check(spec) && document.fonts.check(`bold ${spec}`)) return;
  void Promise.all([document.fonts.load(spec), document.fonts.load(`bold ${spec}`)])
    .then(() => {
      if (lost()) return;
      webgl?.clearTextureAtlas();
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    })
    .catch(() => undefined);
}

export interface TerminalPaneProps {
  sessionId: string;
  /** Inactive panes stay mounted (display: none) so scrollback and shell state survive. */
  active: boolean;
  settings: Settings;
  scheme: ColorScheme;
  register: (id: string, handle: TerminalHandle | null) => void;
  /** A paste of more than one line: the app asks before it reaches the shell. */
  onPasteRequest: (sessionId: string, text: string) => void;
  onCopyFailed: () => void;
}

export function TerminalPane({
  sessionId,
  active,
  settings,
  scheme,
  register,
  onPasteRequest,
  onCopyFailed,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const syncRef = useRef<() => void>(() => undefined);
  const lastSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const latest = useRef({ settings, scheme, onPasteRequest, onCopyFailed });
  latest.current = { settings, scheme, onPasteRequest, onCopyFailed };

  // Create the terminal exactly once per session id.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bridge = getBridge();
    const appearance = latest.current.settings.appearance;

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      letterSpacing: appearance.letterSpacing,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      theme: latest.current.scheme.terminal,
      scrollback: 8000,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    /*
     * Hide the native scrollbar only now. The fit addon asks the viewport how
     * wide its scrollbar is, and the viewport measures that once while it is
     * being built; hiding the bar any earlier would make the measurement fail
     * and reserve a guessed 15px instead of the real 10px.
     */
    host.dataset.ownScroll = 'true';

    let disposed = false;
    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = addon;
      webglRef.current = addon;
    } catch {
      /* the DOM renderer stays active when WebGL is unavailable */
    }
    // A face that lands after this first paint would otherwise leave its shapes in
    // the scrollback for good.
    redrawWhenFaceLands(term, webgl, appearance, () => disposed);

    termRef.current = term;
    let paintFrame = 0;

    /**
     * Draws the scrollbar from the buffer, not from the DOM.
     *
     * The native bar is a function of `.xterm-scroll-area`'s height and
     * `scrollTop`, both fed by xterm on its own schedule and painted by Chromium
     * from cached scroll metrics. When either is behind, the thumb claims a
     * position the screen does not agree with — a jump to the top after a burst
     * of output, or a thumb hanging short of the bottom — and nothing outside
     * can reliably correct the paint. xterm's own viewport position cannot be
     * out of date: it is what the visible rows are drawn from. So the thumb is
     * placed from `viewportY`, and what it shows is what the screen shows, in
     * the same frame, with no cache in between.
     */
    const paintScrollbar = () => {
      paintFrame = 0;
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (disposed || !track || !thumb) return;
      const buffer = term.buffer.active;
      const trackHeight = track.clientHeight;
      if (trackHeight <= 0 || term.rows <= 0) return;

      const scrollable = buffer.baseY;
      if (scrollable <= 0) {
        track.dataset.idle = 'true';
        track.setAttribute('aria-valuenow', '0');
        track.setAttribute('aria-valuemax', '0');
        return;
      }
      track.dataset.idle = 'false';
      const thumbHeight = Math.max(
        MIN_THUMB_HEIGHT,
        Math.round((trackHeight * term.rows) / buffer.length),
      );
      const travel = Math.max(0, trackHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${Math.round((travel * buffer.viewportY) / scrollable)}px)`;
      track.setAttribute('aria-valuenow', String(buffer.viewportY));
      track.setAttribute('aria-valuemax', String(scrollable));
    };

    /** One paint per frame however many writes land in it. */
    const schedulePaint = () => {
      if (paintFrame !== 0) return;
      paintFrame = requestAnimationFrame(paintScrollbar);
    };

    /**
     * Keeps the hidden scroll region honest.
     *
     * Its `scrollTop` and height still decide what the wheel does: xterm maps a
     * scroll offset back onto a buffer row (`Math.round(scrollTop / rowHeight)`),
     * so an offset left over from a layout that no longer exists turns a wheel
     * nudge into a jump to the top. The numbers here are xterm's own formulas
     * with xterm's own inputs, computed from the fractional heights rather than
     * the rounded integers: off by a fraction of a pixel per row is off by whole
     * rows across a full scrollback, which is exactly the drift that has to be
     * avoided. Land within half a row and the read-back is the row it started
     * on — a scroll of zero lines, which xterm treats as nothing happening.
     *
     * The scroll event this causes is deliberately left alone. Swallowing it
     * looks tidier and is wrong: an event the browser fires after xterm itself
     * wrote a position is the one xterm clears its "ignore the next scroll"
     * flag with. Eat that and the next real wheel is the one that gets ignored.
     */
    const syncScrollRegion = () => {
      const element = term.element;
      const viewport = element?.querySelector<HTMLElement>('.xterm-viewport');
      const area = element?.querySelector<HTMLElement>('.xterm-scroll-area');
      const screen = element?.querySelector<HTMLElement>('.xterm-screen');
      const rows = term.rows;
      if (!viewport || !area || !screen || rows <= 0) return;
      const canvasHeight = screen.getBoundingClientRect().height;
      const viewportHeight = viewport.offsetHeight;
      if (viewportHeight <= 0 || canvasHeight <= 0) return;

      const rowHeight = canvasHeight / rows;
      const buffer = term.buffer.active;
      // `_innerRefresh`: one row per line, plus whatever the canvas does not cover.
      const wantedArea = Math.round(rowHeight * buffer.length) + (viewportHeight - canvasHeight);
      if (Math.abs(area.offsetHeight - wantedArea) > 1) {
        area.style.height = `${wantedArea}px`;
      }
      const scrollable = Math.max(0, area.offsetHeight - viewport.clientHeight);
      const wantedTop = Math.min(scrollable, Math.max(0, Math.round(rowHeight * buffer.viewportY)));
      if (Math.abs(viewport.scrollTop - wantedTop) <= 1) return;
      viewport.scrollTop = wantedTop;
    };

    const syncSize = () => {
      if (disposed) return;
      fit.fit();
      syncScrollRegion();
      schedulePaint();
      const cols = term.cols;
      const rows = term.rows;
      if (cols === lastSize.current.cols && rows === lastSize.current.rows) return;
      lastSize.current = { cols, rows };
      void bridge.resizeSession(sessionId, cols, rows);
    };
    syncRef.current = syncSize;

    const onData = term.onData((data) => {
      void bridge.writeSession(sessionId, data);
    });
    // Everything that can move the buffer or change the track: the bar follows.
    const scrollEvents = [term.onScroll(schedulePaint), term.onRender(schedulePaint)];

    /**
     * Dragging the thumb scrolls the terminal through its public API, so the
     * bar stays a view of the buffer and never becomes a second source of
     * truth. Clicking the track jumps; grabbing the thumb keeps the point you
     * grabbed under the pointer.
     */
    const onTrackPointerDown = (event: PointerEvent) => {
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!track || !thumb || event.button !== 0) return;
      const scrollable = term.buffer.active.baseY;
      if (scrollable <= 0) return;
      event.preventDefault();

      const travel = Math.max(1, track.clientHeight - thumb.offsetHeight);
      const trackTop = track.getBoundingClientRect().top;
      const grabbingThumb = event.target === thumb;
      const offset = grabbingThumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2;
      const move = (target: PointerEvent) => {
        const top = Math.min(travel, Math.max(0, target.clientY - trackTop - offset));
        term.scrollToLine(Math.round((top / travel) * scrollable));
      };
      const release = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', release);
        track.removeEventListener('pointercancel', release);
        delete track.dataset.dragging;
      };
      track.setPointerCapture(event.pointerId);
      track.dataset.dragging = 'true';
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', release);
      track.addEventListener('pointercancel', release);
      move(event);
    };

    // The bar covers the gutter the terminal no longer draws a scrollbar in, so
    // the wheel has to be handed back to the scroll region underneath.
    const onTrackWheel = (event: WheelEvent) => {
      const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
      if (!viewport) return;
      event.preventDefault();
      viewport.scrollTop += event.deltaY;
    };

    const track = trackRef.current;
    track?.addEventListener('pointerdown', onTrackPointerDown);
    track?.addEventListener('wheel', onTrackWheel, { passive: false });

    /**
     * Right-click is the whole clipboard on this pane, the way a terminal is
     * expected to behave: a selection means copy — and clearing it is the only
     * receipt worth showing — while no selection means paste. A paste of more
     * than one line is handed to the app first, because a block of commands
     * landing in a shell is not something to find out afterwards.
     *
     * Captured on the host so xterm's own context-menu handling (and its
     * word-select on macOS) never sees the event.
     */
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const selection = term.getSelection();
      if (selection) {
        void copyText(selection).then((ok) => {
          if (!ok) latest.current.onCopyFailed();
          term.clearSelection();
        });
        return;
      }

      term.focus();
      void bridge
        .readClipboardText()
        .then((text) => {
          if (!text) return;
          if (pastedLineCount(text) > 1) latest.current.onPasteRequest(sessionId, text);
          else term.paste(text);
        })
        .catch(() => undefined);
    };
    host.addEventListener('contextmenu', onContextMenu, true);

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(host);

    const frame = requestAnimationFrame(() => {
      syncSize();
      void bridge
        .attachSession(sessionId)
        .then((snapshot) => {
          if (disposed) return;
          term.write(snapshot.data);
        })
        .catch(() => undefined);
    });

    register(sessionId, {
      write: (data) => term.write(data),
      focus: () => term.focus(),
      paste: (text) => {
        term.focus();
        term.paste(text);
      },
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (paintFrame !== 0) cancelAnimationFrame(paintFrame);
      observer.disconnect();
      host.removeEventListener('contextmenu', onContextMenu, true);
      track?.removeEventListener('pointerdown', onTrackPointerDown);
      track?.removeEventListener('wheel', onTrackWheel);
      delete host.dataset.ownScroll;
      onData.dispose();
      for (const subscription of scrollEvents) subscription.dispose();
      register(sessionId, null);
      termRef.current = null;
      webglRef.current = null;
      syncRef.current = () => undefined;
      lastSize.current = { cols: 0, rows: 0 };
      term.dispose();
    };
  }, [sessionId, register]);

  // Settings can change while the session runs: re-apply metrics and palette.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const appearance = settings.appearance;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.lineHeight = appearance.lineHeight;
    term.options.letterSpacing = appearance.letterSpacing;
    term.options.cursorStyle = appearance.cursorStyle;
    term.options.cursorBlink = appearance.cursorBlink;
    term.options.theme = scheme.terminal;
    // A face the user just picked has to be decoded before it can be drawn; until
    // then every cell keeps a shape from the previous one.
    redrawWhenFaceLands(term, webglRef.current, appearance, () => termRef.current !== term);
    const frame = requestAnimationFrame(() => syncRef.current());
    return () => cancelAnimationFrame(frame);
  }, [settings.appearance, scheme]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      syncRef.current();
      if (caretInEditableField()) return;
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="terminal-host" ref={hostRef}>
      {/*
        Inside the host so it inherits the pane's insets, and inside the gutter
        the fit addon already reserves for a scrollbar. Kept out of the tab order:
        the terminal's own keys and wheel are the way to scroll, this is the view
        of where you are.
      */}
      <div
        className="term-scroll"
        ref={trackRef}
        role="scrollbar"
        aria-orientation="vertical"
        aria-valuemin={0}
        data-idle="true"
      >
        <div className="term-scroll-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}
