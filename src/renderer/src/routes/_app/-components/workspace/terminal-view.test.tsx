import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from '@renderer/routes/_app/-components/workspace/terminal-view';
import { stubApi } from '@renderer/test-support';
import { applyGrid, resetSharedGridForTest } from '@renderer/lib/terminal/shared-grid';

/**
 * The view binds a pooled xterm to its container and its PTY, and the two grids
 * - the xterm's and the shell's - must come out the same on every path in.
 * What these guard is the re-adopt path (a session torn off into its own
 * window, one revisited after eviction):
 *
 * - a replay landing AFTER the tab was fitted must keep the fitted grid. The
 *   shell has just been told that grid and is repainting for it; sizing the
 *   xterm back to the shell's old grid parses that repaint on the wrong grid,
 *   and the refit afterwards leaves the grids agreeing over a screen drawn for
 *   another - the "input box mid-screen, stale rows below" state nothing ever
 *   redraws.
 * - a slot still unmeasured on its first commit (a new window's first frame)
 *   must not hand main the xterm's construction-default grid: `create` waits
 *   for the frame the pane rects land in, and fits first.
 */

const fake = vi.hoisted(() => {
  const term = {
    cols: 80,
    rows: 24,
    element: null as HTMLElement | null,
    open(container: HTMLElement) {
      this.element = document.createElement('div');
      // The drawn grid: 20 px a row (what the bottom anchor measures).
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      Object.defineProperty(screen, 'offsetHeight', { get: () => this.rows * 20 });
      this.element.appendChild(screen);
      container.appendChild(this.element);
    },
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    },
    /** Everything written to the xterm (the frame-hold escapes land here). */
    written: [] as string[],
    write(data: string, cb?: () => void) {
      // An empty write only waits for what came before it to be parsed.
      if (data) this.written.push(data);
      cb?.();
    },
    onData: () => ({ dispose: vi.fn() }),
    onResize: () => ({ dispose: vi.fn() }),
    parsedListeners: new Set<() => void>(),
    onWriteParsed(cb: () => void) {
      this.parsedListeners.add(cb);
      return { dispose: () => this.parsedListeners.delete(cb) };
    },
    focus: () => {},
    /** Text typed as a paste (a file drop's paths). */
    paste: vi.fn<(text: string) => void>(),
    modes: { synchronizedOutputMode: false },
    /** 'alternate' while a full-screen TUI owns the screen. */
    buffer: { active: { type: 'normal' as 'normal' | 'alternate' } },
  };
  /** What the container fits (whenever it has a size). */
  const fitted = { cols: 117, rows: 26 };
  const pooled = {
    term,
    fit: {
      fit: () => {
        term.cols = fitted.cols;
        term.rows = fitted.rows;
      },
      proposeDimensions: () => ({ cols: fitted.cols, rows: fitted.rows }),
    },
    opened: false,
    needsReplayRequest: true,
  };
  return { term, pooled, fitted, reconcile: vi.fn() };
});

vi.mock('@renderer/lib/terminal/pool', () => ({
  acquireTerminal: () => fake.pooled,
  getPooledTerminal: () => fake.pooled,
  attachWebglRenderer: vi.fn(),
  releaseWebglRenderer: vi.fn(),
  installAdaptiveSmoothScroll: vi.fn(),
  installPasteOverride: vi.fn(),
  reconcileTerminalGrid: (...args: unknown[]) => fake.reconcile(...args),
}));
vi.mock('@renderer/lib/terminal/restyle', () => ({
  createTerminalRestyler: () => (s: string) => s,
}));
vi.mock('@renderer/lib/terminal/activity-gate', () => ({
  noteTerminalUserInput: vi.fn(),
  suppressTerminalActivity: vi.fn(),
}));
vi.mock('@renderer/lib/session/setup', () => ({ takeOneShotCommand: () => undefined }));
/** The frame image a held resize lays over the terminal (jsdom has no canvas to copy: none by default). */
const snapshot = vi.hoisted(() => ({
  overlay: null as null | { swapOut: (onGone?: () => void) => void },
}));
vi.mock('@renderer/lib/terminal/frame-snapshot', () => ({
  captureFrame: async () => snapshot.overlay,
}));
/** The host each terminal folder reads as (none = this machine). */
const hostsOf = vi.hoisted(() => new Map<string, string>());
vi.mock('@renderer/lib/hosts/host-of-path', () => ({
  currentHostOfPath: (path: string) => hostsOf.get(path) ?? null,
}));
vi.mock('@renderer/lib/workspace/focus-regions', () => ({ isSurfaceFocusHeld: () => false }));

/** The mount container's measured size (0×0 = hidden / not laid out yet). */
const size = { w: 0, h: 0 };
type DataCb = (data: string, replaySize?: { cols: number; rows: number }) => void;
let dataCb: DataCb;
const create = vi.fn();
const resize = vi.fn();
const requestReplay = vi.fn();

beforeEach(() => {
  // Fakes requestAnimationFrame too, so the deferred create can be stepped a frame.
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.w);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.h);
  size.w = 0;
  size.h = 0;
  fake.term.cols = 80;
  fake.term.rows = 24;
  fake.term.element = null;
  fake.term.buffer.active.type = 'normal';
  snapshot.overlay = null;
  fake.term.written.length = 0;
  fake.term.parsedListeners.clear();
  fake.pooled.opened = false;
  fake.pooled.needsReplayRequest = true;
  fake.fitted.cols = 117;
  fake.fitted.rows = 26;
  fake.reconcile.mockClear();
  fake.term.paste.mockClear();
  hostsOf.clear();
  create.mockClear();
  resize.mockClear();
  requestReplay.mockClear();
  stubApi({
    terminal: {
      create,
      resize,
      requestReplay,
      write: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn((_id: string, cb: DataCb) => {
        dataCb = cb;
        return () => {};
      }),
      onExit: vi.fn(() => () => {}),
    },
    files: { pathOf: (f: File) => (f as File & { localPath?: string }).localPath ?? '' },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalView grid handling', () => {
  it('keeps the fitted grid when a replay arrives after the tab was fitted', () => {
    size.w = 836;
    size.h = 475;
    render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    // Laid out at mount: fitted and the PTY told, before the create goes out
    // with that same grid.
    expect(resize).toHaveBeenCalledWith('pty-1', 117, 26, 'passive');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pty-1', cols: 117, rows: 26 }),
    );

    dataCb('\x1b[2J', { cols: 133, rows: 35 });

    expect(fake.term.cols).toBe(117);
    expect(fake.term.rows).toBe(26);
    // The repaint check is asked for from the grid the replay was parsed on.
    expect(fake.reconcile).toHaveBeenCalledWith('pty-1', {
      repaintFrom: { cols: 117, rows: 26 },
    });
  });

  it("reveals a tab another computer sizes on that computer's grid - no pty resize, no refit (M4 review)", () => {
    resetSharedGridForTest();
    applyGrid('pty-shared', { cols: 120, rows: 40, own: false }, undefined);
    size.w = 836;
    size.h = 475;
    render(<TerminalView ptyId="pty-shared" cwd="/home/emmaw/acme" />);
    expect(resize).not.toHaveBeenCalled();
    expect(fake.term.cols).toBe(120);
    expect(fake.term.rows).toBe(40);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pty-shared', cols: 120, rows: 40 }),
    );
    resetSharedGridForTest();
  });

  it('sizes a hidden tab’s xterm to the replay’s grid before writing it', () => {
    render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    dataCb('\x1b[2J', { cols: 133, rows: 35 });

    expect(fake.term.cols).toBe(133);
    expect(fake.term.rows).toBe(35);
    expect(fake.reconcile).toHaveBeenCalledWith('pty-1', {
      repaintFrom: { cols: 133, rows: 35 },
    });
  });

  it('defers create until the slot is measured, then hands main the fitted grid', () => {
    render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    expect(create).not.toHaveBeenCalled();

    // The pane rects land before the next frame.
    size.w = 836;
    size.h = 475;
    vi.advanceTimersByTime(16);

    expect(resize).toHaveBeenCalledWith('pty-1', 117, 26, 'passive');
    expect(requestReplay).toHaveBeenCalledWith('pty-1');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pty-1', cols: 117, rows: 26 }),
    );
    // The resize went out first, so an adopt replays at the fitted grid.
    const order = resize.mock.invocationCallOrder[0];
    expect(create.mock.invocationCallOrder[0]).toBeGreaterThan(order);
  });

  it('still creates a tab that stays hidden, at the xterm’s own grid', () => {
    render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    vi.advanceTimersByTime(16);

    expect(resize).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pty-1', cols: 80, rows: 24 }),
    );
  });

  it('cancels a pending deferred create when the view unmounts first', () => {
    const view = render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    view.unmount();
    vi.advanceTimersByTime(16);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TerminalView pane resizes', () => {
  /** The view's ResizeObserver callback - fired by hand, a frame at a time. */
  let observed: (() => void) | null = null;
  beforeEach(() => {
    observed = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The pane takes a new size this frame. */
  const resizePane = async (cols: number, rows: number): Promise<void> => {
    fake.fitted.cols = cols;
    fake.fitted.rows = rows;
    observed?.();
    await vi.advanceTimersByTimeAsync(16);
  };

  const mountLaidOut = (): void => {
    size.w = 836;
    size.h = 475;
    render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    vi.advanceTimersByTime(1000);
    resize.mockClear();
  };

  it('refits at once for a one-shot resize, like a panel toggle', async () => {
    mountLaidOut();
    await resizePane(100, 26);
    expect(resize).toHaveBeenCalledWith('pty-1', 100, 26, 'passive');
  });

  it('reflows a plain shell live during a drag but resizes its PTY once, at the end', async () => {
    mountLaidOut();
    await resizePane(110, 26); // the drag's first frame refits at once
    resize.mockClear();

    await resizePane(105, 26);
    await resizePane(98, 26);
    // The xterm follows the pane every frame...
    expect(fake.term.cols).toBe(98);
    // ...while the shell is left alone until the size settles.
    expect(resize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('pty-1', 98, 26, 'passive');
  });

  it('resizes a full-screen TUI all through a drag, one held step at a time', async () => {
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    const repaint = async (): Promise<void> => {
      for (const cb of fake.term.parsedListeners) cb();
      await vi.advanceTimersByTimeAsync(40);
    };

    await resizePane(110, 26); // step 1 starts at once: refit now, the PTY a frame later under a hold
    expect(fake.term.cols).toBe(110);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenLastCalledWith('pty-1', 110, 26, 'passive');

    // More frames while step 1's repaint is in flight: the grid waits.
    await resizePane(105, 26);
    await resizePane(98, 26);
    expect(fake.term.cols).toBe(110);
    expect(resize).toHaveBeenCalledTimes(1);

    // Step 1's repaint lands: the hold lifts, xterm draws it, and only then
    // step 2 goes out - at the LATEST size.
    await repaint();
    await vi.advanceTimersByTimeAsync(32);
    expect(fake.term.cols).toBe(98);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith('pty-1', 98, 26, 'passive');

    // Nothing left to do once step 2 lands; every hold is lifted.
    await repaint();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resize).toHaveBeenCalledTimes(2);
    const starts = fake.term.written.filter((w) => w === '\x1b[?2026h').length;
    const ends = fake.term.written.filter((w) => w === '\x1b[?2026l').length;
    expect(starts).toBe(2);
    expect(ends).toBe(2);
    expect(fake.term.written.at(-1)).toBe('\x1b[?2026l');
  });

  // A refit resizes xterm's canvas, which clears it until xterm's next frame.
  // Inside a frame callback the browser paints first - the cleared canvas
  // showed as a blink on every step of a drag.
  it('never refits inside an animation frame, nor under a hold still being lifted', async () => {
    let inFrame = false;
    /** Frames drawn since the last lift - xterm draws a lift on its next frame. */
    let framesSinceLift = 0;
    const fits: Array<{
      inFrame: boolean;
      lastWrite: string | undefined;
      framesSinceLift: number;
    }> = [];
    const raf = window.requestAnimationFrame;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) =>
      raf((t) => {
        inFrame = true;
        try {
          cb(t);
        } finally {
          inFrame = false;
          framesSinceLift++;
        }
      }),
    );
    const fit = fake.pooled.fit.fit;
    fake.pooled.fit.fit = () => {
      fits.push({ inFrame, lastWrite: fake.term.written.at(-1), framesSinceLift });
      fit();
    };
    const write = fake.term.write;
    fake.term.write = function (data: string, cb?: () => void) {
      if (data === '\x1b[?2026l') framesSinceLift = 0;
      write.call(this, data, cb);
    };
    try {
      mountLaidOut();
      fits.length = 0;
      // A plain shell's live reflow...
      await resizePane(110, 26);
      await resizePane(104, 26);
      await vi.advanceTimersByTimeAsync(200);
      // ...and a full-screen TUI's held steps.
      fake.term.buffer.active.type = 'alternate';
      await resizePane(96, 26);
      await resizePane(90, 26);
      for (const cb of fake.term.parsedListeners) cb();
      await vi.advanceTimersByTimeAsync(1000);

      expect(fits.length).toBeGreaterThanOrEqual(4);
      expect(fits.every((f) => !f.inFrame)).toBe(true);
      // The TUI's second step refits only after the first hold was lifted AND
      // drawn - a refit under a hold still being lifted blanks the canvas.
      expect(fits.at(-1)?.lastWrite).toBe('\x1b[?2026l');
      expect(fits.at(-1)?.framesSinceLift).toBeGreaterThanOrEqual(1);
      expect(fake.term.cols).toBe(90);
    } finally {
      fake.pooled.fit.fit = fit;
      fake.term.write = write;
    }
  });

  it('covers a full-screen TUI resize with a frame image until the repaint is drawn', async () => {
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    const events: string[] = [];
    // The cut happens in xterm's next render - a frame after it is asked for.
    snapshot.overlay = {
      swapOut: (onGone) => {
        events.push('cut');
        setTimeout(() => onGone?.(), 16);
      },
    };
    const write = fake.term.write;
    fake.term.write = function (data: string, cb?: () => void) {
      if (data) {
        events.push(data === '\x1b[?2026h' ? 'hold' : data === '\x1b[?2026l' ? 'lift' : 'write');
      }
      write.call(this, data, cb);
    };
    try {
      await resizePane(100, 26);
      // Under the image: refit, held, the PTY told - no frame of the old
      // screen at the new size is waited for.
      expect(fake.term.cols).toBe(100);
      expect(resize).toHaveBeenCalledWith('pty-1', 100, 26, 'passive');
      expect(events).toEqual(['hold']);

      // The repaint lands: the hold lifts, and the image is cut away in the
      // frame xterm draws it in - never faded over it (two layouts of the
      // same text faded together read doubled).
      for (const cb of fake.term.parsedListeners) cb();
      await vi.advanceTimersByTimeAsync(40);
      expect(events).toEqual(['hold', 'lift', 'cut']);
      // The next step may refit only once the image is gone.
      await resizePane(90, 26);
      expect(resize).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40);
      expect(resize).toHaveBeenLastCalledWith('pty-1', 90, 26, 'passive');
      // Let that step's repaint land too: no hold outlives the test.
      for (const cb of fake.term.parsedListeners) cb();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fake.term.written.at(-1)).toBe('\x1b[?2026l');
    } finally {
      fake.term.write = write;
      snapshot.overlay = null;
    }
  });

  it('keeps a TUI’s old frame on the pane’s new bottom edge until the refit, from the very frame', async () => {
    // An agent draws from the bottom (input box, status line). Opening a dock
    // under it clipped that bottom away until the program repainted.
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    const element = fake.term.element!;
    const container = element.parentElement!;

    // The pane loses 6 rows: in the observer callback itself - before the
    // browser paints that frame - the frame moves up by 6 rows of 20 px.
    fake.fitted.rows = 20;
    observed?.();
    expect(element.style.transform).toBe('translateY(-120px)');
    // `inset(0)` as the style reads it back (jsdom 31 serializes like a browser).
    expect(container.style.clipPath).toBe('inset(0px)');
    // The refit (after the paint) lays the grid out from the top again.
    await vi.advanceTimersByTimeAsync(16);
    expect(fake.term.rows).toBe(20);
    expect(element.style.transform).toBe('');
    expect(container.style.clipPath).toBe('');
    for (const cb of fake.term.parsedListeners) cb();
    await vi.advanceTimersByTimeAsync(1000);

    // Growing: the frame moves down onto the new bottom edge.
    fake.fitted.rows = 24;
    observed?.();
    expect(element.style.transform).toBe('translateY(80px)');

    // A plain shell is never shifted.
    for (const cb of fake.term.parsedListeners) cb();
    await vi.advanceTimersByTimeAsync(1000);
    fake.term.buffer.active.type = 'normal';
    fake.fitted.rows = 30;
    observed?.();
    expect(element.style.transform).toBe('');
  });

  it('waits for the program’s own repaint: the parse of our hold write is not it', async () => {
    // xterm reports each parsed write - our hold's too. Counted from that, a
    // program slower than the 40 ms quiet window had its half-drawn screen
    // shown, the very state the hold is there to hide.
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    const write = fake.term.write;
    fake.term.write = function (data: string, cb?: () => void) {
      // As xterm: parsed in a later task, then the callbacks, then the event.
      setTimeout(() => {
        write.call(this, data, cb);
        for (const listener of this.parsedListeners) listener();
      }, 0);
    };
    try {
      await resizePane(100, 26);
      expect(resize).toHaveBeenCalledWith('pty-1', 100, 26, 'passive');
      // The program is still drawing: no output yet, 100 ms in - still held.
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.term.written).toEqual(['\x1b[?2026h']);
      // Its repaint arrives; once it pauses, the hold lifts.
      for (const listener of fake.term.parsedListeners) listener();
      await vi.advanceTimersByTimeAsync(41);
      expect(fake.term.written).toEqual(['\x1b[?2026h', '\x1b[?2026l']);
    } finally {
      fake.term.write = write;
    }
  });

  it('leaves a full-screen TUI alone for a frame that stays inside the same cell grid', async () => {
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    await resizePane(117, 26); // the fitted grid is unchanged (a sub-cell move)
    await vi.advanceTimersByTimeAsync(1000);
    expect(resize).not.toHaveBeenCalled();
    expect(fake.term.written).toEqual([]);
  });

  it('swaps a full-screen TUI repaint in whole once it pauses', async () => {
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    await resizePane(100, 26);
    // The xterm refits and draws the old screen at the new size, then a frame
    // later holds it and tells the PTY.
    expect(fake.term.cols).toBe(100);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledWith('pty-1', 100, 26, 'passive');
    expect(fake.term.written).toEqual(['\x1b[?2026h']);

    // The program repaints; once its output pauses, the hold lifts.
    for (const cb of fake.term.parsedListeners) cb();
    await vi.advanceTimersByTimeAsync(39);
    expect(fake.term.written).toEqual(['\x1b[?2026h']);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.term.written).toEqual(['\x1b[?2026h', '\x1b[?2026l']);
  });

  it('lifts the hold even when the program draws nothing for the resize', async () => {
    mountLaidOut();
    fake.term.buffer.active.type = 'alternate';
    await resizePane(100, 26);
    await vi.advanceTimersByTimeAsync(16);
    expect(fake.term.written).toEqual(['\x1b[?2026h']);
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.term.written).toEqual(['\x1b[?2026h', '\x1b[?2026l']);
  });
});

describe('TerminalView file drops', () => {
  /** A drag's `dataTransfer` as jsdom lacks one: its types, data and files. */
  const transfer = (data: Record<string, string>, files: string[] = []) => {
    const list = files.map((p) => Object.assign(new File([''], 'f'), { localPath: p }));
    return {
      types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
      getData: (t: string) => data[t] ?? '',
      files: list,
      dropEffect: 'none',
    };
  };
  const explorer = (hostId: string | null, paths: string[]) => ({
    'application/x-double0-explorer-paths': JSON.stringify({ hostId, paths }),
    'text/plain': paths[0],
  });
  const target = (container: HTMLElement): HTMLElement =>
    container.firstElementChild as HTMLElement;

  it('types the quoted paths of files dropped from the OS, as a paste', () => {
    const { container, queryByTestId } = render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    const dt = transfer({}, ['/Users/emmaw/My Shot.png', '/Users/emmaw/notes.md']);
    fireEvent.dragOver(target(container), { dataTransfer: dt });
    // The drop target shows while the drag hovers, then goes with the drop.
    expect(queryByTestId('terminal-drop-target')).not.toBeNull();
    fireEvent.drop(target(container), { dataTransfer: dt });
    expect(fake.term.paste).toHaveBeenCalledWith(
      '/Users/emmaw/My\\ Shot.png /Users/emmaw/notes.md ',
    );
    expect(queryByTestId('terminal-drop-target')).toBeNull();
  });

  it('types the path of a row dragged out of the explorer', () => {
    const { container } = render(<TerminalView ptyId="pty-1" cwd="/repo" />);
    fireEvent.drop(target(container), {
      dataTransfer: transfer(explorer(null, ['/repo/src/a.ts'])),
    });
    expect(fake.term.paste).toHaveBeenCalledWith('/repo/src/a.ts ');
  });

  it("refuses OS files and another machine's explorer paths on a host's terminal", () => {
    hostsOf.set('/srv/acme', 'h1');
    const { container, queryByTestId } = render(<TerminalView ptyId="pty-1" cwd="/srv/acme" />);
    const os = transfer({}, ['/Users/emmaw/a.png']);
    fireEvent.dragOver(target(container), { dataTransfer: os });
    expect(queryByTestId('terminal-drop-target')).toBeNull();
    fireEvent.drop(target(container), { dataTransfer: os });
    fireEvent.drop(target(container), { dataTransfer: transfer(explorer(null, ['/repo/a.ts'])) });
    expect(fake.term.paste).not.toHaveBeenCalled();

    // The host's own explorer paths do land.
    fireEvent.drop(target(container), {
      dataTransfer: transfer(explorer('h1', ['/srv/acme/a.ts'])),
    });
    expect(fake.term.paste).toHaveBeenCalledWith('/srv/acme/a.ts ');
  });
});
