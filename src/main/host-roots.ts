import { hostOfPath, hostRootsOf, type HostRoot } from './host-of-path';

/**
 * Main's copy of the remote project roots (a private plan
 * › 1.3): read from the projects table at boot and after every projects row
 * change (db/ipc.ts › onProjectRowsChanged). `hostOfPathNow` is what every
 * path-keyed caller asks - the terminal spawn today, git / fs in M2.
 */
let roots: HostRoot[] = [];
let loading: Promise<HostRoot[]> | null = null;
const listeners = new Set<(roots: HostRoot[]) => void>();

export function currentHostRoots(): HostRoot[] {
  return roots;
}

/** The host a path belongs to now, null = this machine. */
export function hostOfPathNow(path: string | null | undefined): string | null {
  return hostOfPath(path, roots);
}

/** The read of the roots in flight, or null (terminal.ts waits on it before resolving a create). */
export function hostRootsLoading(): Promise<unknown> | null {
  return loading;
}

export function onHostRootsChanged(listener: (roots: HostRoot[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-read the roots; concurrent calls share one read. Never rejects. */
export function reloadHostRoots(): Promise<HostRoot[]> {
  if (loading) return loading.then(() => reloadHostRoots());
  loading = (async () => {
    try {
      // Lazily: PGlite is not pulled into every importer (and its tests).
      const [{ getDb }, { projects }] = await Promise.all([
        import('./db/client'),
        import('./db/schema'),
      ]);
      const db = await getDb();
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          path: projects.path,
          hostId: projects.hostId,
        })
        .from(projects);
      roots = hostRootsOf(rows);
      for (const l of listeners) l(roots);
    } catch (err) {
      console.warn('[hosts] could not read the project roots:', err);
    }
    return roots;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Tests: set the roots directly. */
export function setHostRootsForTest(next: HostRoot[]): void {
  roots = next;
}
