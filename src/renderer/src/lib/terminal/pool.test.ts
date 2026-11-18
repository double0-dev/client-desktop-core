import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireTerminal,
  attachWebglRenderer,
  disposePooledTerminal,
  getPooledTerminal,
  installAdaptiveSmoothScroll,
  pooledTerminalTexts,
  reconcileTerminalGrid,
  releaseWebglRenderer,
  type PooledTerminal,
} from '@renderer/lib/terminal/pool';
import { THEME_STORAGE_KEY, emitThemeChange } from '@renderer/lib/settings/theme';
import { getTerminalFind } from '@renderer/lib/terminal/find';
import { applyGrid, noteTerminalInteraction } from '@renderer/lib/terminal/shared-grid';

// `isWindows` is read off the user agent at import; a getter lets a test flip it.
const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('@renderer/lib/settings/keyboard-shortcuts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get isWindows() {
    return platform.windows;
  },
}));

/**
 * The pool keeps one xterm instance per PTY alive across tab switches, pane
 * moves and StrictMode remounts - losing identity here means a terminal that
 * blanks or re-scrolls whenever the UI re-renders. Real xterm instances are
 * used (never `open()`ed, so no rendering is needed); only the preload bridge
 * is stubbed.
 */

let write: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  write = vi.fn();
  dispose = vi.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { terminal: { write, dispose, resize: vi.fn() } },
  });
});

/** A unique pty id per test, so pool state cannot leak between them. */
let n = 0;
const ptyId = (): string => `pty-${++n}`;

describe('pooledTerminalTexts', () => {
  // The demo seeder's identity scan reads terminals through this: a canvas
  // shows nothing in the DOM, so a path printed in a shell would slip past.
  it("returns each terminal's buffer as text, keyed by pty id", async () => {
    const a = ptyId();
    const b = ptyId();
    await new Promise<void>((r) =>
      acquireTerminal(a).term.write('cwd: /Users/Shared/acme\r\nready', r),
    );
    await new Promise<void>((r) => acquireTerminal(b).term.write('$ ls', r));
    const texts = pooledTerminalTexts();
    expect(texts[a]).toContain('cwd: /Users/Shared/acme\nready');
    expect(texts[b]).toContain('$ ls');
  });
});

describe('pool identity', () => {
  it('hands back the same instance for the same pty', () => {
    const id = ptyId();
    expect(acquireTerminal(id)).toBe(acquireTerminal(id));
  });

  it('keeps separate terminals for separate ptys', () => {
    const a = acquireTerminal(ptyId());
    const b = acquireTerminal(ptyId());
    expect(a).not.toBe(b);
    expect(a.term).not.toBe(b.term);
  });

  it('exposes an acquired terminal through the lookup', () => {
    const id = ptyId();
    const pooled = acquireTerminal(id);
    expect(getPooledTerminal(id)).toBe(pooled);
  });

  it('reports nothing for a pty that was never acquired', () => {
    expect(getPooledTerminal('never-acquired')).toBeUndefined();
  });

  it('starts a fresh terminal unopened and waiting for a replay', () => {
    // Both flags drive the re-attach path: a fresh xterm must ask main to
    // replay the pty's scrollback or the tab renders blank.
    const pooled = acquireTerminal(ptyId());
    expect(pooled.opened).toBe(false);
    expect(pooled.needsReplayRequest).toBe(true);
  });

  it('applies the stored terminal settings to a new instance', () => {
    const pooled = acquireTerminal(ptyId());
    expect(pooled.term.options.fontSize).toBeGreaterThan(0);
    expect(pooled.term.options.scrollback).toBeGreaterThan(0);
    expect(pooled.term.options.theme).toBeDefined();
  });
});

describe('disposePooledTerminal', () => {
  it('evicts the terminal and kills the pty by default', () => {
    const id = ptyId();
    acquireTerminal(id);
    disposePooledTerminal(id);
    expect(getPooledTerminal(id)).toBeUndefined();
    expect(dispose).toHaveBeenCalledWith(id);
  });

  it('keeps the shell alive when the tab is moving to another window', () => {
    // A tear-off must not kill the pty - the new window adopts it.
    const id = ptyId();
    acquireTerminal(id);
    disposePooledTerminal(id, false);
    expect(getPooledTerminal(id)).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('is safe to call for a pty that was never pooled', () => {
    expect(() => disposePooledTerminal('never-acquired')).not.toThrow();
  });

  it('lets the same pty be acquired again afterwards', () => {
    const id = ptyId();
    const first = acquireTerminal(id);
    disposePooledTerminal(id);
    expect(acquireTerminal(id)).not.toBe(first);
  });
});

describe('WebGL renderer retention across hides', () => {
  // Detaching the GPU renderer the moment a tab hides destroys its canvas -
  // the only thing that can paint the reveal frame while xterm's render
  // service is still paused - which is the tab-switch blink. Hidden terminals
  // must KEEP their renderer (and its last frame) until the context cap forces
  // the least-recently-shown ones to give theirs up.

  /** Plant a fake attached GPU renderer - a real WebglAddon needs a GPU
   * context jsdom doesn't have; only `dispose` (the eviction path) matters. */
  const plantWebgl = (pooled: PooledTerminal): ReturnType<typeof vi.fn> => {
    const disposeAddon = vi.fn();
    pooled.webgl = { dispose: disposeAddon } as unknown as PooledTerminal['webgl'];
    return disposeAddon;
  };

  it('keeps the renderer - and its last frame - on a hidden terminal', () => {
    const id = ptyId();
    const pooled = acquireTerminal(id);
    const addonDispose = plantWebgl(pooled);
    const addon = pooled.webgl;
    attachWebglRenderer(pooled);
    releaseWebglRenderer(pooled);
    expect(pooled.webgl).toBe(addon);
    expect(addonDispose).not.toHaveBeenCalled();
    // Re-shown: the same renderer instance (same canvas bitmap) is reused.
    attachWebglRenderer(pooled);
    expect(pooled.webgl).toBe(addon);
    disposePooledTerminal(id);
  });

  it('evicts only the least-recently-shown hidden renderers once past the cap', () => {
    const ids = Array.from({ length: 10 }, () => ptyId());
    const terminals = ids.map((id) => acquireTerminal(id));
    // Six tabs shown then hidden, oldest first: all six retain their renderer
    // (six contexts is under the cap of eight).
    const disposes = terminals.map((pooled, i) => {
      const d = plantWebgl(pooled);
      attachWebglRenderer(pooled);
      if (i < 6) releaseWebglRenderer(pooled);
      return d;
    });
    // Four more shown (and kept visible) pushed the pool to ten contexts: the
    // two oldest hidden ones give theirs up, the four fresher hidden ones keep
    // their frames, and visible terminals are never evicted.
    expect(terminals[0].webgl).toBeUndefined();
    expect(terminals[1].webgl).toBeUndefined();
    expect(disposes[0]).toHaveBeenCalledOnce();
    expect(disposes[1]).toHaveBeenCalledOnce();
    for (let i = 2; i < 10; i++) {
      expect(terminals[i].webgl).toBeDefined();
      expect(disposes[i]).not.toHaveBeenCalled();
    }
    ids.forEach((id) => disposePooledTerminal(id));
  });
});

describe('Shift+Enter sends a newline instead of submitting', () => {
  // A PTY cannot tell Shift+Enter from Enter (xterm emits \r for both), so the
  // pool intercepts it and writes a lone \n - the convention TUIs like Claude
  // Code read as "new line", not "run it".
  /** Capture the handler the pool registers, through xterm's public API. */
  const handlerFor = (id: string): ((e: KeyboardEvent) => boolean) => {
    let captured: ((e: KeyboardEvent) => boolean) | undefined;
    const spy = vi
      .spyOn(Terminal.prototype, 'attachCustomKeyEventHandler')
      .mockImplementation(function (handler: (e: KeyboardEvent) => boolean) {
        captured = handler;
      });
    acquireTerminal(id);
    spy.mockRestore();
    expect(typeof captured, 'the pool no longer installs a key handler').toBe('function');
    return captured!;
  };

  const key = (init: Partial<KeyboardEvent> & { key: string; type: string }): KeyboardEvent =>
    ({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...init }) as KeyboardEvent;

  it('writes a line feed and suppresses xterm’s carriage return', () => {
    const id = ptyId();
    const handle = handlerFor(id);
    expect(handle(key({ key: 'Enter', type: 'keydown', shiftKey: true }))).toBe(false);
    expect(write).toHaveBeenCalledWith(id, '\n');
  });

  it('suppresses the keyup half too, without writing twice', () => {
    // Returning true for keyup would let xterm emit its own \r after ours.
    const id = ptyId();
    const handle = handlerFor(id);
    handle(key({ key: 'Enter', type: 'keydown', shiftKey: true }));
    expect(handle(key({ key: 'Enter', type: 'keyup', shiftKey: true }))).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain Enter to xterm', () => {
    const handle = handlerFor(ptyId());
    expect(handle(key({ key: 'Enter', type: 'keydown' }))).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves other modifier combinations alone', () => {
    const handle = handlerFor(ptyId());
    for (const mod of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(handle(key({ key: 'Enter', type: 'keydown', shiftKey: true, [mod]: true }))).toBe(
        true,
      );
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves other keys alone', () => {
    const handle = handlerFor(ptyId());
    expect(handle(key({ key: 'a', type: 'keydown', shiftKey: true }))).toBe(true);
  });
});

describe('find in terminal', () => {
  // The terminal's own key handler owns the find key, so it opens the bar of
  // the terminal that has focus (a torn-off window included) and the key
  // never reaches the shell. jsdom is not a Mac: the primary modifier is Ctrl.
  const handlerFor = (id: string): ((e: KeyboardEvent) => boolean) => {
    let captured: ((e: KeyboardEvent) => boolean) | undefined;
    const spy = vi
      .spyOn(Terminal.prototype, 'attachCustomKeyEventHandler')
      .mockImplementation(function (handler: (e: KeyboardEvent) => boolean) {
        captured = handler;
      });
    acquireTerminal(id);
    spy.mockRestore();
    return captured!;
  };

  // jsdom is not a Mac: find is Ctrl+Shift+F there (Ctrl+F stays the shell's).
  const findKey = (type: string): KeyboardEvent =>
    ({
      type,
      key: 'F',
      code: 'KeyF',
      shiftKey: true,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
    }) as unknown as KeyboardEvent;

  it('opens the find bar seeded with the selection and keeps the key from the shell', () => {
    const id = ptyId();
    const handle = handlerFor(id);
    vi.spyOn(getPooledTerminal(id)!.term, 'getSelection').mockReturnValue('refreshToken');
    expect(handle(findKey('keydown'))).toBe(false);
    expect(getTerminalFind(id)?.seed).toBe('refreshToken');
    expect(write).not.toHaveBeenCalled();
    disposePooledTerminal(id);
  });

  it('swallows the keyup half without opening a second time', () => {
    const id = ptyId();
    const handle = handlerFor(id);
    handle(findKey('keydown'));
    const first = getTerminalFind(id)?.nonce;
    expect(handle(findKey('keyup'))).toBe(false);
    expect(getTerminalFind(id)?.nonce).toBe(first);
    disposePooledTerminal(id);
  });

  it('closes the bar when the terminal is disposed', () => {
    // A tab closed (or moved to another window) with its bar open must not
    // leave a stale open entry for the id.
    const id = ptyId();
    handlerFor(id)(findKey('keydown'));
    expect(getTerminalFind(id)).toBeDefined();
    disposePooledTerminal(id);
    expect(getTerminalFind(id)).toBeUndefined();
  });

  it('loads the search addon on every pooled terminal', () => {
    const id = ptyId();
    expect(typeof acquireTerminal(id).search.findNext).toBe('function');
    disposePooledTerminal(id);
  });
});

describe('installAdaptiveSmoothScroll', () => {
  /** Give the pooled terminal an element to listen on (xterm sets this on open). */
  const withElement = (pooled: ReturnType<typeof acquireTerminal>): HTMLElement => {
    const el = document.createElement('div');
    Object.defineProperty(pooled.term, 'element', { configurable: true, value: el });
    document.body.appendChild(el);
    return el;
  };

  const wheel = (deltaMode: number): WheelEvent =>
    new WheelEvent('wheel', { deltaMode, bubbles: true });

  it('turns the tween off for pixel-precise (trackpad) scrolling', () => {
    // Animating on top of the trackpad's own momentum makes content chase the
    // fingers and settle late.
    const pooled = acquireTerminal(ptyId());
    const el = withElement(pooled);
    installAdaptiveSmoothScroll(pooled);

    el.dispatchEvent(wheel(WheelEvent.DOM_DELTA_PIXEL));
    expect(pooled.term.options.smoothScrollDuration).toBe(0);
  });

  it('restores the glide for a wheel mouse’s line notches', () => {
    const pooled = acquireTerminal(ptyId());
    const el = withElement(pooled);
    installAdaptiveSmoothScroll(pooled);

    el.dispatchEvent(wheel(WheelEvent.DOM_DELTA_PIXEL));
    el.dispatchEvent(wheel(WheelEvent.DOM_DELTA_LINE));
    expect(pooled.term.options.smoothScrollDuration).toBeGreaterThan(0);
  });

  it('installs only once per terminal', () => {
    const pooled = acquireTerminal(ptyId());
    const el = withElement(pooled);
    const addEventListener = vi.spyOn(el, 'addEventListener');
    installAdaptiveSmoothScroll(pooled);
    installAdaptiveSmoothScroll(pooled);
    expect(addEventListener).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the terminal has an element', () => {
    const pooled = acquireTerminal(ptyId());
    expect(() => installAdaptiveSmoothScroll(pooled)).not.toThrow();
    expect(pooled.adaptiveScroll).toBeFalsy();
  });
});

describe('reconcileTerminalGrid', () => {
  /**
   * The xterm↔PTY grid invariant, healed by a rows−1 → rows resize pair (two
   * real SIGWINCHes, so the TUI repaints every row). What these guard is the
   * re-adopt path: a replay parsed on the shell's OLD grid, refit to the
   * container, leaves the two grids agreeing while the screen still shows a
   * frame drawn for the other one - nothing would ever redraw it. And a
   * reconcile must not mistake its own jiggle, or a stale answer, for a
   * divergence and start another.
   */
  let resize: ReturnType<typeof vi.fn>;
  let size: ReturnType<typeof vi.fn>;

  /** An "opened" pooled terminal in a laid-out container, with a grid the test controls. */
  function openedTerminal(id: string, cols: number, rows: number) {
    const pooled = acquireTerminal(id);
    pooled.opened = true;
    const container = document.createElement('div');
    const element = document.createElement('div');
    container.appendChild(element);
    const box = { w: 836, h: 475 };
    Object.defineProperty(container, 'clientWidth', { get: () => box.w });
    Object.defineProperty(container, 'clientHeight', { get: () => box.h });
    Object.defineProperty(pooled.term, 'element', { value: element, configurable: true });
    const grid = { cols, rows };
    Object.defineProperty(pooled.term, 'cols', { get: () => grid.cols, configurable: true });
    Object.defineProperty(pooled.term, 'rows', { get: () => grid.rows, configurable: true });
    // What the container fits - the same grid unless a test moves it.
    const fitted = { cols, rows };
    vi.spyOn(pooled.fit, 'fit').mockImplementation(() => {
      grid.cols = fitted.cols;
      grid.rows = fitted.rows;
    });
    return { pooled, grid, fitted, box };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resize = vi.fn();
    size = vi.fn(async () => null);
    window.api = { terminal: { write, dispose, resize, size } } as never;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repaints when the content was parsed on another grid, even though the PTY already agrees', async () => {
    const id = ptyId();
    openedTerminal(id, 117, 26);
    size.mockResolvedValue({ cols: 117, rows: 26 });

    reconcileTerminalGrid(id, { repaintFrom: { cols: 133, rows: 35 } });

    expect(resize).toHaveBeenCalledWith(id, 117, 25, 'passive');
    // The jiggle's restore pushes the live grid itself - nothing to ask main.
    expect(size).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    expect(resize).toHaveBeenLastCalledWith(id, 117, 26, 'passive');
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('never refits, asks or jiggles a terminal another computer sizes - it keeps that grid (M4 review)', async () => {
    const id = ptyId();
    const { pooled } = openedTerminal(id, 117, 26);
    const termResize = vi.spyOn(pooled.term, 'resize').mockImplementation(() => undefined);
    applyGrid(id, { cols: 120, rows: 40, own: false }, undefined);
    size.mockResolvedValue({ cols: 120, rows: 40 });
    // A reveal / focus / drop reconcile, even one that wants a repaint.
    reconcileTerminalGrid(id, { repaintFrom: { cols: 133, rows: 35 } });
    reconcileTerminalGrid(id);
    await vi.advanceTimersByTimeAsync(200);
    expect(resize).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
    expect(pooled.fit.fit).not.toHaveBeenCalled();
    expect(termResize).toHaveBeenCalledWith(120, 40);
    // Once the user typed there it is a claim: the reconcile refits as always.
    noteTerminalInteraction(id);
    reconcileTerminalGrid(id, { repaintFrom: { cols: 133, rows: 35 } });
    expect(resize).toHaveBeenCalledWith(id, 117, 25, 'claim');
  });

  it('leaves a terminal alone when the PTY agrees and the content was parsed on this grid', async () => {
    const id = ptyId();
    openedTerminal(id, 117, 26);
    size.mockResolvedValue({ cols: 117, rows: 26 });

    reconcileTerminalGrid(id, { repaintFrom: { cols: 117, rows: 26 } });
    await vi.advanceTimersByTimeAsync(100);

    expect(size).toHaveBeenCalledWith(id);
    expect(resize).not.toHaveBeenCalled();
  });

  it('pushes a grid its refit moved straight to the PTY - one resize, nothing asked', async () => {
    // A tab revealed after its pane changed size while it was hidden: the
    // refit moves the grid. Asked instead, main answered with the old size
    // (the reveal's own push was still behind the query) and the "divergence"
    // was jiggled - three SIGWINCHes, three repaints, for one tab switch.
    const id = ptyId();
    const { fitted } = openedTerminal(id, 117, 26);
    fitted.rows = 20;
    size.mockResolvedValue({ cols: 117, rows: 26 });

    reconcileTerminalGrid(id);
    await vi.advanceTimersByTimeAsync(200);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(id, 117, 20, 'passive');
    expect(size).not.toHaveBeenCalled();
  });

  it('resyncs a diverged PTY to the xterm’s grid with a repaint pair', async () => {
    const id = ptyId();
    openedTerminal(id, 117, 26);
    size.mockResolvedValue({ cols: 133, rows: 35 });

    reconcileTerminalGrid(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledWith(id, 117, 25, 'passive');
    await vi.advanceTimersByTimeAsync(80);
    expect(resize).toHaveBeenLastCalledWith(id, 117, 26, 'passive');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('ignores a size answer for a grid the xterm has since left', async () => {
    const id = ptyId();
    const { grid, fitted } = openedTerminal(id, 117, 26);
    let answer!: (s: { cols: number; rows: number }) => void;
    size.mockImplementation(() => new Promise((r) => (answer = r)));

    reconcileTerminalGrid(id);
    // A refit lands (the window grew) while main is still answering; that refit
    // pushed its own resize, so the answer describes a grid nobody has anymore.
    fitted.cols = grid.cols = 188;
    fitted.rows = grid.rows = 49;
    answer({ cols: 133, rows: 35 });
    await vi.advanceTimersByTimeAsync(100);

    expect(resize).not.toHaveBeenCalled();
  });

  it('does not stack a second jiggle on one that is mid-flight', async () => {
    const id = ptyId();
    openedTerminal(id, 117, 26);
    reconcileTerminalGrid(id, { repaintFrom: { cols: 133, rows: 35 } });
    expect(resize).toHaveBeenCalledTimes(1);

    // Mid-jiggle the PTY really is one row short - that must not read as a
    // divergence that starts another jiggle (and another, and another).
    size.mockResolvedValue({ cols: 117, rows: 25 });
    reconcileTerminalGrid(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(size).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(80);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith(id, 117, 26, 'passive');
  });

  it('skips a tab that is not laid out - its reveal refits', () => {
    const id = ptyId();
    const { box } = openedTerminal(id, 117, 26);
    box.w = 0;
    box.h = 0;

    reconcileTerminalGrid(id, { repaintFrom: { cols: 133, rows: 35 } });

    expect(resize).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
  });
});

describe('tone reports', () => {
  it('tells main about every light/dark flip, once per flip', () => {
    // Main turns each report into the colour-scheme push (DECSET 2031) that
    // makes Claude Code re-detect its palette - xterm never sends one, so an
    // app flip left CC painting the old tone's colours on the new background.
    const setTone = vi.fn();
    Object.assign(window.api!.terminal, { setTone });
    // A flip schedules the jiggle's restore; left on a real timer it fires
    // after the environment is torn down ("window is not defined").
    vi.useFakeTimers();
    try {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      emitThemeChange('light');
      expect(setTone.mock.calls).toEqual([[false]]);
      // The same tone again (another listener, a settings save) is no flip.
      emitThemeChange('light');
      expect(setTone.mock.calls).toEqual([[false]]);
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      emitThemeChange('dark');
      expect(setTone.mock.calls).toEqual([[false], [true]]);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  });
});

describe('light terminal pointer', () => {
  const marked = (): boolean =>
    document.documentElement.hasAttribute('data-terminal-light-pointer');

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    platform.windows = false;
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-terminal-light-pointer');
  });

  it('swaps in the outlined I-beam on Windows while the terminal is light', () => {
    // Windows' inverting I-beam vanished over a light terminal's canvas.
    platform.windows = true;
    vi.useFakeTimers();
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    emitThemeChange('light');
    expect(marked()).toBe(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    emitThemeChange('dark');
    expect(marked()).toBe(false);
  });

  it('keeps the system I-beam on other platforms', () => {
    vi.useFakeTimers();
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    emitThemeChange('light');
    expect(marked()).toBe(false);
  });
});
