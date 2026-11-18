import type {
  IBufferRange,
  IDisposable,
  ILink,
  ILinkHandler,
  ILinkProvider,
  ITheme,
} from '@xterm/xterm';
import type { ILink as GhosttyLink, ILinkProvider as GhosttyLinkProvider } from 'ghostty-web';

import {
  DecorationLayer,
  type LayerDecoration,
  translucent,
} from '@renderer/lib/terminal/ghostty/decorations';
import { EscapeTap, type TapEvent } from '@renderer/lib/terminal/ghostty/escape-tap';
import {
  encodeMouse,
  encodeWheel,
  type MouseButton,
  type MouseMode,
  reports,
  WheelAccumulator,
} from '@renderer/lib/terminal/ghostty/mouse-report';
import {
  GhosttySearch,
  type SearchDecorations,
  type SearchMatch,
} from '@renderer/lib/terminal/ghostty/search';

/**
 * A Ghostty engine terminal (ghostty-web 0.4.0) behind the part of xterm.js's
 * `Terminal` API the app uses, so the pool and everything it hands a terminal
 * to (the view, Inputs, find, links, frame holds and snapshots) work unchanged.
 *
 * ghostty-web aims at the xterm API but differs where the app depends on it,
 * and each difference is bridged here:
 *  - no parser hooks: our OSC 6790 / 6791 marks and the DECSET watch are cut
 *    out of the stream by `EscapeTap` and run where xterm would run them;
 *  - `buffer.baseY` / `viewportY` are always 0 there: rebuilt from the
 *    scrollback length (and its viewport counts lines up from the bottom);
 *  - `onRender` never fires and DECSET 2026 (synchronized output) never holds
 *    a frame: its renderer is wrapped to do both;
 *  - no markers, no decorations (a `DecorationLayer` over the canvas draws
 *    them), no mouse reports (clicks, drags and the wheel are encoded here),
 *    no `lineHeight` (its font measuring is wrapped), a wheel that ignores the
 *    scroll speed, a key handler whose `true` means "handled", `open()` that
 *    takes over the element it is given and focuses it, writes and resizes
 *    that throw before `open()`, a theme fixed at creation;
 *  - every write scrolled a reader in the scrollback back to the bottom;
 *  - scrollback rows say nothing about soft wraps: a row filled to its last
 *    column is read as continuing onto the next (a guess - a line exactly
 *    as wide as the terminal reads as joined to the one after it).
 *
 * It reaches into ghostty-web's internals (`wasmTerm`, `renderer`,
 * `linkDetector`, `selectionManager`) - the version is pinned exactly in
 * package.json for that. Not bridged: markers following a reflow on resize.
 */

// --- the parts of ghostty-web used here ------------------------------------------

type InnerCell = { getChars(): string; getWidth(): number; getCode?(): number };
export type InnerLine = {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(x: number): InnerCell | undefined;
  translateToString(trimRight?: boolean, start?: number, end?: number): string;
};
export type InnerBuffer = {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(y: number): InnerLine | undefined;
  getNullCell(): InnerCell;
};
export type InnerWasm = {
  write(data: string): void;
  getMode(mode: number, ansi: boolean): boolean;
  isAlternateScreen(): boolean;
  hasMouseTracking(): boolean;
  getScrollbackLength(): number;
  isDirty(): boolean;
  hasResponse(): boolean;
  readResponse(): string | null;
};
type InnerRenderer = {
  render(
    buffer: InnerWasm,
    force?: boolean,
    viewportY?: number,
    term?: unknown,
    opacity?: number,
  ): void;
  getMetrics(): { width: number; height: number };
  measureFont?(): FontMetrics;
  remeasureFont?(): void;
};
type FontMetrics = { width: number; height: number; baseline: number };
export type InnerOptions = {
  cols: number;
  rows: number;
  cursorBlink: boolean;
  theme: ITheme;
  scrollback: number;
  fontSize: number;
  fontFamily: string;
  smoothScrollDuration: number;
};
/** A ghostty-web `Terminal`, as this adapter uses it (internals included). */
export type GhosttyInner = {
  readonly cols: number;
  readonly rows: number;
  viewportY: number;
  options: {
    fontFamily: string;
    fontSize: number;
    smoothScrollDuration: number;
    cursorBlink: boolean;
  };
  buffer: { active: InnerBuffer; normal: InnerBuffer; alternate: InnerBuffer };
  wasmTerm: InnerWasm;
  renderer: InnerRenderer;
  canvas?: HTMLCanvasElement;
  linkDetector?: { providers: GhosttyLinkProvider[]; invalidateCache(): void };
  selectionManager?: { isSelecting: boolean; copyToClipboard?(text: string): Promise<void> };
  /** Resizes the canvas to the renderer's (re-measured) cell size and redraws. */
  handleFontChange?(): void;
  smoothScrollTo?(viewportY: number): void;
  open(parent: HTMLElement): void;
  dispose(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  paste(text: string): void;
  onData(listener: (data: string) => void): IDisposable;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
  registerLinkProvider(provider: GhosttyLinkProvider): void;
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  select(column: number, row: number, length: number): void;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
  scrollLines(amount: number): void;
  processTerminalResponses(): void;
};
export type InnerFactory = (options: InnerOptions) => GhosttyInner;

// --- small pieces ------------------------------------------------------------------

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): IDisposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

let markerIds = 0;

/** xterm's `IMarker`: a buffer line that moves with the content above it. */
class Marker implements IDisposable {
  readonly id = ++markerIds;
  isDisposed = false;
  private readonly disposed = new Emitter<void>();
  readonly onDispose = this.disposed.event;
  constructor(public line: number) {}
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.line = -1;
    this.disposed.fire();
    this.disposed.dispose();
  }
}

/** Raw stream kept per terminal, replayed when the engine is rebuilt (a theme change). */
const RING_MAX_CHARS = 512 * 1024;
/** Ghostty's scrollback limit is in bytes; about this much per row of a typical width. */
const SCROLLBACK_BYTES_PER_LINE = 1024;
/** A synchronized-output hold lapses after this, as xterm's does. */
const HOLD_SAFETY_MS = 1000;
/** Modes carried across a rebuild when the replayed tail no longer sets them. */
const CARRIED_MODES = [1, 25, 1000, 1002, 1003, 1004, 1006, 2004];
/** Responses drained per write - the engine queues one per query answered. */
const MAX_RESPONSES = 64;
/** Find counts again this long after output stops, as xterm's addon does. */
const SEARCH_REFRESH_MS = 200;
/** The engine's wheel step for a delta it cannot read as pixels, lines or pages. */
const WHEEL_PIXELS_PER_LINE = 33;
/** Find's fills over the text: every match, then the current one. */
const MATCH_ALPHA = 0.25;
const ACTIVE_MATCH_ALPHA = 0.45;

/**
 * A row's text as find reads it, and the cell each UTF-16 unit of it came
 * from: the engine's text skips a wide character's second cell and every
 * never-written cell, so text positions are not columns.
 */
function rowText(line: InnerLine | undefined): { text: string; cells: number[] } {
  if (!line) return { text: '', cells: [] };
  let text = '';
  const cells: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const chars = line.getCell(x)?.getChars() ?? '';
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push(x);
  }
  return { text: text.trimEnd(), cells };
}

/** Whether a row's last column holds text - a scrollback row that continues onto the next. */
function fillsRow(line: InnerLine | undefined): boolean {
  if (!line || line.length === 0) return false;
  const last = line.getCell(line.length - 1);
  if (!last) return false;
  // The right half of a wide character ends the row too.
  if (last.getWidth() === 0) return (line.getCell(line.length - 2)?.getWidth() ?? 0) === 2;
  const chars = last.getChars();
  return chars !== '' && chars !== ' ';
}

export type GhosttyXtermOptions = {
  cols?: number;
  rows?: number;
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  scrollSensitivity: number;
  smoothScrollDuration: number;
  cursorBlink?: boolean;
};

type MutableOptions = GhosttyXtermOptions & { linkHandler?: ILinkHandler | null };

type OscHandler = (data: string) => boolean | Promise<boolean>;
type CsiHandler = {
  prefix: string;
  final: string;
  run: (params: (number | number[])[]) => boolean | Promise<boolean>;
};

function sameTheme(a: ITheme | undefined, b: ITheme | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/** An xterm range (1-based, end inclusive) as Ghostty's (0-based, end inclusive). */
export function toGhosttyRange(range: IBufferRange): IBufferRange {
  return {
    start: { x: range.start.x - 1, y: range.start.y - 1 },
    end: { x: range.end.x - 1, y: range.end.y - 1 },
  };
}

/** A Ghostty range as xterm's. */
export function toXtermRange(range: IBufferRange): IBufferRange {
  return {
    start: { x: range.start.x + 1, y: range.start.y + 1 },
    end: { x: range.end.x + 1, y: range.end.y + 1 },
  };
}

// --- the adapter ---------------------------------------------------------------------

export class GhosttyXterm {
  /** The element `open()` put in the container - moved between panes like xterm's. */
  element: HTMLElement | undefined;
  readonly options: MutableOptions;
  readonly parser = {
    registerOscHandler: (id: number, run: OscHandler): IDisposable => {
      const list = this.oscHandlers.get(id) ?? [];
      list.push(run);
      this.oscHandlers.set(id, list);
      return { dispose: () => list.splice(list.indexOf(run) >>> 0, 1) };
    },
    registerCsiHandler: (
      id: { prefix?: string; intermediates?: string; final: string },
      run: CsiHandler['run'],
    ): IDisposable => {
      // Sequences with intermediates are never reported (see EscapeTap).
      if (id.intermediates) return { dispose: () => {} };
      const handler: CsiHandler = { prefix: id.prefix ?? '', final: id.final, run };
      this.csiHandlers.push(handler);
      return { dispose: () => this.csiHandlers.splice(this.csiHandlers.indexOf(handler) >>> 0, 1) };
    },
  };
  readonly search: GhosttySearch;
  readonly fitAddon: GhosttyFit;

  private inner: GhosttyInner | null = null;
  private screen: HTMLElement | null = null;
  private cols_: number;
  private rows_: number;
  private readonly opts: MutableOptions;
  private readonly tap: EscapeTap;
  private readonly oscHandlers = new Map<number, OscHandler[]>();
  private readonly csiHandlers: CsiHandler[] = [];
  private readonly markers = new Set<Marker>();
  private readonly pending: { text: string; done?: () => void }[] = [];
  private readonly linkProviders = new Map<ILinkProvider, GhosttyLinkProvider>();
  private readonly addons: { dispose(): void }[] = [];
  private readonly decoder = new TextDecoder();
  private readonly wheel = new WheelAccumulator();
  private decorations: DecorationLayer | null = null;
  private matchDecorations: LayerDecoration[] = [];
  private searchRefresh: ReturnType<typeof setTimeout> | null = null;
  /** The button of a press reported to the program, until its release. */
  private pressed: MouseButton | null = null;
  /** The press that is being reported - its selection is cancelled. */
  private reportingPress = false;
  private lastMoveCell = '';
  private lastViewportY = 0;
  private readonly unlisten: (() => void)[] = [];
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  private ring: string[] = [];
  private ringSize = 0;
  private lastMouse: MouseEvent | null = null;
  private forceRender = false;
  private needsFull = false;
  private holdSince: number | null = null;
  private writeParsedQueued = false;
  private disposed = false;

  private readonly dataEmitter = new Emitter<string>();
  private readonly resizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private readonly renderEmitter = new Emitter<{ start: number; end: number }>();
  private readonly writeParsedEmitter = new Emitter<void>();
  readonly onData = this.dataEmitter.event;
  readonly onResize = this.resizeEmitter.event;
  readonly onRender = this.renderEmitter.event;
  readonly onWriteParsed = this.writeParsedEmitter.event;

  constructor(
    options: GhosttyXtermOptions,
    private readonly factory: InnerFactory,
  ) {
    this.cols_ = options.cols ?? 80;
    this.rows_ = options.rows ?? 24;
    this.opts = { cursorBlink: true, ...options, linkHandler: null };
    this.options = new Proxy(this.opts, {
      set: (target, key, value) => {
        const k = key as keyof MutableOptions;
        const old = target[k];
        (target as Record<string, unknown>)[k] = value;
        if (old !== value) this.applyOption(k, value, old);
        return true;
      },
    });
    this.tap = new EscapeTap({
      osc: (id) => (this.oscHandlers.get(id)?.length ?? 0) > 0,
      csi: (prefix, final) =>
        this.csiHandlers.some((h) => h.prefix === prefix && h.final === final),
    });
    this.search = new GhosttySearch({
      rows: () => this.bufferRows(),
      reveal: (match) => this.revealMatch(match),
      clearSelection: () => this.inner?.clearSelection(),
      highlight: (matches, current, decorations) =>
        this.highlightMatches(matches, current, decorations),
      clearHighlights: () => this.clearMatchDecorations(),
    });
    this.fitAddon = new GhosttyFit(this);
  }

  get cols(): number {
    return this.cols_;
  }

  get rows(): number {
    return this.rows_;
  }

  /** The engine's cell size in CSS pixels, once open. */
  cellSize(): { width: number; height: number } | null {
    const m = this.inner?.renderer.getMetrics();
    return m && m.width > 0 && m.height > 0 ? m : null;
  }

  // --- lifecycle --------------------------------------------------------------------

  open(parent: HTMLElement): void {
    if (this.disposed) throw new Error('Terminal has been disposed');
    if (this.element) {
      parent.appendChild(this.element);
      return;
    }
    const wrapper = document.createElement('div');
    // `xterm` keeps the app's selectors working (the focus checks look for
    // `.closest('.xterm')`); the engine draws inside `.xterm-screen`.
    wrapper.className = 'xterm ghostty-terminal';
    wrapper.addEventListener('mousemove', (e) => (this.lastMouse = e), { passive: true });
    parent.appendChild(wrapper);
    this.element = wrapper;
    this.decorations = new DecorationLayer(wrapper, {
      viewTop: (scope) => this.viewTop(scope),
      grid: () => ({ cols: this.cols_, rows: this.rows_ }),
      cellSize: () => this.cellSize(),
      origin: () => this.gridOrigin(),
    });
    this.listenToMouse(wrapper);
    this.build(false);
    const queued = this.pending.splice(0);
    for (const { text, done } of queued) {
      this.writeText(text);
      if (done) queueMicrotask(done);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const addon of this.addons.splice(0)) addon.dispose();
    for (const marker of [...this.markers]) marker.dispose();
    for (const off of this.unlisten.splice(0)) off();
    if (this.searchRefresh) clearTimeout(this.searchRefresh);
    this.search.dispose();
    this.decorations?.dispose();
    this.decorations = null;
    this.inner?.dispose();
    this.inner = null;
    this.element?.remove();
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.renderEmitter.dispose();
    this.writeParsedEmitter.dispose();
  }

  /** Make the engine terminal inside the wrapper (again, after a rebuild). */
  private build(keepFocus: boolean): void {
    const wrapper = this.element;
    if (!wrapper) return;
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    wrapper.appendChild(screen);
    this.screen = screen;
    // Capture on the screen: below the pool's listeners on the wrapper (the
    // Windows image paste goes first), above both of the engine's own.
    screen.addEventListener('paste', (event) => this.handlePaste(event), { capture: true });
    const inner = this.factory({
      cols: this.cols_,
      rows: this.rows_,
      cursorBlink: this.opts.cursorBlink ?? true,
      theme: this.opts.theme,
      scrollback: Math.max(1, this.opts.scrollback) * SCROLLBACK_BYTES_PER_LINE,
      fontSize: this.opts.fontSize,
      fontFamily: this.opts.fontFamily,
      smoothScrollDuration: this.opts.smoothScrollDuration,
    });
    this.inner = inner;
    inner.attachCustomKeyEventHandler((event) => this.handleKey(event));
    inner.attachCustomWheelEventHandler((event) => this.handleWheel(event));
    inner.onData((data) => this.dataEmitter.fire(data));
    // open() focuses the terminal (and again on a timer); xterm never does -
    // a terminal opening in a background tab must not take the keyboard.
    const before = document.activeElement as HTMLElement | null;
    inner.open(screen);
    if (!keepFocus) {
      const giveBack = (): void => {
        if (!screen.contains(document.activeElement)) return;
        if (before && before !== document.body && before.isConnected && !screen.contains(before)) {
          before.focus();
        } else (document.activeElement as HTMLElement | null)?.blur();
      };
      giveBack();
      setTimeout(giveBack, 0);
    }
    // xterm.css positions `.xterm-screen canvas` absolutely (its own layers);
    // in flow here, so the screen box is the grid's size.
    if (inner.canvas) inner.canvas.style.position = 'static';
    this.wrapRenderer(inner);
    this.keepClipboard(inner);
    this.applyLineHeight(inner);
    this.installLinkProviders(inner);
  }

  /**
   * The engine copies every selection (and every double-clicked word) to the
   * clipboard as the mouse comes up; xterm copies only on the copy key, which
   * `handleKey` (and the pool's clipboard keys) do by hand. Selecting text to
   * read it must not throw away what the user copied.
   */
  private keepClipboard(inner: GhosttyInner): void {
    const selection = inner.selectionManager;
    if (selection?.copyToClipboard) selection.copyToClipboard = async () => {};
  }

  /**
   * The engine has no line height: its rows are the font's measured height.
   * Its measuring is wrapped to make rows `lineHeight` times taller with the
   * text centred in them, as xterm does, then the canvas is resized to it.
   */
  private applyLineHeight(inner: GhosttyInner): void {
    const renderer = inner.renderer;
    if (!renderer.measureFont || !renderer.remeasureFont) return;
    const measure = renderer.measureFont.bind(renderer) as () => FontMetrics;
    renderer.measureFont = () => {
      const m = measure();
      const factor = Number.isFinite(this.opts.lineHeight) ? Math.max(1, this.opts.lineHeight) : 1;
      const height = Math.max(m.height, Math.floor(m.height * factor));
      return { ...m, height, baseline: m.baseline + Math.floor((height - m.height) / 2) };
    };
    this.remeasure(inner);
  }

  private remeasure(inner: GhosttyInner): void {
    inner.renderer.remeasureFont?.();
    inner.handleFontChange?.();
    this.decorations?.layout();
  }

  /**
   * Replace the engine terminal with a fresh one and replay the stream it was
   * fed: the engine resolves colours as text is written, so a theme change
   * reaches existing text only through a new terminal. The marks in the
   * replay run no handlers, and answers to queries in it go nowhere.
   */
  private rebuild(): void {
    const old = this.inner;
    if (!old || !this.screen) return;
    const oldWasm = old.wasmTerm;
    const linesBefore = oldWasm.getScrollbackLength() + this.rows_;
    const alt = oldWasm.isAlternateScreen();
    const modes = new Map(CARRIED_MODES.map((m) => [m, oldWasm.getMode(m, false)]));
    const hadFocus = this.screen.contains(document.activeElement);
    old.dispose();
    this.screen.remove();
    this.build(hadFocus);
    const inner = this.inner as GhosttyInner | null;
    if (!inner) return;
    const wasm = inner.wasmTerm;
    const tail = this.ring.join('');
    if (alt && !tail.includes('\x1b[?1049h')) wasm.write('\x1b[?1049h');
    wasm.write(tail);
    for (const [mode, on] of modes) {
      if (wasm.getMode(mode, false) !== on) wasm.write(`\x1b[?${mode}${on ? 'h' : 'l'}`);
    }
    for (let i = 0; i < MAX_RESPONSES && wasm.hasResponse(); i++) wasm.readResponse();
    this.shiftMarkers(wasm.getScrollbackLength() + this.rows_ - linesBefore);
    if (hadFocus) inner.focus();
    this.forceRender = true;
  }

  // --- writing ----------------------------------------------------------------------

  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    if (!this.inner) {
      this.pending.push({ text, done: callback });
      return;
    }
    this.writeText(text);
    if (callback) queueMicrotask(callback);
  }

  writeln(data: string, callback?: () => void): void {
    this.write(`${data}\r\n`, callback);
  }

  private writeText(text: string): void {
    const inner = this.inner;
    if (!inner || text === '') return;
    const wasm = inner.wasmTerm;
    // A reader up in the scrollback stays on the lines they are reading:
    // the engine's viewport counts lines up from the bottom, so it grows
    // with the scrollback.
    const scrolledUp = inner.viewportY > 0;
    const before = scrolledUp ? wasm.getScrollbackLength() : 0;
    for (const piece of this.tap.feed(text)) {
      if (piece.text) wasm.write(piece.text);
      if (piece.event) this.dispatch(piece.event);
    }
    // Answers to the program's queries (device attributes, colours) go back
    // to the pty, as xterm sends them.
    for (let i = 0; i < MAX_RESPONSES && wasm.hasResponse(); i++) inner.processTerminalResponses();
    inner.linkDetector?.invalidateCache();
    if (scrolledUp) {
      const grown = wasm.getScrollbackLength() - before;
      if (grown > 0) inner.scrollToLine(inner.viewportY + grown);
    }
    this.remember(text);
    if (this.search.active) this.scheduleSearchRefresh();
    if (!this.writeParsedQueued) {
      this.writeParsedQueued = true;
      queueMicrotask(() => {
        this.writeParsedQueued = false;
        if (!this.disposed) this.writeParsedEmitter.fire();
      });
    }
  }

  private scheduleSearchRefresh(): void {
    if (this.searchRefresh) clearTimeout(this.searchRefresh);
    this.searchRefresh = setTimeout(() => {
      this.searchRefresh = null;
      if (!this.disposed) this.search.refresh();
    }, SEARCH_REFRESH_MS);
  }

  private dispatch(event: TapEvent): void {
    if (event.kind === 'osc') {
      // Newest first, until one consumes it - xterm's order.
      const list = this.oscHandlers.get(event.id) ?? [];
      for (let i = list.length - 1; i >= 0; i--) if (list[i](event.data) === true) return;
      return;
    }
    for (let i = this.csiHandlers.length - 1; i >= 0; i--) {
      const h = this.csiHandlers[i];
      if (h.prefix === event.prefix && h.final === event.final && h.run(event.params) === true) {
        return;
      }
    }
  }

  private remember(text: string): void {
    this.ring.push(text);
    this.ringSize += text.length;
    while (this.ringSize > RING_MAX_CHARS && this.ring.length > 1) {
      this.ringSize -= this.ring.shift()!.length;
    }
  }

  // --- size, options, rendering ---------------------------------------------------

  resize(cols: number, rows: number): void {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c === this.cols_ && r === this.rows_) return;
    this.cols_ = c;
    this.rows_ = r;
    this.inner?.resize(c, r);
    this.resizeEmitter.fire({ cols: c, rows: r });
  }

  /** xterm's: redraw rows `start`-`end` - the engine redraws them all on its next frame. */
  refresh(): void {
    this.forceRender = true;
  }

  private applyOption(key: keyof MutableOptions, value: unknown, old: unknown): void {
    const inner = this.inner;
    if (!inner) return;
    switch (key) {
      case 'theme':
        if (!sameTheme(old as ITheme, value as ITheme)) this.rebuild();
        return;
      case 'scrollback':
        this.rebuild();
        return;
      case 'fontFamily':
      case 'fontSize':
      case 'smoothScrollDuration':
      case 'cursorBlink':
        (inner.options as Record<string, unknown>)[key] = value;
        return;
      case 'lineHeight':
        this.remeasure(inner);
        return;
      default:
      // scrollSensitivity and linkHandler are read where they are used.
    }
  }

  /**
   * The engine redraws from its own animation-frame loop. Wrapped so that a
   * hidden terminal draws nothing, DECSET 2026 holds the frame, `refresh()`
   * forces a full draw, and `onRender` fires after a frame that drew content.
   */
  private wrapRenderer(inner: GhosttyInner): void {
    const renderer = inner.renderer;
    const draw = renderer.render.bind(renderer);
    renderer.render = (buffer, force = false, viewportY = 0, term, opacity) => {
      if (this.inner !== inner) return;
      const wrapper = this.element;
      if (!wrapper || wrapper.clientWidth === 0 || this.isHeld(buffer)) {
        if (force) this.needsFull = true;
        return;
      }
      const full = force || this.needsFull || this.forceRender;
      // A scroll redraws everything too (the renderer sees the new viewport).
      const scrolled = viewportY !== this.lastViewportY;
      const drew = full || scrolled || buffer.isDirty();
      draw(buffer, full, viewportY, term, opacity);
      this.lastViewportY = viewportY;
      this.needsFull = false;
      this.forceRender = false;
      if (!drew) return;
      this.decorations?.layout();
      this.renderEmitter.fire({ start: 0, end: this.rows_ - 1 });
    };
  }

  private isHeld(wasm: InnerWasm): boolean {
    if (!wasm.getMode(2026, false)) {
      this.holdSince = null;
      return false;
    }
    const now = performance.now();
    this.holdSince ??= now;
    return now - this.holdSince < HOLD_SAFETY_MS;
  }

  // --- input --------------------------------------------------------------------------

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  /** The engine calls this on keydown; `true` means "handled, stop" (xterm's `false`). */
  private handleKey(event: KeyboardEvent): boolean {
    const inner = this.inner;
    const plain = !event.altKey && !event.shiftKey;
    // ⌘C over a selection: the engine leaves it to the browser's copy, which
    // finds no DOM selection on a canvas.
    if (
      event.metaKey &&
      !event.ctrlKey &&
      plain &&
      event.code === 'KeyC' &&
      inner?.hasSelection()
    ) {
      void navigator.clipboard?.writeText(inner.getSelection());
      return true;
    }
    const proceed = this.keyHandler ? this.keyHandler(event) : true;
    if (!proceed) {
      // A paste key left to the browser (no preventDefault): the engine's own
      // early return for Ctrl/⌘+V lets the native paste through.
      return !(
        !event.defaultPrevented &&
        (event.ctrlKey || event.metaKey) &&
        event.code === 'KeyV'
      );
    }
    // Ctrl+V is a key, not a paste, wherever the handler let it through:
    // readline's quoted-insert, Claude Code's image paste. The engine would
    // swallow it into a browser paste.
    if (event.ctrlKey && !event.metaKey && plain && event.code === 'KeyV') {
      this.dataEmitter.fire('\x16');
      return true;
    }
    return false;
  }

  /** `true` cancels the engine's own wheel handling. */
  private handleWheel(event: WheelEvent): boolean {
    const inner = this.inner;
    if (!inner) return false;
    const wasm = inner.wasmTerm;
    if (!wasm.isAlternateScreen()) {
      this.wheel.reset();
      return this.scrollByWheel(inner, event);
    }
    // A full-screen program without the mouse gets arrow keys (alternate
    // scroll) - the engine's own, as xterm.
    if (!wasm.hasMouseTracking()) {
      this.wheel.reset();
      return false;
    }
    const cell = this.cellSize() ?? { width: 8, height: 16 };
    const steps = this.wheel.take(
      event.deltaY,
      event.deltaMode,
      cell.height,
      this.rows_,
      this.opts.scrollSensitivity,
    );
    if (steps === 0) return true;
    const { col, row } = this.cellAt(event);
    const report = encodeWheel({
      direction: steps < 0 ? 'up' : 'down',
      col,
      row,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      sgr: wasm.getMode(1006, false),
    });
    this.dataEmitter.fire(report.repeat(Math.abs(steps)));
    return true;
  }

  /**
   * The scrollback, at the scroll speed setting: the engine's own step (one
   * line per cell height of pixels) times `scrollSensitivity`. At 1 the
   * engine scrolls by itself.
   */
  private scrollByWheel(inner: GhosttyInner, event: WheelEvent): boolean {
    const speed = this.opts.scrollSensitivity;
    if (!inner.smoothScrollTo || !Number.isFinite(speed) || speed === 1) return false;
    const cellHeight = this.cellSize()?.height ?? 20;
    let lines: number;
    if (event.deltaMode === 0) lines = event.deltaY / cellHeight;
    else if (event.deltaMode === 1) lines = event.deltaY;
    else if (event.deltaMode === 2) lines = event.deltaY * this.rows_;
    else lines = event.deltaY / WHEEL_PIXELS_PER_LINE;
    if (lines !== 0) inner.smoothScrollTo(inner.viewportY - lines * Math.max(0.1, speed));
    return true;
  }

  /** The cell under a pointer event, clamped to the grid. */
  private cellAt(event: MouseEvent): { col: number; row: number } {
    const cell = this.cellSize() ?? { width: 8, height: 16 };
    const rect = (this.inner?.canvas ?? this.element)?.getBoundingClientRect();
    const col = rect ? Math.floor((event.clientX - rect.left) / cell.width) : 0;
    const row = rect ? Math.floor((event.clientY - rect.top) / cell.height) : 0;
    return {
      col: Math.min(this.cols_ - 1, Math.max(0, col)),
      row: Math.min(this.rows_ - 1, Math.max(0, row)),
    };
  }

  // --- mouse reports -------------------------------------------------------------------

  /** What the program asked to hear about the mouse (DECSET 9 / 1000 / 1002 / 1003). */
  private mouseMode(): MouseMode {
    const wasm = this.inner?.wasmTerm;
    if (!wasm?.hasMouseTracking()) return 'none';
    if (wasm.getMode(1003, false)) return 'any';
    if (wasm.getMode(1002, false)) return 'drag';
    if (wasm.getMode(1000, false)) return 'click';
    return wasm.getMode(9, false) ? 'press' : 'none';
  }

  /**
   * Presses, releases and motion go to a program that asked for the mouse,
   * as xterm sends them; Shift held keeps the click a selection. The press
   * still reaches the page (the view claims the terminal on mousedown) and
   * the engine (which focuses on it); only the selection it starts is
   * cancelled. Releases and drags are heard on the document, so a drag that
   * leaves the terminal still ends.
   */
  private listenToMouse(wrapper: HTMLElement): void {
    const down = (event: MouseEvent): void => {
      this.reportingPress = false;
      const button = event.button;
      if (event.shiftKey || (button !== 0 && button !== 1 && button !== 2)) return;
      const mode = this.mouseMode();
      if (!reports(mode, { action: 'press', button })) return;
      this.reportingPress = true;
      this.pressed = mode === 'press' ? null : button;
      this.sendMouse(event, 'press', button);
    };
    // After the engine's own listeners on the canvas: undo the selection the
    // press started, or the drag would select and the release copy.
    const afterDown = (): void => {
      const selection = this.inner?.selectionManager;
      if (this.reportingPress && selection) selection.isSelecting = false;
    };
    const move = (event: MouseEvent): void => {
      // Heard for the whole page, per terminal: the cheap check first.
      const button = this.pressed;
      if (button === null && !wrapper.contains(event.target as Node | null)) return;
      if (!reports(this.mouseMode(), { action: 'move', button })) return;
      this.sendMouse(event, 'move', button);
    };
    const up = (event: MouseEvent): void => {
      const button = this.pressed;
      if (button === null) return;
      this.pressed = null;
      this.reportingPress = false;
      if (reports(this.mouseMode(), { action: 'release', button })) {
        this.sendMouse(event, 'release', button);
      }
    };
    // A double click on a reported press would select a word and copy it.
    const dblclick = (event: MouseEvent): void => {
      if (this.reportingPress) event.stopPropagation();
    };
    wrapper.addEventListener('mousedown', down, { capture: true });
    wrapper.addEventListener('mousedown', afterDown);
    wrapper.addEventListener('dblclick', dblclick, { capture: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    this.unlisten.push(() => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    });
  }

  private sendMouse(
    event: MouseEvent,
    action: 'press' | 'release' | 'move',
    button: MouseButton | null,
  ): void {
    const { col, row } = this.cellAt(event);
    if (action === 'move') {
      // One report per cell crossed, as xterm.
      const key = `${col}:${row}:${button}`;
      if (key === this.lastMoveCell) return;
      this.lastMoveCell = key;
    } else this.lastMoveCell = `${col}:${row}:${action === 'press' ? button : null}`;
    this.dataEmitter.fire(
      encodeMouse({
        action,
        button,
        col,
        row,
        shift: false,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        sgr: this.inner?.wasmTerm.getMode(1006, false) ?? false,
      }),
    );
  }

  paste(text: string): void {
    this.inner?.paste(text);
  }

  /**
   * A browser paste, as xterm takes it: an empty one too. A clipboard holding
   * only an image pastes no text, and in bracketed mode the program still
   * gets the empty paste - Claude Code reads the image off the clipboard
   * then. The engine drops a paste without text (no image ever reached
   * Claude), and its container's handler pastes unbracketed.
   */
  private handlePaste(event: ClipboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const inner = this.inner;
    if (!inner) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text === '' && !inner.wasmTerm.getMode(2004, false)) return;
    inner.paste(text);
  }

  focus(): void {
    this.inner?.focus();
  }

  blur(): void {
    this.inner?.blur();
  }

  // --- selection, scrolling, clearing ------------------------------------------

  hasSelection(): boolean {
    return this.inner?.hasSelection() ?? false;
  }

  getSelection(): string {
    return this.inner?.getSelection() ?? '';
  }

  clearSelection(): void {
    this.inner?.clearSelection();
  }

  /** xterm's: `line` is the buffer row to show at the top. */
  scrollToLine(line: number): void {
    const inner = this.inner;
    if (!inner || inner.wasmTerm.isAlternateScreen()) return;
    inner.scrollToLine(inner.wasmTerm.getScrollbackLength() - line);
  }

  scrollToBottom(): void {
    this.inner?.scrollToBottom();
  }

  scrollLines(amount: number): void {
    this.inner?.scrollLines(amount);
  }

  /**
   * xterm's clear: the scrollback and the screen above the cursor's row go,
   * that row moves to the top. Fed to the engine only, never to the pty.
   */
  clear(): void {
    const inner = this.inner;
    if (!inner) return;
    const wasm = inner.wasmTerm;
    const buf = inner.buffer.active;
    const y = buf.cursorY;
    const removed = wasm.getScrollbackLength() + y;
    inner.clearSelection();
    wasm.write(`${y > 0 ? `\x1b[${y}S` : ''}\x1b[1;${buf.cursorX + 1}H\x1b[3J`);
    this.shiftMarkers(-removed);
    inner.scrollToBottom();
    this.forceRender = true;
  }

  // --- buffer, modes, markers -------------------------------------------------------

  readonly buffer = {
    active: this.bufferView(() => this.inner?.buffer.active),
    normal: this.bufferView(() => this.inner?.buffer.normal),
    alternate: this.bufferView(() => this.inner?.buffer.alternate),
  };

  private bufferView(source: () => InnerBuffer | undefined) {
    const owner = (): GhosttyInner | null => this.inner;
    return {
      get type(): 'normal' | 'alternate' {
        return source()?.type ?? 'normal';
      },
      get cursorX(): number {
        return source()?.cursorX ?? 0;
      },
      get cursorY(): number {
        return source()?.cursorY ?? 0;
      },
      /** The first row of the screen in buffer rows (the scrollback above it). */
      get baseY(): number {
        const b = source();
        return b?.type === 'normal' ? (owner()?.wasmTerm.getScrollbackLength() ?? 0) : 0;
      },
      /** The row shown at the top of the viewport. */
      get viewportY(): number {
        const b = source();
        const inner = owner();
        if (!inner || b?.type !== 'normal') return 0;
        const base = inner.wasmTerm.getScrollbackLength();
        return Math.max(0, base - Math.floor(inner.viewportY));
      },
      get length(): number {
        return source()?.length ?? 0;
      },
      getLine(y: number): InnerLine | undefined {
        const b = source();
        const line = b?.getLine(y);
        if (!b || !line || b.type !== 'normal' || y === 0) return line;
        const inner = owner();
        if (!inner || y >= inner.wasmTerm.getScrollbackLength()) return line;
        // The engine keeps no wrap flag for scrollback rows (see the header).
        const wrapped = fillsRow(b.getLine(y - 1));
        if (wrapped === line.isWrapped) return line;
        return Object.create(line, { isWrapped: { value: wrapped } }) as InnerLine;
      },
      getNullCell(): InnerCell | undefined {
        return source()?.getNullCell();
      },
    };
  }

  get modes() {
    const wasm = this.inner?.wasmTerm;
    const on = (mode: number): boolean => wasm?.getMode(mode, false) ?? false;
    return {
      applicationCursorKeysMode: on(1),
      bracketedPasteMode: on(2004),
      mouseTrackingMode: on(1003)
        ? ('any' as const)
        : on(1002)
          ? ('drag' as const)
          : on(1000)
            ? ('vt200' as const)
            : on(9)
              ? ('x10' as const)
              : ('none' as const),
      sendFocusMode: on(1004),
      synchronizedOutputMode: on(2026),
      wraparoundMode: on(7),
    };
  }

  registerMarker(cursorYOffset = 0): Marker | undefined {
    if (!this.inner) return undefined;
    const buf = this.buffer.active;
    const line = buf.baseY + buf.cursorY + cursorYOffset;
    if (line < 0) return undefined;
    const marker = new Marker(line);
    this.markers.add(marker);
    marker.onDispose(() => this.markers.delete(marker));
    return marker;
  }

  /** xterm's: a box over `width` x `height` cells from the marker's row, gone with it. */
  registerDecoration(options: {
    marker: Marker;
    x?: number;
    width?: number;
    height?: number;
  }): LayerDecoration | undefined {
    const layer = this.decorations;
    const marker = options.marker;
    if (!layer || marker.isDisposed) return undefined;
    const decoration = layer.add({
      line: () => marker.line,
      col: options.x ?? 0,
      width: options.width ?? 1,
      height: options.height ?? 1,
      scope: 'normal',
    });
    const sub = marker.onDispose(() => decoration.dispose());
    decoration.onDispose(() => sub.dispose());
    return decoration;
  }

  /** The buffer row at the top of the view, for the decoration layer. */
  private viewTop(scope: 'normal' | 'active'): number | null {
    const inner = this.inner;
    if (!inner) return null;
    if (inner.wasmTerm.isAlternateScreen()) return scope === 'normal' ? null : 0;
    return this.buffer.normal.viewportY;
  }

  /** Where the canvas sits inside the wrapper. */
  private gridOrigin(): { left: number; top: number } {
    let left = 0;
    let top = 0;
    let el: HTMLElement | null = this.inner?.canvas ?? null;
    while (el && el !== this.element) {
      left += el.offsetLeft;
      top += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    return { left, top };
  }

  private shiftMarkers(delta: number): void {
    if (delta === 0) return;
    for (const marker of [...this.markers]) {
      marker.line += delta;
      if (marker.line < 0) marker.dispose();
    }
  }

  // --- addons and links ---------------------------------------------------------------

  loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  registerLinkProvider(provider: ILinkProvider): IDisposable {
    const converted: GhosttyLinkProvider = {
      provideLinks: (y, callback) =>
        provider.provideLinks(y + 1, (links) =>
          callback(links?.map((link) => this.toGhosttyLink(link))),
        ),
    };
    this.linkProviders.set(provider, converted);
    this.inner?.registerLinkProvider(converted);
    return {
      dispose: () => {
        this.linkProviders.delete(provider);
        const detector = this.inner?.linkDetector;
        if (!detector) return;
        detector.providers = detector.providers.filter((p) => p !== converted);
        detector.invalidateCache();
      },
    };
  }

  private toGhosttyLink(link: ILink): GhosttyLink {
    return {
      text: link.text,
      range: toGhosttyRange(link.range),
      activate: (event) => link.activate(event, link.text),
      hover: (hovered) => {
        const event = this.lastMouse ?? new MouseEvent('mousemove');
        if (hovered) link.hover?.(event, link.text);
        else link.leave?.(event, link.text);
      },
      dispose: () => link.dispose?.(),
    };
  }

  /**
   * The engine's own providers open every link with `window.open` on a
   * modified click. The plain-URL one goes (the app's web-links provider
   * replaces it); OSC 8 hyperlinks keep the engine's detection and get the
   * app's `linkHandler` - the same routing xterm gives them.
   */
  private installLinkProviders(inner: GhosttyInner): void {
    const detector = inner.linkDetector;
    if (!detector) return;
    const [osc8] = detector.providers;
    detector.providers = [];
    if (osc8) {
      detector.providers.push({
        provideLinks: (y, callback) =>
          osc8.provideLinks(y, (links) => {
            const handler = this.opts.linkHandler;
            if (!handler || !links) return callback(undefined);
            callback(
              links.map((link) => {
                const range = toXtermRange(link.range);
                return {
                  ...link,
                  activate: (event) => handler.activate(event, link.text, range),
                  hover: (hovered) => {
                    const event = this.lastMouse ?? new MouseEvent('mousemove');
                    if (hovered) handler.hover?.(event, link.text, range);
                    else handler.leave?.(event, link.text, range);
                  },
                };
              }),
            );
          }),
        dispose: () => osc8.dispose?.(),
      });
    }
    for (const converted of this.linkProviders.values()) detector.providers.push(converted);
    detector.invalidateCache();
  }

  // --- find -----------------------------------------------------------------------------

  private bufferRows(): string[] {
    const buf = this.inner?.buffer.active;
    if (!buf) return [];
    const rows: string[] = [];
    for (let y = 0; y < buf.length; y++) rows.push(rowText(buf.getLine(y)).text);
    return rows;
  }

  /** A match (text positions in its row) as the cells it covers. */
  private matchCells(match: SearchMatch): { col: number; width: number } {
    const line = this.inner?.buffer.active.getLine(match.row);
    const { cells } = rowText(line);
    const first = cells[match.col];
    const last = cells[match.col + match.length - 1];
    if (first === undefined || last === undefined) return { col: match.col, width: match.length };
    const lastWidth = Math.max(1, line?.getCell(last)?.getWidth() ?? 1);
    return { col: first, width: last + lastWidth - first };
  }

  /** Every match tinted, the current one stronger and outlined - over the text, so translucent. */
  private highlightMatches(
    matches: readonly SearchMatch[],
    current: number,
    decorations: SearchDecorations,
  ): void {
    this.clearMatchDecorations();
    const layer = this.decorations;
    const base =
      decorations.activeMatchBorder ?? decorations.matchBorder ?? decorations.matchBackground;
    const fill = translucent(base, MATCH_ALPHA);
    const activeFill = translucent(base, ACTIVE_MATCH_ALPHA);
    if (!layer || !base || !fill || !activeFill) return;
    this.matchDecorations = matches.map((match, i) => {
      const { col, width } = this.matchCells(match);
      return layer.add(
        {
          line: () => match.row,
          col,
          width,
          height: 1,
          scope: 'active',
          className: i === current ? 'ghostty-match ghostty-match-active' : 'ghostty-match',
          style:
            i === current
              ? { background: activeFill, outline: `1px solid ${base}`, outlineOffset: '-1px' }
              : { background: fill },
        },
        false,
      );
    });
    layer.layout();
  }

  private clearMatchDecorations(): void {
    for (const decoration of this.matchDecorations.splice(0)) decoration.dispose();
  }

  /** Bring a match's row into view (centred when it is up in the scrollback) and select it. */
  private revealMatch(match: SearchMatch): void {
    const inner = this.inner;
    if (!inner) return;
    const base = inner.wasmTerm.isAlternateScreen() ? 0 : inner.wasmTerm.getScrollbackLength();
    if (match.row >= base) inner.scrollToLine(0);
    else inner.scrollToLine(Math.min(base, base - match.row + Math.floor(this.rows_ / 2)));
    const top = base - Math.floor(inner.viewportY);
    const { col, width } = this.matchCells(match);
    inner.select(col, match.row - top, width);
  }
}

/** xterm's `FitAddon` for the engine: the grid that fills the container. */
export class GhosttyFit {
  constructor(private readonly term: GhosttyXterm) {}

  activate(): void {
    // Made with its terminal - nothing to attach.
  }

  dispose(): void {
    // Holds nothing of its own.
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    const parent = this.term.element?.parentElement;
    const cell = this.term.cellSize();
    if (!parent || !cell) return undefined;
    const style = window.getComputedStyle(parent);
    const width =
      parent.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const height =
      parent.clientHeight -
      (Number.parseFloat(style.paddingTop) || 0) -
      (Number.parseFloat(style.paddingBottom) || 0);
    if (width <= 0 || height <= 0) return undefined;
    return {
      cols: Math.max(2, Math.floor(width / cell.width)),
      rows: Math.max(1, Math.floor(height / cell.height)),
    };
  }

  fit(): void {
    const next = this.proposeDimensions();
    if (next && (next.cols !== this.term.cols || next.rows !== this.term.rows)) {
      this.term.resize(next.cols, next.rows);
    }
  }
}
