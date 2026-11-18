import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ILinkProvider } from '@xterm/xterm';
import type { ILinkProvider as GhosttyLinkProvider } from 'ghostty-web';

import {
  GhosttyXterm,
  type GhosttyInner,
  type InnerBuffer,
  type InnerOptions,
} from '@renderer/lib/terminal/ghostty/ghostty-xterm';

/**
 * A stand-in for ghostty-web's Terminal: it keeps a log of what reached the
 * engine and a small model of the cursor, scrollback and modes - enough to
 * see WHEN a handler runs relative to the bytes around it.
 */
class FakeInner implements GhosttyInner {
  cols: number;
  rows: number;
  viewportY = 0;
  options: GhosttyInner['options'];
  written: string[] = [];
  scrollback = 0;
  cursorX = 0;
  cursorY = 0;
  modes = new Map<number, boolean>();
  responses: string[] = [];
  dirty = false;
  drawn: boolean[] = [];
  selection = '';
  selected: [number, number, number] | null = null;
  scrolledTo: number[] = [];
  disposed = false;
  /** Row text by buffer index, for find. */
  lines: string[] = [];
  /** Screen rows (by buffer index) the engine flags as soft-wrap continuations. */
  wrapped = new Set<number>();
  smoothTo: number[] = [];
  fontChanges = 0;
  /** Rows laid out cell by cell (wide characters, unwritten cells), by buffer index. */
  cellRows = new Map<number, { chars: string; width: number }[]>();
  /** What the engine's own copy-on-select put on the clipboard. */
  copied: string[] = [];
  /** The engine's own selection: a canvas press starts one, the release copies it. */
  selectionManager = {
    isSelecting: false,
    copyToClipboard: async (text: string) => {
      this.copied.push(text);
    },
  };
  canvas = document.createElement('canvas');
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  wheelHandler: ((e: WheelEvent) => boolean) | null = null;
  private dataListeners = new Set<(d: string) => void>();
  osc8: GhosttyLinkProvider = { provideLinks: vi.fn() };
  urls: GhosttyLinkProvider = { provideLinks: vi.fn() };
  linkDetector = { providers: [this.osc8, this.urls], invalidateCache: vi.fn() };

  constructor(readonly created: InnerOptions) {
    this.cols = created.cols;
    this.rows = created.rows;
    this.options = { ...created };
  }

  wasmTerm = {
    write: (data: string) => {
      this.written.push(data);
      // eslint-disable-next-line no-control-regex
      for (const m of data.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
        this.modes.set(Number(m[1]), m[2] === 'h');
      }
      // eslint-disable-next-line no-control-regex
      for (const ch of data.replace(/\x1b\][^\x07]*\x07/g, '')) {
        if (ch === '\n') {
          if (this.cursorY < this.rows - 1) this.cursorY += 1;
          else this.scrollback += 1;
        } else if (ch === '\r') this.cursorX = 0;
        else if (ch >= ' ') this.cursorX += 1;
      }
      this.dirty = true;
    },
    getMode: (mode: number) => this.modes.get(mode) ?? false,
    isAlternateScreen: () => this.modes.get(1049) ?? false,
    hasMouseTracking: () => [1000, 1002, 1003].some((m) => this.modes.get(m)),
    getScrollbackLength: () => this.scrollback,
    isDirty: () => this.dirty,
    hasResponse: () => this.responses.length > 0,
    readResponse: () => this.responses.shift() ?? null,
  };

  private metrics = { width: 8, height: 16, baseline: 12 };

  renderer = {
    // (buffer, force, viewportY): the adapter's wrapper reads the viewport.
    render: (...args: [buffer: unknown, force?: boolean, viewportY?: number]) => {
      this.drawn.push(args[1] ?? false);
      this.dirty = false;
    },
    getMetrics: () => ({ width: this.metrics.width, height: this.metrics.height }),
    // The engine's measure of a 13 px font, before any line height.
    measureFont: () => ({ width: 8, height: 16, baseline: 12 }),
    remeasureFont: () => {
      this.metrics = this.renderer.measureFont();
    },
  };

  handleFontChange(): void {
    this.fontChanges += 1;
  }

  smoothScrollTo(y: number): void {
    this.smoothTo.push(y);
    this.viewportY = Math.max(0, Math.min(this.scrollback, y));
  }

  private bufferOf(type: 'normal' | 'alternate'): InnerBuffer {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      type,
      get cursorX() {
        return self.cursorX;
      },
      get cursorY() {
        return self.cursorY;
      },
      get length() {
        return type === 'normal' ? self.scrollback + self.rows : self.rows;
      },
      getLine: (y: number) => {
        const laid = self.cellRows.get(y);
        if (laid) {
          return {
            length: self.cols,
            isWrapped: false,
            getCell: (x: number) => {
              const cell = laid[x] ?? { chars: '', width: 1 };
              return { getChars: () => cell.chars, getWidth: () => cell.width };
            },
            translateToString: () => laid.map((c) => c.chars).join(''),
          };
        }
        const text = self.lines[y];
        if (text === undefined) return undefined;
        const onScreen = type === 'alternate' || y >= self.scrollback;
        return {
          length: self.cols,
          // Only screen rows carry the engine's flag.
          isWrapped: onScreen && self.wrapped.has(y),
          getCell: (x: number) =>
            x < 0 || x >= self.cols
              ? undefined
              : { getChars: () => text[x] ?? '', getWidth: () => 1 },
          translateToString: () => text,
        };
      },
      getNullCell: () => ({ getChars: () => '', getWidth: () => 1 }),
    };
  }

  get buffer() {
    return {
      active: this.bufferOf(this.wasmTerm.isAlternateScreen() ? 'alternate' : 'normal'),
      normal: this.bufferOf('normal'),
      alternate: this.bufferOf('alternate'),
    };
  }

  open(parent: HTMLElement): void {
    parent.setAttribute('tabindex', '0');
    parent.appendChild(this.canvas);
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.selectionManager.isSelecting = true;
    });
    document.addEventListener('mouseup', () => {
      if (!this.selectionManager.isSelecting) return;
      this.selectionManager.isSelecting = false;
      if (this.selection) void this.selectionManager.copyToClipboard(this.selection);
    });
    // The engine focuses itself on open, now and on a timer.
    parent.focus();
    setTimeout(() => parent.focus(), 0);
  }
  dispose(): void {
    this.disposed = true;
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  focus(): void {
    // Focus is not modelled.
  }
  blur(): void {
    // Focus is not modelled.
  }
  paste(text: string): void {
    this.emit(`\x1b[200~${text}\x1b[201~`);
  }
  onData(listener: (d: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  emit(data: string): void {
    for (const l of this.dataListeners) l(data);
  }
  attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = h;
  }
  attachCustomWheelEventHandler(h: (e: WheelEvent) => boolean): void {
    this.wheelHandler = h;
  }
  registerLinkProvider(p: GhosttyLinkProvider): void {
    this.linkDetector.providers.push(p);
  }
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection !== '';
  }
  clearSelection(): void {
    this.selection = '';
  }
  select(col: number, row: number, len: number): void {
    this.selected = [col, row, len];
  }
  scrollToLine(line: number): void {
    this.viewportY = Math.max(0, Math.min(this.scrollback, line));
    this.scrolledTo.push(line);
  }
  scrollToBottom(): void {
    this.viewportY = 0;
  }
  scrollLines(): void {
    // Not used by these tests.
  }
  processTerminalResponses(): void {
    const r = this.wasmTerm.readResponse();
    if (r) this.emit(r);
  }
}

const OPTIONS = {
  theme: { background: '#000000', foreground: '#ffffff' },
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.2,
  scrollback: 1000,
  scrollSensitivity: 1,
  smoothScrollDuration: 0,
};

function setup(opts: { open?: boolean } = {}) {
  const inners: FakeInner[] = [];
  const term = new GhosttyXterm({ ...OPTIONS, cols: 20, rows: 5 }, (o) => {
    const inner = new FakeInner(o);
    inners.push(inner);
    return inner;
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  if (opts.open !== false) {
    term.open(container);
    // jsdom lays nothing out: give the terminal a width so it counts as shown.
    Object.defineProperty(term.element!, 'clientWidth', { value: 160, configurable: true });
  }
  const inner = () => inners[inners.length - 1];
  return { term, inners, inner, container };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('GhosttyXterm - writing and parser hooks', () => {
  it('queues writes made before open and plays them in order, callbacks after', async () => {
    const { term, inner, container } = setup({ open: false });
    const done = vi.fn();
    term.write('one ');
    term.write('two', done);
    expect(done).not.toHaveBeenCalled();
    term.open(container);
    expect(inner().written.join('')).toBe('one two');
    await flush();
    expect(done).toHaveBeenCalledOnce();
  });

  it('runs an OSC handler after the text before the mark reached the engine, not after the rest', () => {
    const { term, inner } = setup();
    const seen: string[] = [];
    term.parser.registerOscHandler(6791, (data) => {
      seen.push(`${data} after ${JSON.stringify(inner().written.join(''))}`);
      return true;
    });
    term.write('ls\r\n\x1b]6791;at;7\x07output');
    expect(seen).toEqual([`at;7 after ${JSON.stringify('ls\r\n\x1b]6791;at;7\x07')}`]);
    expect(inner().written.join('')).toBe('ls\r\n\x1b]6791;at;7\x07output');
  });

  it('asks the newest handler first and stops at the one that consumes it', () => {
    const { term } = setup();
    const calls: string[] = [];
    term.parser.registerOscHandler(6790, () => (calls.push('old'), true));
    term.parser.registerOscHandler(6790, () => (calls.push('new'), false));
    term.write('\x1b]6790;running\x07');
    expect(calls).toEqual(['new', 'old']);
  });

  it('stops calling a disposed handler', () => {
    const { term } = setup();
    const run = vi.fn(() => true);
    term.parser.registerOscHandler(6790, run).dispose();
    term.write('\x1b]6790;running\x07');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports DECSET parameters to a CSI handler', () => {
    const { term } = setup();
    const run = vi.fn(() => false);
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, run);
    term.write('\x1b[?1000;1006h');
    expect(run).toHaveBeenCalledWith([1000, 1006]);
  });

  it('sends the answers to queries back as input', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    inner().responses.push('\x1b[?62;22c');
    term.write('\x1b[c');
    expect(data).toHaveBeenCalledWith('\x1b[?62;22c');
  });

  it('keeps a reader up in the scrollback on the lines they were reading', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(30));
    inner().viewportY = 10; // scrolled up 10 lines
    term.write('\n'.repeat(3));
    expect(inner().viewportY).toBe(13);
  });

  it('fires onWriteParsed once per burst of writes', async () => {
    const { term } = setup();
    const parsed = vi.fn();
    term.onWriteParsed(parsed);
    term.write('a');
    term.write('b');
    await flush();
    expect(parsed).toHaveBeenCalledOnce();
  });
});

describe('GhosttyXterm - buffer, markers, modes', () => {
  it('rebuilds baseY and viewportY from the scrollback', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(104)); // 4 rows fill the screen, 100 scroll off
    expect(term.buffer.active.baseY).toBe(100);
    expect(term.buffer.active.viewportY).toBe(100);
    inner().viewportY = 10;
    expect(term.buffer.active.viewportY).toBe(90);
  });

  it('puts a marker made by a mark on the row the mark was printed on', () => {
    const { term } = setup();
    const lines: number[] = [];
    term.parser.registerOscHandler(6791, () => {
      lines.push(term.registerMarker(0)!.line);
      return true;
    });
    term.write('\n'.repeat(10));
    term.write('\x1b]6791;at;1\x07\n\n');
    // 4 rows down the screen, 6 lines into the scrollback - and the two
    // newlines after the mark did not move it.
    expect(lines).toEqual([10]);
  });

  it('clears like xterm: in the engine only, the cursor row moved to the top, markers shifted', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    term.write('\n'.repeat(12)); // scrollback 8, cursor on row 4
    const above = term.registerMarker(-2)!;
    const atRow = term.registerMarker(0)!;
    inner().written = [];
    term.clear();
    expect(inner().written).toEqual(['\x1b[4S\x1b[1;1H\x1b[3J']);
    expect(data).not.toHaveBeenCalled();
    expect(above.isDisposed).toBe(true);
    expect(atRow.line).toBe(0);
  });

  it('maps the engine modes to xterm names', () => {
    const { term } = setup();
    expect(term.modes.mouseTrackingMode).toBe('none');
    term.write('\x1b[?1002h\x1b[?2026h');
    expect(term.modes.mouseTrackingMode).toBe('drag');
    expect(term.modes.synchronizedOutputMode).toBe(true);
  });

  it('reads a scrollback row as wrapped when the row above fills its last column', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(14)); // scrollback 10, screen rows 10-14
    const lines = Array.from({ length: 15 }, () => 'short');
    lines[3] = 'src/components/long-'; // exactly 20 columns
    lines[4] = 'name.ts:12';
    lines[11] = 'x'.repeat(20);
    inner().lines = lines;
    const buf = term.buffer.active;
    expect(buf.getLine(4)?.isWrapped).toBe(true);
    expect(buf.getLine(4)?.translateToString(true)).toBe('name.ts:12');
    expect(buf.getLine(5)?.isWrapped).toBe(false);
    expect(buf.getLine(0)?.isWrapped).toBe(false);
    // A screen row keeps the engine's own flag, which knows.
    expect(buf.getLine(12)?.isWrapped).toBe(false);
    inner().wrapped.add(13);
    expect(buf.getLine(13)?.isWrapped).toBe(true);
  });
});

describe('GhosttyXterm - decorations', () => {
  const frame = (inner: FakeInner, viewportY = 0) =>
    inner.renderer.render(inner.wasmTerm as never, false, viewportY);

  it('draws a decoration over its marker row, and moves it with the view', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(14)); // scrollback 10, cursor on screen row 4 (buffer row 14)
    const marker = term.registerMarker(-2)!; // buffer row 12, screen row 2
    const decoration = term.registerDecoration({ marker, width: 20, height: 2 })!;
    const rendered = vi.fn();
    decoration.onRender(rendered);
    const cell = term.cellSize()!;
    const el = decoration.element!;
    expect(rendered).toHaveBeenCalledWith(el);
    expect(el.style.top).toBe(`${2 * cell.height}px`);
    expect(el.style.height).toBe(`${2 * cell.height}px`);
    expect(el.style.width).toBe(`${20 * cell.width}px`);
    // One line up into the scrollback: the row is one lower on screen.
    inner().viewportY = 1;
    frame(inner(), 1);
    expect(el.style.top).toBe(`${3 * cell.height}px`);
    expect(el.style.display).toBe('');
    // Three up: it has left the bottom of the view.
    inner().viewportY = 3;
    frame(inner(), 3);
    expect(el.style.display).toBe('none');
  });

  it('hides a normal-buffer decoration while the alternate screen shows', () => {
    const { term, inner } = setup();
    const decoration = term.registerDecoration({ marker: term.registerMarker()! })!;
    term.write('\x1b[?1049h');
    frame(inner());
    expect(decoration.element!.style.display).toBe('none');
    term.write('\x1b[?1049l');
    frame(inner());
    expect(decoration.element!.style.display).toBe('');
  });

  it('goes with its marker', () => {
    const { term } = setup();
    const marker = term.registerMarker()!;
    const decoration = term.registerDecoration({ marker })!;
    const el = decoration.element!;
    marker.dispose();
    expect(decoration.isDisposed).toBe(true);
    expect(el.isConnected).toBe(false);
  });

  it('carries the class the app styles (the Inputs flash)', () => {
    const { term } = setup();
    const decoration = term.registerDecoration({ marker: term.registerMarker()! })!;
    decoration.onRender((el) => el.classList.add('terminal-input-flash'));
    expect(term.element!.querySelector('.xterm .terminal-input-flash')).not.toBeNull();
  });
});

describe('GhosttyXterm - rendering', () => {
  const frame = (inner: FakeInner, force = false) =>
    inner.renderer.render(inner.wasmTerm as never, force);

  it('fires onRender after a frame that drew new content, not after an idle one', () => {
    const { term, inner } = setup();
    const rendered = vi.fn();
    term.onRender(rendered);
    frame(inner()); // nothing written since open
    term.write('hello');
    frame(inner());
    expect(rendered).toHaveBeenCalledOnce();
  });

  it('draws in full and fires onRender on the frame after refresh()', () => {
    const { term, inner } = setup();
    const rendered = vi.fn();
    term.onRender(rendered);
    inner().drawn = [];
    term.refresh();
    frame(inner());
    expect(inner().drawn).toEqual([true]);
    expect(rendered).toHaveBeenCalledOnce();
  });

  it('holds the frame under synchronized output, then draws in full when it lifts', () => {
    const { term, inner } = setup();
    inner().drawn = [];
    term.write('\x1b[?2026h');
    frame(inner(), true); // a resize's forced draw, held
    term.write('repaint');
    frame(inner());
    expect(inner().drawn).toEqual([]);
    term.write('\x1b[?2026l');
    frame(inner());
    expect(inner().drawn).toEqual([true]);
  });

  it('lets a hold lapse after a second, as xterm does', () => {
    const { term, inner } = setup();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    term.write('\x1b[?2026h');
    inner().drawn = [];
    frame(inner());
    expect(inner().drawn).toEqual([]);
    now.mockReturnValue(2100);
    frame(inner());
    expect(inner().drawn).toHaveLength(1);
  });

  it('draws nothing while hidden', () => {
    const { term, inner } = setup();
    Object.defineProperty(term.element!, 'clientWidth', { value: 0, configurable: true });
    inner().drawn = [];
    term.write('x');
    frame(inner());
    expect(inner().drawn).toEqual([]);
  });
});

describe('GhosttyXterm - keys and wheel', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('turns "do not process" into the engine\'s "handled"', () => {
    const { term, inner } = setup();
    term.attachCustomKeyEventHandler((e) => {
      e.preventDefault();
      return false;
    });
    expect(inner().keyHandler!(key({ key: 'f', code: 'KeyF', metaKey: true }))).toBe(true);
  });

  it('leaves a paste key the handler passed to the browser to the native paste', () => {
    const { term, inner } = setup();
    term.attachCustomKeyEventHandler(() => false);
    expect(inner().keyHandler!(key({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(false);
  });

  function pasteEvent(types: Record<string, string>): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { types: Object.keys(types), getData: (t: string) => types[t] ?? '' },
    });
    return event;
  }

  it('pastes an image-only clipboard as an empty bracketed paste, as xterm does', () => {
    // Claude Code answers an empty paste by reading the image off the
    // clipboard; the engine dropped any paste without text, so images never
    // reached it.
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    inner().wasmTerm.write('\x1b[?2004h');
    const event = pasteEvent({ 'image/png': '' });
    inner().canvas.parentElement!.dispatchEvent(event);
    expect(data).toHaveBeenCalledWith('\x1b[200~\x1b[201~');
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends nothing for an empty paste outside bracketed mode', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    inner().canvas.parentElement!.dispatchEvent(pasteEvent({ 'image/png': '' }));
    expect(data).not.toHaveBeenCalled();
  });

  it('pastes text through the engine once, never also through its own listeners', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    const engineOwn = vi.fn();
    inner().canvas.parentElement!.addEventListener('paste', engineOwn);
    inner().canvas.parentElement!.dispatchEvent(pasteEvent({ 'text/plain': 'ls -la' }));
    expect(data).toHaveBeenCalledExactlyOnceWith('\x1b[200~ls -la\x1b[201~');
    expect(engineOwn).not.toHaveBeenCalled();
  });

  it('sends Ctrl+V to the program instead of letting the engine paste', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    term.attachCustomKeyEventHandler(() => true);
    expect(inner().keyHandler!(key({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(true);
    expect(data).toHaveBeenCalledWith('\x16');
  });

  it('copies the selection on ⌘C', () => {
    const { inner } = setup();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    inner().selection = 'npm test';
    expect(inner().keyHandler!(key({ key: 'c', code: 'KeyC', metaKey: true }))).toBe(true);
    expect(writeText).toHaveBeenCalledWith('npm test');
    vi.unstubAllGlobals();
  });

  it('selects without copying: only the copy key writes the clipboard', () => {
    const { inner } = setup();
    inner().canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    inner().selection = 'npm test';
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // The selection stands (⌘C copies it), the clipboard keeps what it had.
    expect(inner().copied).toEqual([]);
    expect(inner().hasSelection()).toBe(true);
  });

  it('reports the wheel to a full-screen program that asked for the mouse', () => {
    const { term, inner } = setup();
    const data = vi.fn();
    term.onData(data);
    term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    const event = new WheelEvent('wheel', { deltaY: -2, deltaMode: 1, clientX: 20, clientY: 40 });
    expect(inner().wheelHandler!(event)).toBe(true);
    // jsdom's canvas sits at 0,0: column 20/8 = 2, row 40/16 = 2.
    expect(data).toHaveBeenCalledWith('\x1b[<64;3;3M\x1b[<64;3;3M');
  });

  it('leaves the wheel to the engine on the normal screen and without mouse tracking', () => {
    const { term, inner } = setup();
    const wheel = new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 });
    expect(inner().wheelHandler!(wheel)).toBe(false);
    term.write('\x1b[?1049h');
    expect(inner().wheelHandler!(wheel)).toBe(false);
  });

  it('scrolls the scrollback by the scroll speed', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(40)); // scrollback 36
    term.options.scrollSensitivity = 3;
    const up = new WheelEvent('wheel', { deltaY: -2, deltaMode: 1 });
    expect(inner().wheelHandler!(up)).toBe(true);
    // The engine's viewport counts lines up from the bottom: 2 lines x 3.
    expect(inner().smoothTo).toEqual([6]);
    // Pixels: one line per cell height, then the speed.
    const cell = term.cellSize()!;
    inner().wheelHandler!(new WheelEvent('wheel', { deltaY: cell.height, deltaMode: 0 }));
    expect(inner().smoothTo[1]).toBe(3);
  });
});

describe('GhosttyXterm - mouse reports', () => {
  const at = (col: number, row: number, extra: MouseEventInit = {}): MouseEventInit => ({
    bubbles: true,
    button: 0,
    // jsdom's canvas sits at 0,0 and the fake's cells are 8 px wide.
    clientX: col * 8 + 1,
    clientY: row * 19 + 1,
    ...extra,
  });

  function mouseSetup(modes: string) {
    const env = setup();
    const data = vi.fn();
    env.term.onData(data);
    env.term.write(modes);
    const canvas = env.inner().canvas;
    const down = (init: MouseEventInit) => canvas.dispatchEvent(new MouseEvent('mousedown', init));
    const move = (init: MouseEventInit) => canvas.dispatchEvent(new MouseEvent('mousemove', init));
    const up = (init: MouseEventInit) => document.dispatchEvent(new MouseEvent('mouseup', init));
    return { ...env, data, canvas, down, move, up };
  }

  it('reports a click to a program that asked for the mouse, and cancels the selection it started', () => {
    const { data, down, up, inner, container } = mouseSetup('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    const containerDown = vi.fn();
    container.addEventListener('mousedown', containerDown);
    down(at(3, 2));
    expect(data).toHaveBeenLastCalledWith('\x1b[<0;4;3M');
    expect(inner().selectionManager.isSelecting).toBe(false);
    // The view claims the terminal on mousedown: the press still reaches it.
    expect(containerDown).toHaveBeenCalled();
    up(at(3, 2));
    expect(data).toHaveBeenLastCalledWith('\x1b[<0;4;3m');
  });

  it('leaves a Shift-click to the selection', () => {
    const { data, down, inner } = mouseSetup('\x1b[?1000h\x1b[?1006h');
    down(at(3, 2, { shiftKey: true }));
    expect(data).not.toHaveBeenCalled();
    expect(inner().selectionManager.isSelecting).toBe(true);
  });

  it('sends nothing to a program that did not ask', () => {
    const { data, down, move, up, inner } = mouseSetup('');
    down(at(1, 1));
    move(at(2, 1));
    // The drag is the engine's selection.
    expect(inner().selectionManager.isSelecting).toBe(true);
    up(at(2, 1));
    expect(data).not.toHaveBeenCalled();
  });

  it('reports a drag once per cell under 1002, and no motion under 1000', () => {
    const drag = mouseSetup('\x1b[?1002h\x1b[?1006h');
    drag.down(at(1, 1));
    drag.move(at(1, 1));
    drag.move(at(2, 1));
    drag.move(at(2, 1, { clientX: 2 * 8 + 5 })); // same cell
    drag.move(at(3, 1));
    expect(drag.data.mock.calls.map(([d]) => d)).toEqual([
      '\x1b[<0;2;2M',
      '\x1b[<32;3;2M',
      '\x1b[<32;4;2M',
    ]);
    drag.up(at(3, 1));
    drag.move(at(4, 1));
    expect(drag.data).toHaveBeenLastCalledWith('\x1b[<0;4;2m');

    document.body.innerHTML = '';
    const click = mouseSetup('\x1b[?1000h\x1b[?1006h');
    click.down(at(1, 1));
    click.move(at(2, 1));
    expect(click.data).toHaveBeenCalledTimes(1);
  });

  it('reports plain motion over the terminal under 1003', () => {
    const { data, move } = mouseSetup('\x1b[?1003h\x1b[?1006h');
    move(at(5, 0));
    expect(data).toHaveBeenLastCalledWith('\x1b[<35;6;1M');
    // Motion elsewhere on the page is not the terminal's.
    document.body.dispatchEvent(new MouseEvent('mousemove', at(6, 0)));
    expect(data).toHaveBeenCalledTimes(1);
  });

  it('ends a drag released outside the terminal', () => {
    const { data, down } = mouseSetup('\x1b[?1002h');
    down(at(0, 0));
    document.body.dispatchEvent(new MouseEvent('mouseup', at(0, 0)));
    // X10 encoding: one release code (3) for every button.
    expect(data).toHaveBeenLastCalledWith('\x1b[M#!!');
  });

  it('stops listening to the page once disposed', () => {
    const { term, data, down, up } = mouseSetup('\x1b[?1000h');
    down(at(0, 0));
    term.dispose();
    up(at(0, 0));
    expect(data).toHaveBeenCalledTimes(1);
  });
});

describe('GhosttyXterm - engine quirks', () => {
  it('does not take the keyboard when it opens', async () => {
    const { term, container } = setup({ open: false });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    term.open(container);
    await flush();
    expect(document.activeElement).toBe(input);
  });

  it('rebuilds on a theme change and replays the stream without its marks or answers', () => {
    const { term, inners, inner } = setup();
    const data = vi.fn();
    const mark = vi.fn(() => true);
    term.onData(data);
    term.parser.registerOscHandler(6791, mark);
    term.write('\x1b[?2004hprompt$ \x1b]6791;at;1\x07');
    const marker = term.registerMarker(0)!;
    expect(mark).toHaveBeenCalledOnce();
    const first = inner();
    first.responses.push('stale answer');
    term.options.theme = { background: '#ffffff', foreground: '#000000' };
    expect(inners).toHaveLength(2);
    expect(first.disposed).toBe(true);
    expect(inner().created.theme).toEqual({ background: '#ffffff', foreground: '#000000' });
    expect(inner().written.join('')).toContain('prompt$ ');
    expect(mark).toHaveBeenCalledOnce();
    expect(data).not.toHaveBeenCalled();
    expect(inner().modes.get(2004)).toBe(true);
    expect(marker.isDisposed).toBe(false);
  });

  it('keeps the engine when the theme object is new but the same', () => {
    const { term, inners } = setup();
    term.options.theme = { ...OPTIONS.theme };
    expect(inners).toHaveLength(1);
  });

  it('applies a font change to the live engine, and a later rebuild keeps it', () => {
    const { term, inners, inner } = setup();
    term.options.fontFamily = 'Menlo';
    term.options.fontSize = 16;
    // The engine re-measures its cells on these itself: no rebuild, no replay.
    expect(inners).toHaveLength(1);
    expect(inner().options).toMatchObject({ fontFamily: 'Menlo', fontSize: 16 });
    term.options.theme = { ...OPTIONS.theme, background: '#101010' };
    expect(inners).toHaveLength(2);
    expect(inner().created).toMatchObject({ fontFamily: 'Menlo', fontSize: 16 });
  });

  it('makes rows lineHeight times the measured font height, text centred', () => {
    const { term, inner } = setup();
    // 16 px measured x 1.2 = 19 px rows.
    expect(term.cellSize()).toEqual({ width: 8, height: 19 });
    expect(inner().fontChanges).toBeGreaterThan(0);
    term.options.lineHeight = 2;
    expect(term.cellSize()).toEqual({ width: 8, height: 32 });
    // The baseline moves down by half the added height.
    expect(inner().renderer.measureFont()).toEqual({ width: 8, height: 32, baseline: 20 });
    // The fit counts rows at the new height.
    term.options.lineHeight = 1;
    expect(term.cellSize()).toEqual({ width: 8, height: 16 });
  });

  it('converts the scrollback limit to the bytes the engine counts', () => {
    expect(setup().inner().created.scrollback).toBe(1000 * 1024);
  });
});

describe('GhosttyXterm - links', () => {
  it('gives an xterm link provider 1-based rows and converts its ranges', () => {
    const { term, inner } = setup();
    const provider: ILinkProvider = {
      provideLinks: vi.fn((y, callback) =>
        callback([
          {
            text: 'src/app.ts',
            range: { start: { x: 3, y }, end: { x: 12, y } },
            activate: vi.fn(),
          },
        ]),
      ),
    };
    term.registerLinkProvider(provider);
    const converted = inner().linkDetector.providers.at(-1)!;
    const got = vi.fn();
    converted.provideLinks(4, got);
    expect(provider.provideLinks).toHaveBeenCalledWith(5, expect.any(Function));
    expect(got.mock.calls[0][0][0].range).toEqual({
      start: { x: 2, y: 4 },
      end: { x: 11, y: 4 },
    });
  });

  it("drops the engine's own URL opener and routes OSC 8 links to the link handler", () => {
    const { term, inner } = setup();
    const providers = inner().linkDetector.providers;
    expect(providers).toHaveLength(1);
    expect(providers).not.toContain(inner().urls);
    const activate = vi.fn();
    term.options.linkHandler = { activate };
    vi.mocked(inner().osc8.provideLinks).mockImplementation((y, cb) =>
      cb([
        {
          text: 'https://example.com',
          range: { start: { x: 0, y }, end: { x: 9, y } },
          activate: vi.fn(),
        },
      ]),
    );
    const got = vi.fn();
    providers[0].provideLinks(2, got);
    const event = new MouseEvent('click', { metaKey: true });
    got.mock.calls[0][0][0].activate(event);
    expect(activate).toHaveBeenCalledWith(event, 'https://example.com', {
      start: { x: 1, y: 3 },
      end: { x: 10, y: 3 },
    });
  });
});

describe('GhosttyXterm - find', () => {
  const DECORATIONS = { matchBackground: '#20301a', activeMatchBorder: '#7da82f' };

  it('highlights every match on screen, the current one apart, until cleared', () => {
    const { term, inner } = setup();
    inner().lines = ['run one', 'run two', 'nothing', 'run three', ''];
    term.search.findNext('run', { decorations: DECORATIONS });
    const matches = term.element!.querySelectorAll<HTMLElement>('.ghostty-match');
    expect(matches).toHaveLength(3);
    const active = term.element!.querySelectorAll<HTMLElement>('.ghostty-match-active');
    expect(active).toHaveLength(1);
    expect(active[0].style.top).toBe('0px');
    // Translucent fills: the text under them stays readable.
    expect(matches[1].style.background).toBe('rgba(125, 168, 47, 0.25)');
    term.search.clearDecorations();
    expect(term.element!.querySelectorAll('.ghostty-match')).toHaveLength(0);
  });

  it('selects and highlights the cells a match covers, past wide and unwritten cells', () => {
    const { term, inner } = setup();
    const cell = (chars: string, width = 1) => ({ chars, width });
    inner().lines = ['', '', '', '', ''];
    // '界' takes two cells (the second is a spacer with no text); two cells
    // were never written. Text: '界a needle' - 'needle' starts at text
    // position 3 but at cell 6.
    inner().cellRows.set(1, [
      cell('界', 2),
      cell('', 0),
      cell('a'),
      cell(''),
      cell(''),
      cell(' '),
      ...[...'needle'].map((c) => cell(c)),
    ]);
    term.search.findNext('needle', { decorations: DECORATIONS });
    expect(inner().selected).toEqual([6, 1, 6]);
    const active = term.element!.querySelector<HTMLElement>('.ghostty-match-active')!;
    expect(active.style.left).toBe(`${6 * 8}px`);
    expect(active.style.width).toBe(`${6 * 8}px`);
    // A wide character matched itself covers both its cells.
    term.search.findNext('界', { decorations: DECORATIONS });
    expect(inner().selected).toEqual([0, 1, 2]);
  });

  it('counts again once output pauses, as the addon does', () => {
    vi.useFakeTimers();
    try {
      const { term, inner } = setup();
      inner().lines = ['run one', '', '', '', ''];
      const results = vi.fn();
      term.search.onDidChangeResults(results);
      term.search.findNext('run', { decorations: DECORATIONS });
      inner().lines = ['run one', 'run two', '', '', ''];
      term.write('run two\r\n');
      expect(results).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(250);
      expect(results).toHaveBeenLastCalledWith({ resultIndex: 0, resultCount: 2 });
      expect(term.element!.querySelectorAll('.ghostty-match')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects a match on the screen at its viewport row', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(14)); // scrollback 10, screen rows 10-14
    inner().lines = Array.from({ length: 15 }, (_, i) => (i === 12 ? 'needle here' : ''));
    expect(term.search.findNext('needle')).toBe(true);
    expect(inner().selected).toEqual([0, 2, 6]);
  });

  it('scrolls a match up in the scrollback to the middle of the view first', () => {
    const { term, inner } = setup();
    term.write('\n'.repeat(14));
    inner().lines = Array.from({ length: 15 }, (_, i) => (i === 3 ? 'old needle' : ''));
    term.search.findNext('needle');
    // 10 - 3 + 2 (half of 5 rows) = 9 lines up: the top row is 1, the match row 3.
    expect(inner().viewportY).toBe(9);
    expect(inner().selected).toEqual([4, 2, 6]);
  });
});
