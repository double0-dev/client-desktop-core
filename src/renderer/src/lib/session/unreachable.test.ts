import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The unreachable store: a remote tab is marked while its host is away and
 * re-attached (a fresh xterm that replays) when it is back - never shown as
 * exited. A terminal no view shows loses its pooled xterm at once, so its next
 * mount replays instead of keeping a stale screen.
 */

const disposePooledTerminal = vi.fn();
const getPooledTerminal = vi.fn<(id: string) => unknown>(() => ({}));
vi.mock('@renderer/lib/terminal/pool', () => ({
  disposePooledTerminal: (id: string, kill: boolean) => disposePooledTerminal(id, kill),
  getPooledTerminal: (id: string) => getPooledTerminal(id),
}));

const store = await import('./unreachable');

beforeEach(() => {
  store.resetUnreachableForTest();
  disposePooledTerminal.mockClear();
  getPooledTerminal.mockClear();
});

describe('unreachable terminals', () => {
  it('marks, then clears and bumps the generation when the host is back', () => {
    store.markUnreachable('t1', 'h1', 100);
    expect(store.getUnreachable('t1')).toEqual({ hostId: 'h1', since: 100 });
    // A second report keeps the first "since".
    store.markUnreachable('t1', 'h1', 200);
    expect(store.getUnreachable('t1')?.since).toBe(100);
    expect(store.getReattachGeneration('t1')).toBe(0);
    store.markReachable('t1');
    expect(store.getUnreachable('t1')).toBeNull();
    expect(store.getReattachGeneration('t1')).toBe(1);
  });

  it('drops the pooled xterm of a terminal no view shows, never killing its shell', () => {
    store.markReachable('t2');
    expect(disposePooledTerminal).toHaveBeenCalledWith('t2', false);
  });

  it('leaves a shown terminal to its view', () => {
    const unmount = store.noteTerminalViewMounted('t3');
    store.markReachable('t3');
    expect(disposePooledTerminal).not.toHaveBeenCalled();
    unmount();
    store.markReachable('t3');
    expect(disposePooledTerminal).toHaveBeenCalledWith('t3', false);
  });

  // A local terminal main moved off an older build's daemon
  // (src/main/daemon-migrate.ts): same rebuild, no "unreachable" in between.
  it('rebuilds a relaunched tab: a fresh create that starts it on the current daemon', () => {
    const unmount = store.noteTerminalViewMounted('t4');
    store.markRelaunched('t4');
    expect(store.getReattachGeneration('t4')).toBe(1);
    expect(store.getUnreachable('t4')).toBeNull();
    // The view rebuilds its own xterm; nothing kills a shell.
    expect(disposePooledTerminal).not.toHaveBeenCalled();
    unmount();
    store.markRelaunched('t4');
    expect(disposePooledTerminal).toHaveBeenCalledWith('t4', false);
  });

  it('follows main’s pushes', () => {
    let unreachable: (p: { id: string; hostId: string; since: number }) => void = () => {};
    let reachable: (id: string) => void = () => {};
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        terminal: {
          onUnreachable: (cb: typeof unreachable) => {
            unreachable = cb;
            return () => {};
          },
          onReachable: (cb: typeof reachable) => {
            reachable = cb;
            return () => {};
          },
        },
      },
    });
    store.startUnreachableFeed();
    unreachable({ id: 't4', hostId: 'h1', since: 5 });
    expect(store.getUnreachable('t4')).toEqual({ hostId: 'h1', since: 5 });
    reachable('t4');
    expect(store.getUnreachable('t4')).toBeNull();
  });
});
