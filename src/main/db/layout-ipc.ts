import { ipcMain } from 'electron';
import { getDb } from './client';
import { sessionLayouts } from './schema';

// Per-session workspace-layout persistence over IPC. Separate from the generic
// table bridge (db/ipc.ts) because layouts aren't a TanStack DB collection - they
// need no reactivity (read once when a session mounts, write on change) and use
// upsert (one row per session, keyed by sessionId), not the collection CRUD path.
//
// `layout:list` is the restore read (all rows at app start). `layout:save` is a
// frequent fire-and-forget upsert; the renderer debounces pure resizes and saves
// tab/split changes immediately (see WorkspaceSurface). Deletes are handled by the
// FK cascade when a session row is removed - no explicit delete channel needed.

const CHANNELS = ['layout:list', 'layout:save'] as const;

/**
 * Upsert one session's serialized layout. Swallows errors on purpose: a debounced
 * save can land just after the session was deleted (FK violation - the layout is
 * meaningless then) or while the DB is closing on quit. Exported so the main
 * process can persist a detached session window's synced layout the same way.
 */
export async function saveLayout(sessionId: string, layout: unknown): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(sessionLayouts)
      .values({ sessionId, layout, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: sessionLayouts.sessionId,
        set: { layout, updatedAt: new Date() },
      });
  } catch (err) {
    console.error('[db] layout save failed (session may have been deleted):', err);
  }
}

export function registerLayoutIpc(): () => void {
  // Every persisted layout, for the renderer to seed each session's view on launch.
  ipcMain.handle('layout:list', async () => {
    const db = await getDb();
    const rows = await db
      .select({ sessionId: sessionLayouts.sessionId, layout: sessionLayouts.layout })
      .from(sessionLayouts);
    return rows;
  });

  // Fire-and-forget save (the renderer doesn't await it). Validate the shape at the
  // boundary; the layout blob itself is opaque here (the renderer owns its schema).
  ipcMain.handle('layout:save', (_e, payload: { sessionId?: unknown; layout?: unknown }) => {
    const sessionId = payload?.sessionId;
    const layout = payload?.layout;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (typeof layout !== 'object' || layout === null) return;
    void saveLayout(sessionId, layout);
  });

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
