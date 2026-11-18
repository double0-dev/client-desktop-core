// Pure part of the session cleanup sweeps (workspace-host.tsx runs them hourly
// and whenever Settings → Sessions changes): which sessions have sat untouched
// long enough to be put away, and which have sat in the archive long enough to
// be deleted. Kept free of collection imports so the cutoff arithmetic is
// testable; the thresholds come from lib/settings/session-cleanup-settings.ts.

type Sweepable = { id: string; status: string; updatedAt: Date | string };
type Archived = Sweepable & { archivedAt?: Date | string | null };

/**
 * Ids of the sessions the sweep should archive at `now`: not already archived
 * (a manual archive is never touched, and the archive write itself bumps
 * `updatedAt`, so nothing is re-archived in a loop) and last written - every
 * status flip, rename or reorder bumps `updatedAt` - more than `afterMs` ago.
 */
export function staleSessionIds<T extends Sweepable>(
  sessions: T[],
  now: number,
  afterMs: number,
): string[] {
  const cutoff = now - afterMs;
  return sessions
    .filter((s) => s.status !== 'archived' && new Date(s.updatedAt).getTime() < cutoff)
    .map((s) => s.id);
}

/**
 * Ids of the archived sessions the sweep should delete at `now`: archived for
 * more than `afterMs`, counted from `archivedAt` (main stamps it from the
 * status - db/archive-stamp.ts). A row without a stamp is never deleted: its
 * archive date is unknown, and a guess could delete it the moment it lands.
 */
export function expiredArchivedSessionIds<T extends Archived>(
  sessions: T[],
  now: number,
  afterMs: number,
): string[] {
  const cutoff = now - afterMs;
  return sessions
    .filter(
      (s) =>
        s.status === 'archived' &&
        s.archivedAt != null &&
        new Date(s.archivedAt).getTime() < cutoff,
    )
    .map((s) => s.id);
}

type DeleteRule = { autoDelete: boolean; deleteAfterMs: number };

/**
 * The archived sessions a change of the delete rule would delete right away
 * that the current rule would not - what Settings → Sessions confirms before
 * turning deletion on or shortening its time. Empty when nothing new expires.
 */
export function newlyExpiredSessions<T extends Archived>(
  sessions: T[],
  now: number,
  current: DeleteRule,
  next: DeleteRule,
): T[] {
  if (!next.autoDelete) return [];
  const already = new Set(
    current.autoDelete ? expiredArchivedSessionIds(sessions, now, current.deleteAfterMs) : [],
  );
  const due = new Set(expiredArchivedSessionIds(sessions, now, next.deleteAfterMs));
  return sessions.filter((s) => due.has(s.id) && !already.has(s.id));
}
