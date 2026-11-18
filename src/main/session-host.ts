/**
 * The remote host a session's project lives on, or null for this machine /
 * an unknown session (M4 review: terminal.ts refuses a local shell for a
 * remote project's session). One small read per call - only creates whose
 * terminal id names a session ask.
 */
export async function sessionHostOf(sessionId: string): Promise<string | null> {
  // Lazily: PGlite is not pulled into every importer (and its tests).
  const [{ getDb }, { agentSessions, projects }, { eq }] = await Promise.all([
    import('./db/client'),
    import('./db/schema'),
    import('drizzle-orm'),
  ]);
  const db = await getDb();
  const rows = await db
    .select({ hostId: projects.hostId })
    .from(agentSessions)
    .innerJoin(projects, eq(agentSessions.projectId, projects.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.hostId ?? null;
}
