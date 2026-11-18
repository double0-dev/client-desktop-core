/**
 * Per-project persistence for the file explorer's tree state - which folders
 * are expanded plus the scroll position - keyed by the tree's root path. The
 * explorer keeps its state in component state, so it's lost whenever the
 * component remounts (first visit to a session, revisit after an LRU eviction,
 * toggling the Files rail, an app restart); this store lets each remount come
 * back exactly as the project was left. One localStorage blob for all roots,
 * LRU-capped so long-gone projects don't accumulate forever.
 */

const STORAGE_KEY = 'double0-explorer-tree-state';
const MAX_ROOTS = 50;

export type ExplorerTreeState = {
  /** Absolute paths of the expanded folders (the root itself included when open). */
  expanded: string[];
  scrollTop: number;
};

type StateByRoot = Record<string, ExplorerTreeState>;

function readAll(): StateByRoot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StateByRoot;
  } catch {
    return {};
  }
}

export function loadExplorerTreeState(rootPath: string): ExplorerTreeState | null {
  const entry = readAll()[rootPath];
  if (!entry || !Array.isArray(entry.expanded)) return null;
  return {
    expanded: entry.expanded.filter((p): p is string => typeof p === 'string'),
    scrollTop: typeof entry.scrollTop === 'number' ? entry.scrollTop : 0,
  };
}

export function saveExplorerTreeState(rootPath: string, state: ExplorerTreeState): void {
  const all = readAll();
  // Re-insert at the end so key order doubles as recency order for the cap.
  delete all[rootPath];
  all[rootPath] = state;
  const roots = Object.keys(all);
  for (let i = 0; i < roots.length - MAX_ROOTS; i++) delete all[roots[i]];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A quota/serialization failure just loses persistence, never the tree.
  }
}
