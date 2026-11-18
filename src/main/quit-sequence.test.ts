import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWillQuitHandler, type QuitSequenceOptions } from './quit-sequence';

function setup(overrides: Partial<QuitSequenceOptions> = {}) {
  const deferred: Array<() => void> = [];
  const opts = {
    dispose: vi.fn(),
    closeDb: vi.fn(async () => {}),
    requestQuit: vi.fn(),
    defer: (fn: () => void) => void deferred.push(fn),
    onError: vi.fn(),
    ...overrides,
  };
  const handler = createWillQuitHandler(opts);
  const event = () => ({ preventDefault: vi.fn() });
  return { handler, opts, deferred, event };
}

/** Let every pending promise continuation run, without touching timers. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => queueMicrotask(r));
}

const nextMacrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.useRealTimers();
});

describe('createWillQuitHandler', () => {
  it('holds the first will-quit, tears down, closes the DB, then re-asks on a later macrotask', async () => {
    const { handler, opts, deferred, event } = setup();
    const first = event();

    handler(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(opts.dispose).toHaveBeenCalledTimes(1);
    expect(opts.closeDb).toHaveBeenCalledTimes(1);
    expect(handler.phase).toBe('closing');

    await drainMicrotasks();
    // The DB close has resolved and the quit is scheduled - but NOT issued yet.
    // Issuing it here, inside the microtask drain of the will-quit emit, is the
    // bug: Electron's quitting flag is still set for a natively started quit
    // (Dock Quit) and app.quit() is dropped, leaving a windowless zombie.
    expect(handler.phase).toBe('closed');
    expect(deferred).toHaveLength(1);
    expect(opts.requestQuit).not.toHaveBeenCalled();

    deferred[0]!();
    expect(opts.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('lets the will-quit that follows the re-issued quit through untouched', async () => {
    const { handler, opts, deferred, event } = setup();
    handler(event());
    await drainMicrotasks();
    deferred[0]!();

    const second = event();
    handler(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(opts.dispose).toHaveBeenCalledTimes(1);
    expect(opts.closeDb).toHaveBeenCalledTimes(1);
  });

  it('holds a will-quit that arrives mid-close without repeating the teardown', async () => {
    const { handler, opts, deferred, event } = setup();
    const first = event();
    const second = event();

    handler(first);
    handler(second);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(opts.dispose).toHaveBeenCalledTimes(1);
    expect(opts.closeDb).toHaveBeenCalledTimes(1);

    await drainMicrotasks();
    expect(deferred).toHaveLength(1);
  });

  it('schedules the re-issued quit on a macrotask by default, never in the microtask drain', async () => {
    const { handler, opts, event } = setup({ defer: undefined });
    handler(event());

    await drainMicrotasks();
    expect(opts.requestQuit).not.toHaveBeenCalled();

    await nextMacrotask();
    expect(opts.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('caps a hung DB close so the quit still happens', async () => {
    vi.useFakeTimers();
    const { handler, deferred, event } = setup({
      closeDb: () => new Promise<void>(() => {}),
      closeTimeoutMs: 2000,
    });
    handler(event());

    await vi.advanceTimersByTimeAsync(1999);
    expect(deferred).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.phase).toBe('closed');
    expect(deferred).toHaveLength(1);
  });

  it('waits for the promise the disposer returns before re-asking', async () => {
    // Terminals: the killed shells must report their exit before Node tears
    // down, or node-pty's late exit callback aborts the app (crash report 149155736).
    let shellsGone!: () => void;
    const { handler, deferred, event } = setup({
      dispose: vi.fn(() => new Promise<void>((r) => (shellsGone = r))),
    });
    handler(event());

    await drainMicrotasks();
    expect(handler.phase).toBe('closing');
    expect(deferred).toHaveLength(0);

    shellsGone();
    await drainMicrotasks();
    expect(handler.phase).toBe('closed');
    expect(deferred).toHaveLength(1);
  });

  it('caps a disposer promise that never settles', async () => {
    vi.useFakeTimers();
    const { handler, deferred, event } = setup({
      dispose: vi.fn(() => new Promise<void>(() => {})),
      closeTimeoutMs: 2000,
    });
    handler(event());

    await vi.advanceTimersByTimeAsync(1999);
    expect(deferred).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(deferred).toHaveLength(1);
  });

  it('reports a rejected disposer promise and still re-asks', async () => {
    const boom = new Error('kill failed');
    const { handler, opts, deferred, event } = setup({
      dispose: vi.fn(() => Promise.reject(boom)),
    });
    handler(event());

    await drainMicrotasks();
    expect(opts.onError).toHaveBeenCalledWith(boom);
    expect(deferred).toHaveLength(1);
  });

  it('reports a throwing disposer and still closes the DB and re-asks', async () => {
    const boom = new Error('pty gone');
    const { handler, opts, deferred, event } = setup({
      dispose: () => {
        throw boom;
      },
    });
    handler(event());
    expect(opts.onError).toHaveBeenCalledWith(boom);
    expect(opts.closeDb).toHaveBeenCalledTimes(1);

    await drainMicrotasks();
    expect(deferred).toHaveLength(1);
  });

  it('reports a failing DB close and still re-asks', async () => {
    const boom = new Error('close failed');
    const { handler, opts, deferred, event } = setup({
      closeDb: async () => {
        throw boom;
      },
    });
    handler(event());

    await drainMicrotasks();
    expect(opts.onError).toHaveBeenCalledWith(boom);
    expect(deferred).toHaveLength(1);
  });
});
