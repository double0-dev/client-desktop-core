import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWhenInputIdle } from '@renderer/lib/run-when-input-idle';

/**
 * The Monaco warmup is one long task (~400 ms): started by an idle callback
 * alone it landed on whatever the user did next - a dock opened during it
 * froze. It now also waits for a pause in the user's input.
 */

type IdleCb = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void;
let idleQueue: Array<{ cb: IdleCb; id: number }> = [];
let nextId = 1;
const opts = { delayMs: 3000, inputIdleMs: 2000, idleTimeoutMs: 10000 };

/** The thread goes idle: run what waits for it. */
const goIdle = (didTimeout = false): void => {
  const queued = idleQueue;
  idleQueue = [];
  for (const { cb } of queued) cb({ didTimeout, timeRemaining: () => 50 });
};
const press = (): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
};

beforeEach(() => {
  vi.useFakeTimers();
  idleQueue = [];
  vi.stubGlobal('requestIdleCallback', (cb: IdleCb) => {
    const id = nextId++;
    idleQueue.push({ cb, id });
    return id;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => {
    idleQueue = idleQueue.filter((q) => q.id !== id);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runWhenInputIdle', () => {
  it('runs after the delay once the thread is idle, when nobody is typing', () => {
    const run = vi.fn();
    runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(2999);
    expect(idleQueue).toHaveLength(0);
    vi.advanceTimersByTime(1);
    goIdle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('waits out the user: input keeps pushing it back until it pauses', () => {
    const run = vi.fn();
    runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(2500);
    press(); // the user is busy as the delay ends
    vi.advanceTimersByTime(500);
    expect(idleQueue).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    press();
    vi.advanceTimersByTime(1999);
    goIdle();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    goIdle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('checks again when the idle callback comes: input while it waited sends it back', () => {
    const run = vi.fn();
    runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(3000);
    expect(idleQueue).toHaveLength(1);
    press();
    goIdle();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    goIdle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('treats a window being resized as the user being busy', () => {
    // Dragging the window's edge sends no key or pointer event to the page.
    const run = vi.fn();
    runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(2500);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(500);
    goIdle();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    goIdle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('runs anyway once the idle wait times out - it does happen eventually', () => {
    const run = vi.fn();
    runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(3000);
    press();
    goIdle(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('cancels cleanly: nothing runs and no listener is left behind', () => {
    const run = vi.fn();
    const remove = vi.spyOn(window, 'removeEventListener');
    const cancel = runWhenInputIdle(run, opts);
    vi.advanceTimersByTime(3000);
    cancel();
    goIdle();
    vi.advanceTimersByTime(20000);
    expect(run).not.toHaveBeenCalled();
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
      'keydown',
      'pointerdown',
      'resize',
      'wheel',
    ]);
  });
});
