import { inArray, sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { broadcastDbChange } from './db/ipc';
import { agentSessions, projects, sessionLayouts } from './db/schema';
import { staleBusySessionIds } from './stale-sessions';

/**
 * The crash-recovery sweep (a private plan): once the
 * terminal backend has listed what is alive, every session the database
 * still calls active / needs-input without a single live terminal is reset
 * to idle - nothing would ever report it otherwise, and the sidebar, the
 * dock badge and the cleanup sweep all read that status. The selection is
 * pure (stale-sessions.ts); this writes it through the same update +
 * broadcast path `db:update` takes, so every window's collection follows.
 */
export async function sweepStaleSessions(
  liveTerminalIds: string[],
  opts: { hostId: string | null } = { hostId: null },
): Promise<string[]> {
  const db = await getDb();
  const sessions = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      runtime: agentSessions.runtime,
      projectId: agentSessions.projectId,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.status, ['active', 'needs-input']));
  if (sessions.length === 0) return [];
  // Which machine each project lives on (remote sessions, plan 28 › spec 15).
  const projectHosts = new Map(
    (await db.select({ id: projects.id, hostId: projects.hostId }).from(projects)).map((p) => [
      p.id,
      p.hostId ?? null,
    ]),
  );
  const layouts = await db
    .select({ sessionId: sessionLayouts.sessionId, layout: sessionLayouts.layout })
    .from(sessionLayouts)
    .where(
      inArray(
        sessionLayouts.sessionId,
        sessions.map((s) => s.id),
      ),
    );
  const stale = staleBusySessionIds(sessions, layouts, liveTerminalIds, {
    hostId: opts.hostId,
    hostOfProject: (projectId) => projectHosts.get(projectId) ?? null,
  });
  if (stale.length === 0) return [];
  // A busy session is never archived, so `archivedAt` stays as it is (null).
  const rows = await db
    .update(agentSessions)
    .set({ status: 'idle', updatedAt: sql`now()` })
    .where(inArray(agentSessions.id, stale))
    .returning();
  for (const row of rows) broadcastDbChange({ table: 'agent_sessions', type: 'update', row });
  return rows.map((r) => r.id);
}
