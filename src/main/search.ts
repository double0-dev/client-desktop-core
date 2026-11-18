import { ipcMain } from 'electron';
import { join, posix } from 'node:path';
import { isTrustedSender } from './ipc-util';
import { runtimeFor } from './host-runtime';
import { HIDDEN } from './fs';
import { MAX_INDEX_FILES } from './daemon/protocol';

/**
 * Cross-project file index for the "Search Everywhere" palette. Walks every
 * project's directory (filenames only - no content) and flattens it to one list
 * the renderer fuzzy-ranks locally. Reuses the file explorer's ignore set so the
 * results match what the tree shows. The walk is TTL-cached because it's the
 * expensive part and the palette pulls the list on every open.
 *
 * A remote project's files (a private plan › 5.2)
 * come from its host: one `fsIndex` per project, walked ON the host, cached
 * per host with a budget of its own (a remote monorepo never crowds the local
 * projects out) and re-walked after 60 s or when the host's tree watch
 * reports a change in a project. The local list answers at once; a host's
 * lands later and `search:indexChanged` tells every window to ask again.
 */

export type SearchFileEntry = {
  /** Absolute path - handed straight to the editor's openFile. */
  path: string;
  /** Basename: the fuzzy-match target shown (and highlighted) in the row. */
  name: string;
  projectId: string;
  projectName: string;
  /** The machine the file lives on (null = this one) - the editor opens it with that authority. */
  hostId: string | null;
  /** From a host that is unreachable now: its last list (the palette says so). */
  stale?: true;
};

export type SearchAnswer = {
  files: SearchFileEntry[];
  /** Hosts whose index is being walked now (the palette shows "Indexing …"). */
  pending: string[];
  /** Hosts with remote projects that are not connected (their last list is included, `stale`). */
  unreachable: string[];
};

type ProjectRow = { id: string; name: string; path: string | null; hostId: string | null };

/**
 * What the host manager offers the search index (index.ts wires it). `state`:
 * `index` = connected and its daemon walks (`fsIndex`), `old` = connected but
 * its daemon predates the walk (its projects stay unindexed, as in the MVP),
 * `down` = not connected.
 */
export type SearchHosts = {
  state(hostId: string): 'index' | 'old' | 'down';
  index(hostId: string, root: string, max: number): Promise<unknown>;
  /** A host's tree watch saw changes (absolute host paths). */
  onTreeChange(listener: (hostId: string, paths: string[]) => void): () => void;
};

export type SearchDeps = {
  hosts?: SearchHosts;
  /** Tell every window a host's index landed (`search:indexChanged`). */
  broadcast?: () => void;
  /** The projects table (tests replace it). */
  projects?: () => Promise<ProjectRow[]>;
  now?: () => number;
};

const UNTRUSTED = { error: 'Untrusted sender' } as const;

const CHANNELS = ['search:listFiles'] as const;

// A soft ceiling so a pathological monorepo can't make the walk run away or the
// IPC payload balloon; hit it and we stop early (filenames-only, so 20k is plenty).
const MAX_FILES = 20000;
// The index is rebuilt at most this often; opening the palette repeatedly reuses
// the last walk instead of re-scanning the disk each time.
const TTL_MS = 15000;
/** A host's index is re-walked at most this often unless its tree changed. */
export const HOST_TTL_MS = 60_000;
/**
 * A changed tree is re-walked no sooner than this after the last walk: an
 * agent editing files while the palette is open would otherwise walk the
 * host back to back (each landing asks again).
 */
export const HOST_REWALK_MIN_MS = 5_000;
/** Files one host may contribute (plan 29 decision 9) - its own budget. */
export const HOST_MAX_FILES = MAX_INDEX_FILES;

let cache: { at: number; files: SearchFileEntry[] } | null = null;
let building: Promise<SearchFileEntry[]> | null = null;

type HostIndex = {
  at: number;
  files: SearchFileEntry[];
  /** The project roots the list was walked from. */
  roots: string[];
  /** A change under one of `roots` since the walk. */
  dirty: boolean;
  building: Promise<void> | null;
};

/**
 * Walk one project depth-first via an explicit stack. Symlinks report neither
 * isDirectory nor isFile on a Dirent, so they're skipped - intentional: a flat
 * filename index doesn't need them, and it sidesteps symlink cycles for free.
 */
async function walkProject(
  root: string,
  projectId: string,
  projectName: string,
  out: SearchFileEntry[],
): Promise<void> {
  const fs = runtimeFor(root).fs;
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, vanished mid-walk) - skip, don't abort
    }
    for (const d of dirents) {
      if (HIDDEN.has(d.name)) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        out.push({ path: full, name: d.name, projectId, projectName, hostId: null });
        if (out.length >= MAX_FILES) break;
      }
    }
  }
}

async function buildLocalIndex(rows: ProjectRow[]): Promise<SearchFileEntry[]> {
  const out: SearchFileEntry[] = [];
  for (const p of rows) {
    if (!p.path) continue; // a project without a folder has nothing to index
    // A remote project is its host's to walk (below).
    if (p.hostId || runtimeFor(p.path).remote) continue;
    await walkProject(p.path, p.id, p.name, out);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

async function readProjects(): Promise<ProjectRow[]> {
  // Lazily: PGlite is not pulled into every importer (and its tests).
  const [{ getDb }, { projects }] = await Promise.all([
    import('./db/client'),
    import('./db/schema'),
  ]);
  const db = await getDb();
  return db
    .select({ id: projects.id, name: projects.name, path: projects.path, hostId: projects.hostId })
    .from(projects);
}

/** Whether a change at `path` can change what the host walk of `root` lists. */
export function changeTouchesIndex(root: string, path: string): boolean {
  const rel = posix.relative(root, path);
  if (rel === '') return true;
  if (rel.startsWith('..') || posix.isAbsolute(rel)) return false;
  // The walk skips these names (and `.worktree`: other sessions' checkouts).
  return !rel.split('/').some((seg) => HIDDEN.has(seg) || seg === '.worktree');
}

/** One host project's `fsIndex` answer as entries (null when it is no answer). */
function entriesOf(answer: unknown, p: ProjectRow & { path: string }, hostId: string) {
  if (typeof answer !== 'object' || answer === null) return null;
  const files = (answer as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  const out: SearchFileEntry[] = [];
  for (const rel of files) {
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..'))
      continue;
    out.push({
      path: posix.join(p.path, rel),
      name: posix.basename(rel),
      projectId: p.id,
      projectName: p.name,
      hostId,
    });
  }
  return out;
}

export function registerSearchIpc(deps: SearchDeps = {}): () => void {
  const now = deps.now ?? Date.now;
  const loadProjects = deps.projects ?? readProjects;
  const hostIndexes = new Map<string, HostIndex>();
  let disposed = false;

  const offTree =
    deps.hosts?.onTreeChange((hostId, paths) => {
      const entry = hostIndexes.get(hostId);
      if (!entry || entry.dirty) return;
      if (paths.some((path) => entry.roots.some((root) => changeTouchesIndex(root, path)))) {
        entry.dirty = true;
      }
    }) ?? (() => undefined);

  const buildHost = (hostId: string, rows: Array<ProjectRow & { path: string }>): void => {
    const hosts = deps.hosts;
    if (!hosts) return;
    const prev = hostIndexes.get(hostId);
    const entry: HostIndex = prev ?? { at: 0, files: [], roots: [], dirty: true, building: null };
    hostIndexes.set(hostId, entry);
    if (entry.building) return;
    const roots = rows.map((r) => r.path);
    // Changes during the walk count against the NEW list.
    entry.dirty = false;
    entry.building = (async () => {
      const files: SearchFileEntry[] = [];
      let complete = true;
      for (const p of rows) {
        const budget = HOST_MAX_FILES - files.length;
        if (budget <= 0) break;
        let answer: unknown;
        try {
          answer = await hosts.index(hostId, p.path, budget);
        } catch (err) {
          // The host went away mid-walk: the last list stands.
          if ((err as NodeJS.ErrnoException | null)?.code === 'EHOSTDOWN') {
            complete = false;
            break;
          }
          continue; // one project failing (a folder gone) never sinks the rest
        }
        files.push(...(entriesOf(answer, p, hostId) ?? []));
      }
      if (disposed) return;
      if (complete) {
        entry.files = files.slice(0, HOST_MAX_FILES);
        entry.roots = roots;
        entry.at = now();
      } else {
        entry.dirty = true;
      }
    })()
      .catch(() => {
        entry.dirty = true;
      })
      .finally(() => {
        entry.building = null;
        if (!disposed) deps.broadcast?.();
      });
  };

  const listFiles = async (): Promise<SearchAnswer> => {
    const rows = await loadProjects();
    // This machine's projects: as before (built on demand, 15 s TTL).
    let local: SearchFileEntry[];
    if (cache && now() - cache.at <= TTL_MS) local = cache.files;
    else {
      if (!building) {
        building = buildLocalIndex(rows).finally(() => {
          building = null;
        });
      }
      local = await building;
      cache = { at: now(), files: local };
    }
    const files = [...local];
    const pending: string[] = [];
    const unreachable: string[] = [];
    const hosts = deps.hosts;
    if (!hosts) return { files, pending, unreachable };
    const byHost = new Map<string, Array<ProjectRow & { path: string }>>();
    for (const p of rows) {
      if (!p.hostId || !p.path) continue;
      const list = byHost.get(p.hostId) ?? [];
      list.push(p as ProjectRow & { path: string });
      byHost.set(p.hostId, list);
    }
    // A host with no project left has nothing to keep.
    for (const id of [...hostIndexes.keys()]) if (!byHost.has(id)) hostIndexes.delete(id);
    for (const [hostId, projects] of byHost) {
      projects.sort((a, b) => a.path.localeCompare(b.path));
      const state = hosts.state(hostId);
      const entry = hostIndexes.get(hostId);
      if (state === 'old') continue;
      if (state === 'down') {
        unreachable.push(hostId);
        for (const f of entry?.files ?? []) files.push({ ...f, stale: true });
        continue;
      }
      const roots = projects.map((p) => p.path);
      const fresh =
        entry &&
        !entry.building &&
        (!entry.dirty || now() - entry.at < HOST_REWALK_MIN_MS) &&
        entry.at > 0 &&
        now() - entry.at <= HOST_TTL_MS &&
        JSON.stringify(entry.roots) === JSON.stringify(roots);
      if (!fresh) {
        buildHost(hostId, projects);
        pending.push(hostId);
      }
      // The last list meanwhile (none on the first walk): better than a gap.
      files.push(...(hostIndexes.get(hostId)?.files ?? []));
    }
    return { files, pending, unreachable };
  };

  // Return the cross-project file list, rebuilding the local index only when
  // stale. Concurrent calls (e.g. a fast double-open) share one in-flight build.
  ipcMain.handle('search:listFiles', async (event) => {
    if (!isTrustedSender(event)) return UNTRUSTED;
    try {
      return await listFiles();
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not index files' };
    }
  });

  return () => {
    disposed = true;
    offTree();
    cache = null;
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
