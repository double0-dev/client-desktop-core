import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  noteWatchMode,
  resetWatchModesForTest,
  unwatchFolder,
  watchFolder,
  watchModeOf,
} from './watch-mode';

describe('watch-mode', () => {
  afterEach(() => {
    resetWatchModesForTest();
    vi.unstubAllGlobals();
  });

  it('answers the mode of the watch that covers a path', () => {
    noteWatchMode('/home/emmaw/acme', 'poll');
    expect(watchModeOf('/home/emmaw/acme')).toBe('poll');
    expect(watchModeOf('/home/emmaw/acme/.worktree/x')).toBe('poll');
    expect(watchModeOf('/home/emmaw/acme-old')).toBeNull();
  });

  it('forgets a root whose watch answered no mode (local)', () => {
    noteWatchMode('/home/emmaw/acme', 'poll');
    noteWatchMode('/home/emmaw/acme', undefined);
    expect(watchModeOf('/home/emmaw/acme')).toBeNull();
  });

  it('records what fs.watch answered', async () => {
    const watch = vi.fn(async () => ({ ok: true as const, mode: 'poll' as const }));
    vi.stubGlobal('window', { ...window, api: { fs: { watch, unwatch: vi.fn() } } });
    watchFolder('/home/emmaw/acme');
    await vi.waitFor(() => expect(watchModeOf('/home/emmaw/acme')).toBe('poll'));
    expect(watch).toHaveBeenCalledWith('/home/emmaw/acme');
  });

  // Two views on one project share main's watch: the first unmount must not
  // drop the footer the second still shows.
  it('keeps the mode until the last ref goes', async () => {
    const watch = vi.fn(async () => ({ ok: true as const, mode: 'poll' as const }));
    vi.stubGlobal('window', { ...window, api: { fs: { watch, unwatch: vi.fn() } } });
    watchFolder('/home/emmaw/acme');
    watchFolder('/home/emmaw/acme');
    await vi.waitFor(() => expect(watchModeOf('/home/emmaw/acme')).toBe('poll'));
    unwatchFolder('/home/emmaw/acme');
    expect(watchModeOf('/home/emmaw/acme')).toBe('poll');
    unwatchFolder('/home/emmaw/acme');
    expect(watchModeOf('/home/emmaw/acme')).toBeNull();
  });

  // An answer that lands after the view unmounted must not bring the footer back.
  it('ignores a late answer after the last unwatch', async () => {
    let answer: (v: { ok: true; mode: 'poll' }) => void = () => undefined;
    const watch = vi.fn(
      () =>
        new Promise<{ ok: true; mode: 'poll' }>((r) => {
          answer = r;
        }),
    );
    vi.stubGlobal('window', { ...window, api: { fs: { watch, unwatch: vi.fn() } } });
    watchFolder('/home/emmaw/acme');
    unwatchFolder('/home/emmaw/acme');
    answer({ ok: true, mode: 'poll' });
    await new Promise((r) => setTimeout(r, 0));
    expect(watchModeOf('/home/emmaw/acme')).toBeNull();
  });

  it('takes a later switch to polling from a change notice', async () => {
    let changed: (root: string, paths: string[], mode?: 'native' | 'poll') => void = () =>
      undefined;
    const onChanged = vi.fn((cb: typeof changed) => {
      changed = cb;
      return () => undefined;
    });
    const watch = vi.fn(async () => ({ ok: true as const, mode: 'native' as const }));
    vi.stubGlobal('window', { ...window, api: { fs: { watch, unwatch: vi.fn(), onChanged } } });
    watchFolder('/home/emmaw/acme');
    await vi.waitFor(() => expect(watchModeOf('/home/emmaw/acme')).toBe('native'));
    changed('/home/emmaw/acme', [], 'poll');
    expect(watchModeOf('/home/emmaw/acme')).toBe('poll');
  });
});
