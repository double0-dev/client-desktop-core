import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

type Stats = { add: number; del: number };
type Mod = typeof import('./use-session-diff-stats');

const WT_A = '/acme/production-pipeline/.worktree/fix-auth';
const WT_B = '/acme/production-pipeline/.worktree/rewrite-deploy';
const CHECKOUT = '/acme/production-pipeline';

type Release = (root: string) => Promise<{ ok: true }>;

/** What `git diff --shortstat HEAD` would say per folder right now. */
let counts: Map<string, Stats>;
let fsListeners: Set<(root: string, paths: string[]) => void>;
let gitListeners: Set<(root: string, kind: 'status' | 'history') => void>;
let api: ReturnType<typeof installApi>;

function installApi() {
  return stubApi({
    fs: {
      watch: vi.fn<Release>(async () => ({ ok: true })),
      unwatch: vi.fn<Release>(async () => ({ ok: true })),
      onChanged: vi.fn((cb: (root: string, paths: string[]) => void) => {
        fsListeners.add(cb);
        return () => fsListeners.delete(cb);
      }),
    },
    git: {
      sessionStats: vi.fn(async (cwd: string) => ({
        stats: counts.get(cwd) ?? { add: 0, del: 0 },
      })),
      watch: vi.fn<(root: string) => Promise<{ ok?: true; error?: string }>>(async () => ({
        ok: true,
      })),
      unwatch: vi.fn<Release>(async () => ({ ok: true })),
      onChanged: vi.fn((cb: (root: string, kind: 'status' | 'history') => void) => {
        gitListeners.add(cb);
        return () => gitListeners.delete(cb);
      }),
    },
  });
}

/** Fresh module per test - the store is module state (see CLAUDE.md gotchas). */
async function load(): Promise<Mod> {
  vi.resetModules();
  return import('./use-session-diff-stats');
}

/** Let queued timers and the awaited IPC mocks run. */
const flush = (ms = 0): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const fsChanged = (root: string, paths: string[]): void =>
  fsListeners.forEach((cb) => cb(root, paths));
const gitChanged = (root: string): void => gitListeners.forEach((cb) => cb(root, 'status'));

beforeEach(() => {
  vi.useFakeTimers();
  counts = new Map([
    [WT_A, { add: 1, del: 0 }],
    [WT_B, { add: 3, del: 1 }],
  ]);
  fsListeners = new Set();
  gitListeners = new Set();
  api = installApi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('foldersForChange', () => {
  it('gives a change inside a nested worktree to that worktree, not the checkout', async () => {
    const { foldersForChange } = await load();
    const folders = [CHECKOUT, WT_A];
    expect(foldersForChange(folders, CHECKOUT, [`${WT_A}/src/token.ts`])).toEqual(new Set([WT_A]));
    expect(foldersForChange(folders, CHECKOUT, [`${CHECKOUT}/README.md`])).toEqual(
      new Set([CHECKOUT]),
    );
  });

  it('does not treat a sibling that shares a name prefix as inside the folder', async () => {
    const { foldersForChange } = await load();
    // `.worktree/fix-auth-2` is not inside `.worktree/fix-auth`.
    expect(foldersForChange([WT_A], CHECKOUT, [`${WT_A}-2/a.ts`])).toEqual(new Set());
  });

  it('reads an event without paths as its whole root', async () => {
    const { foldersForChange } = await load();
    expect(foldersForChange([WT_A, WT_B], WT_B, [])).toEqual(new Set([WT_B]));
  });

  it('matches Windows separators and a folder stored with a trailing one', async () => {
    const { foldersForChange } = await load();
    expect(foldersForChange(['C:\\acme\\app\\'], 'C:\\acme\\app', ['C:\\acme\\app\\a.ts'])).toEqual(
      new Set(['C:\\acme\\app\\']),
    );
  });
});

describe('useSessionDiffStats', () => {
  it('shows an edit as soon as the burst settles, without waiting for the poll', async () => {
    const { useSessionDiffStats } = await load();
    const { result } = renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    expect(result.current.get(WT_A)).toEqual({ add: 1, del: 0 });

    counts.set(WT_A, { add: 12, del: 4 });
    fsChanged(WT_A, [`${WT_A}/src/token.ts`]);
    await flush(100);
    // Still settling - the old counts stay up until the burst is over.
    expect(result.current.get(WT_A)).toEqual({ add: 1, del: 0 });
    await flush(300);
    expect(result.current.get(WT_A)).toEqual({ add: 12, del: 4 });
  });

  it('drops the counts when the work is committed', async () => {
    const { useSessionDiffStats } = await load();
    const { result } = renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    // A commit writes only inside the git dir, which the fs watch ignores.
    counts.set(WT_A, { add: 0, del: 0 });
    gitChanged(WT_A);
    await flush(400);
    expect(result.current.get(WT_A)).toEqual({ add: 0, del: 0 });
  });

  it('collapses a burst of events into one read per folder', async () => {
    const { useSessionDiffStats } = await load();
    renderHook(() => useSessionDiffStats([WT_A, WT_B], true));
    await flush();
    api.git.sessionStats.mockClear();

    for (let i = 0; i < 5; i++) fsChanged(WT_A, [`${WT_A}/file-${i}.ts`]);
    gitChanged(WT_A);
    fsChanged(WT_B, [`${WT_B}/deploy.sh`]);
    await flush(400);
    expect(api.git.sessionStats.mock.calls.map(([cwd]) => cwd).sort()).toEqual([WT_A, WT_B]);
  });

  it('re-reads only the worktree an edit landed in', async () => {
    const { useSessionDiffStats } = await load();
    renderHook(() => useSessionDiffStats([CHECKOUT, WT_A], true));
    await flush();
    api.git.sessionStats.mockClear();

    // The checkout's watcher reports edits inside its nested worktrees too.
    fsChanged(CHECKOUT, [`${WT_A}/src/token.ts`]);
    await flush(400);
    expect(api.git.sessionStats.mock.calls).toEqual([[WT_A]]);
  });

  it('ignores changes in folders no view lists', async () => {
    const { useSessionDiffStats } = await load();
    renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    api.git.sessionStats.mockClear();
    fsChanged(WT_B, [`${WT_B}/deploy.sh`]);
    gitChanged(WT_B);
    await flush(400);
    expect(api.git.sessionStats).not.toHaveBeenCalled();
  });

  it('still re-reads on the poll when no event arrives', async () => {
    const { useSessionDiffStats } = await load();
    const { result } = renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    counts.set(WT_A, { add: 7, del: 0 });
    await flush(29_000);
    expect(result.current.get(WT_A)).toEqual({ add: 1, del: 0 });
    await flush(1_000);
    expect(result.current.get(WT_A)).toEqual({ add: 7, del: 0 });
  });

  it('shows a hidden view the current counts, never the ones from when it was last shown', async () => {
    const { useSessionDiffStats } = await load();
    // Two session views of one project: A on screen, B mounted-hidden.
    const view = (enabled: boolean) =>
      renderHook((on: boolean) => useSessionDiffStats([WT_A], on), {
        initialProps: enabled,
      });
    const a = view(true);
    const b = view(false);
    await flush();
    expect(b.result.current.get(WT_A)).toEqual({ add: 1, del: 0 });

    counts.set(WT_A, { add: 12, del: 4 });
    fsChanged(WT_A, [`${WT_A}/src/token.ts`]);
    await flush(400);
    // Per-view state froze here, so B flashed "+1 -0" when shown next.
    expect(b.result.current.get(WT_A)).toEqual({ add: 12, del: 4 });

    // Switch: B shows the live counts on its very first render.
    a.rerender(false);
    b.rerender(true);
    expect(b.result.current.get(WT_A)).toEqual({ add: 12, del: 4 });
  });

  it('does not re-render when a re-read finds the same counts', async () => {
    const { useSessionDiffStats } = await load();
    const { result } = renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    const before = result.current;
    fsChanged(WT_A, [`${WT_A}/notes.md`]);
    await flush(400);
    expect(result.current).toBe(before);
  });

  it('hands the watches from one view to the next without reopening them', async () => {
    const { useSessionDiffStats } = await load();
    const a = renderHook((on: boolean) => useSessionDiffStats([WT_A], on), { initialProps: true });
    const b = renderHook((on: boolean) => useSessionDiffStats([WT_A], on), {
      initialProps: false,
    });
    await flush();
    expect(api.fs.watch).toHaveBeenCalledTimes(1);
    expect(api.git.watch).toHaveBeenCalledTimes(1);

    a.rerender(false);
    b.rerender(true);
    await flush(5_000);
    expect(api.fs.watch).toHaveBeenCalledTimes(1);
    expect(api.fs.unwatch).not.toHaveBeenCalled();

    // Nobody lists it any more: released once the grace runs out.
    b.rerender(false);
    await flush(1_000);
    expect(api.fs.unwatch).not.toHaveBeenCalled();
    await flush(1_000);
    expect(api.fs.unwatch).toHaveBeenCalledWith(WT_A);
    expect(api.git.unwatch).toHaveBeenCalledWith(WT_A);

    // And stops listening: a late event reads nothing.
    api.git.sessionStats.mockClear();
    fsChanged(WT_A, [`${WT_A}/a.ts`]);
    await flush(30_400);
    expect(api.git.sessionStats).not.toHaveBeenCalled();
  });

  it('releases only the watches main accepted', async () => {
    // Main's counts are per window, not per caller: unwatching a git watch
    // that failed would drop the one the Changes provider holds.
    api.git.watch.mockResolvedValue({ error: 'Not a git repository' });
    const { useSessionDiffStats } = await load();
    const { unmount } = renderHook(() => useSessionDiffStats([WT_A], true));
    await flush();
    unmount();
    await flush(2_000);
    expect(api.fs.unwatch).toHaveBeenCalledWith(WT_A);
    expect(api.git.unwatch).not.toHaveBeenCalled();
  });

  it('watches and reads nothing while disabled', async () => {
    const { useSessionDiffStats } = await load();
    renderHook(() => useSessionDiffStats([WT_A, WT_B], false));
    await flush(30_000);
    expect(api.fs.watch).not.toHaveBeenCalled();
    expect(api.git.sessionStats).not.toHaveBeenCalled();
  });
});
