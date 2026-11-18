import { useEffect, useSyncExternalStore } from 'react';

export type SessionDiffStats = { add: number; del: number };

/** Backstop re-read of every tracked folder - the watchers below are what keeps
 * the counts current; this only covers an event that never arrived (a
 * platform without recursive watches, a watcher that died with its folder). */
const POLL_MS = 30_000;
/** A burst of change events (an agent writing several files, a commit touching
 * index and refs) collapses into one read per folder, this long after the
 * first event. */
const SETTLE_MS = 400;
/** How long a folder no view lists anymore keeps its watchers. A session
 * switch hands the list from one view to the next (cleanup, then setup), and
 * closing the OS watchers in between would only reopen them. */
const RELEASE_MS = 2_000;

/**
 * Added/removed line counts for the sidebar's session rows (main's
 * `git:sessionStats`: uncommitted work, worktree vs HEAD plus the lines of new
 * untracked files - same basis as the session-changes drawer).
 *
 * One store per window, read by every session view. Each view renders its own
 * sidebar and hidden views stay mounted, so counts held per view froze in the
 * hidden ones and flashed their stale numbers when the view was shown again.
 *
 * Refreshes are event-driven: every listed folder is watched (worktree edits
 * via `fs:watch`, commits via `git:watch` - both ref-counted per window in
 * main, so a folder the session's own surface already watches costs nothing
 * extra) and re-read shortly after it changes. Before, a 30 s poll was the only
 * trigger, so new edits showed up only when a session switch re-read them.
 */

// Immutable snapshot, swapped wholesale on a change so useSyncExternalStore
// consumers see a new reference - and only on a change, so a re-read that
// finds the same counts re-renders nothing.
let snapshot: ReadonlyMap<string, SessionDiffStats> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): ReadonlyMap<string, SessionDiffStats> => snapshot;

function setStats(folder: string, stats: SessionDiffStats): void {
  const prev = snapshot.get(folder);
  if (prev && prev.add === stats.add && prev.del === stats.del) return;
  const next = new Map(snapshot);
  next.set(folder, { add: stats.add, del: stats.del });
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Which tracked folders a watcher event touches. Each changed path belongs to
 * the DEEPEST tracked folder holding it: worktrees nest inside the main
 * checkout (`.worktree/<name>`), and an edit there moves that session's counts,
 * never the checkout's (git lists a nested worktree as one untracked folder,
 * which the counts skip). An event without paths stands for its root.
 */
export function foldersForChange(
  folders: Iterable<string>,
  root: string,
  paths: readonly string[],
): Set<string> {
  const list = [...folders];
  const touched = new Set<string>();
  for (const path of paths.length > 0 ? paths : [root]) {
    let owner: string | null = null;
    for (const folder of list) {
      if (isWithin(path, folder) && (owner == null || folder.length > owner.length)) {
        owner = folder;
      }
    }
    if (owner != null) touched.add(owner);
  }
  return touched;
}

function isWithin(path: string, folder: string): boolean {
  const base = folder.replace(/[\\/]+$/, '');
  if (!path.startsWith(base)) return false;
  const next = path.charAt(base.length);
  return next === '' || next === '/' || next === '\\';
}

// --- reads --------------------------------------------------------------------

const dirty = new Set<string>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;

/** Queue folders for a re-read: now (`delay` 0), or once a burst settles. */
function schedule(folders: Iterable<string>, delay: number): void {
  for (const folder of folders) if (watched.has(folder)) dirty.add(folder);
  if (dirty.size === 0) return;
  if (delay === 0) {
    void drain();
    return;
  }
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    void drain();
  }, delay);
}

async function drain(): Promise<void> {
  // A running drain picks up whatever was queued meanwhile.
  if (draining) return;
  draining = true;
  try {
    // Sequential on purpose - a long session list shouldn't fan out one git
    // process per row all at once.
    while (dirty.size > 0) {
      const [folder] = dirty;
      dirty.delete(folder);
      if (!watched.has(folder)) continue;
      const r = await window.api.git.sessionStats(folder).catch(() => ({ stats: undefined }));
      if (r.stats) setStats(folder, r.stats);
    }
  } finally {
    draining = false;
  }
}

// --- watches ------------------------------------------------------------------

/** Enabled hooks listing each folder. */
const refs = new Map<string, number>();
/**
 * Every folder the store watches (listed, or inside its release grace), with
 * which of its two watches main accepted. Only those are released: main's
 * counts are per window, not per caller, so unwatching a watch that failed
 * would drop one the session's surface or Changes provider still holds.
 */
const watched = new Map<string, Promise<{ fs: boolean; git: boolean }>>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
let stopEvents: (() => void) | null = null;

const accepted = (p: Promise<{ ok?: true }> | undefined): Promise<boolean> =>
  p ? p.then((r) => r.ok === true).catch(() => false) : Promise.resolve(false);

function startEvents(): void {
  const api = window.api;
  const offFs = api.fs?.onChanged?.((root, paths) =>
    schedule(foldersForChange(watched.keys(), root, paths), SETTLE_MS),
  );
  const offGit = api.git.onChanged?.((root) =>
    schedule(foldersForChange(watched.keys(), root, []), SETTLE_MS),
  );
  const poll = setInterval(() => schedule(watched.keys(), 0), POLL_MS);
  stopEvents = () => {
    offFs?.();
    offGit?.();
    clearInterval(poll);
  };
}

function track(folder: string): void {
  refs.set(folder, (refs.get(folder) ?? 0) + 1);
  const pending = releaseTimers.get(folder);
  if (pending) {
    clearTimeout(pending);
    releaseTimers.delete(folder);
  }
  if (watched.has(folder)) return;
  if (!stopEvents) startEvents();
  const api = window.api;
  watched.set(
    folder,
    Promise.all([accepted(api.fs?.watch?.(folder)), accepted(api.git.watch?.(folder))]).then(
      ([fs, git]) => ({ fs, git }),
    ),
  );
}

function untrack(folder: string): void {
  const count = (refs.get(folder) ?? 0) - 1;
  if (count > 0) {
    refs.set(folder, count);
    return;
  }
  refs.delete(folder);
  releaseTimers.set(
    folder,
    setTimeout(() => release(folder), RELEASE_MS),
  );
}

function release(folder: string): void {
  releaseTimers.delete(folder);
  const held = watched.get(folder);
  watched.delete(folder);
  dirty.delete(folder);
  void held?.then(({ fs, git }) => {
    if (fs) void window.api?.fs?.unwatch(folder);
    if (git) void window.api?.git?.unwatch(folder);
  });
  if (watched.size === 0 && stopEvents) {
    stopEvents();
    stopEvents = null;
  }
}

/**
 * The sidebar's per-folder counts. Every view reads the one shared map; only
 * the active view passes `enabled`, which keeps its listed folders watched and
 * re-read (a fresh read on enable, then on every change underneath).
 */
export function useSessionDiffStats(
  folders: string[],
  enabled: boolean,
): ReadonlyMap<string, SessionDiffStats> {
  const stats = useSyncExternalStore(subscribe, getSnapshot);
  const foldersKey = folders.join('\n');
  useEffect(() => {
    if (!enabled || !window.api?.git?.sessionStats || folders.length === 0) return;
    for (const folder of folders) track(folder);
    schedule(folders, 0);
    return () => {
      for (const folder of folders) untrack(folder);
    };
    // `folders` rides in through foldersKey - the array identity is per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, foldersKey]);
  return stats;
}
