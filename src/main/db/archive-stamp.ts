// Pure part of the agent_sessions `archivedAt` stamp (db/ipc.ts applies it).
// Main derives the column from the status alone, so no renderer writer - the
// auto-archive sweep, the Archive menu items, a revive in session/status.ts,
// unarchive.ts - has to remember it, and the clock Settings → Sessions deletes
// by can't drift from the status it describes.

type Fields = Record<string, unknown>;

/**
 * What an update does to `archivedAt`: `stamp` when it moves the session into
 * the archive (the caller keeps an existing stamp, so re-writing 'archived'
 * never restarts the clock), `clear` when it moves it out, `keep` when the
 * patch leaves the status alone.
 */
export function archivedAtOnUpdate(patch: Fields): 'stamp' | 'clear' | 'keep' {
  if (!('status' in patch)) return 'keep';
  return patch.status === 'archived' ? 'stamp' : 'clear';
}

/**
 * `archivedAt` for an inserted row: null unless it is archived; an archived
 * row keeps the stamp it carries (a settings import restores its sessions with
 * their archive dates) and gets `now` without one.
 */
export function archivedAtOnInsert(row: Fields, now: Date): Date | null {
  if (row.status !== 'archived') return null;
  return row.archivedAt instanceof Date ? row.archivedAt : now;
}
