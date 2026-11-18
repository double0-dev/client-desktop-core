import { useEffect, useState, type RefObject } from 'react';
import {
  agentSessionsCollection,
  projectsCollection,
  type AgentSession,
} from '@renderer/lib/collections';
import { expiredArchivedSessionIds, staleSessionIds } from '@renderer/lib/session/auto-archive';
import { deleteExpiredSession, mayDeleteOnHost } from '@renderer/lib/session/auto-delete';
import { getHostStatus } from '@renderer/lib/hosts/host-status';
import { sessionBusyStatus } from '@renderer/lib/session/worktree-delete';
import {
  durationMs,
  getSessionCleanupSettings,
  subscribeSessionCleanupSettings,
} from '@renderer/lib/settings/session-cleanup-settings';
import { getProjectScope } from '@renderer/lib/workspace/project-scope';

/** Between sweeps; a changed rule applies at once (subscription below). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether THIS window may run the session-cleanup sweep. Main grants the lease
 * to the main window only (window-ownership.ts); a project window never even
 * asks. Without the bridge (plain-browser dev) there is one window, so yes.
 * Null until main has answered.
 */
export function useSweepLease(): boolean | null {
  const [lease, setLease] = useState<boolean | null>(() => {
    if (getProjectScope()) return false;
    return typeof window.api?.session?.sweepLease === 'function' ? null : true;
  });
  useEffect(() => {
    if (lease !== null) return;
    const ask = window.api?.session?.sweepLease;
    if (!ask) return;
    let cancelled = false;
    void ask()
      .then((granted) => {
        if (!cancelled) setLease(granted === true);
      })
      .catch(() => {
        if (!cancelled) setLease(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lease]);
  return lease;
}

/**
 * Session cleanup (Settings → Sessions): a session with no activity
 * (updatedAt) for longer than the configured time moves to the archive, and
 * one archived for longer than the delete time is deleted (worktree included).
 * Hourly, and whenever the rules change. Reads the live rows through a ref so
 * sync ticks never re-arm the timer; the archive write bumps updatedAt, so a
 * session is never re-archived in a loop. Skipped: a session busy in a live
 * tab (working, or waiting on you), the one on screen in this window, and
 * every session living in another window (it is on screen there, and that
 * window's user may be looking at it). A session of a project on a remote
 * host is deleted only while that host is connected (`mayDeleteOnHost`).
 *
 * Runs in exactly ONE window - the holder of the sweep lease (the main
 * window). Two full-chrome windows sweeping at once would both try to delete
 * the same worktree (a private plan).
 */
export function useSessionCleanupSweep({
  ready,
  sessionsRef,
  activeSessionIdRef,
  externalIdsRef,
}: {
  /** The first real sync is in (an empty pre-sync list is not "nothing to do"). */
  ready: boolean;
  sessionsRef: RefObject<AgentSession[]>;
  activeSessionIdRef: RefObject<string | null>;
  externalIdsRef: RefObject<readonly string[]>;
}): void {
  const lease = useSweepLease();
  useEffect(() => {
    if (!ready || lease !== true) return;
    const deleting = new Set<string>();
    const sweep = (): void => {
      const cleanup = getSessionCleanupSettings();
      const sessions = sessionsRef.current;
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const external = new Set(externalIdsRef.current);
      const now = Date.now();
      if (cleanup.autoArchive) {
        for (const id of staleSessionIds(sessions, now, durationMs(cleanup.archiveAfter))) {
          const s = byId.get(id);
          if (!s || sessionBusyStatus(s) || external.has(id)) continue;
          agentSessionsCollection.update(id, (draft) => {
            draft.status = 'archived';
          });
        }
      }
      if (cleanup.autoDelete) {
        for (const id of expiredArchivedSessionIds(
          sessions,
          now,
          durationMs(cleanup.deleteAfter),
        )) {
          const s = byId.get(id);
          if (!s || deleting.has(id) || id === activeSessionIdRef.current) continue;
          if (sessionBusyStatus(s) || external.has(id)) continue;
          // A remote project's session waits for its host (its worktree is there).
          const hostId = s.projectId ? projectsCollection.get(s.projectId)?.hostId : null;
          if (!mayDeleteOnHost(hostId, getHostStatus(hostId)?.state)) continue;
          deleting.add(id);
          void deleteExpiredSession(s, cleanup.removeWorktree).finally(() => deleting.delete(id));
        }
      }
    };
    sweep();
    const handle = setInterval(sweep, SWEEP_INTERVAL_MS);
    // A changed rule applies now, not at the next hourly tick.
    const unsubscribe = subscribeSessionCleanupSettings(sweep);
    return () => {
      clearInterval(handle);
      unsubscribe();
    };
  }, [ready, lease, sessionsRef, activeSessionIdRef, externalIdsRef]);
}
