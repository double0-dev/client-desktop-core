// Pure session-status arithmetic for the workspace Projects panel and for the status dots - kept free of collection
// imports so it's unit-testable.

type Countable = { projectId?: string | null; status: string };

/**
 * Whether a session's dot breathes (see `StatusDot`): the agent is working
 * ('active'), or it is blocked on the user ('needs-input'). Both mean
 * "something is happening on this session" - idle, done and archived sit
 * still, so one glance down the sidebar separates the sessions in flight from
 * the parked ones. A 'finished' session (stopped while you were away, not yet
 * looked at) sits still too: its dot asks for a glance, not for attention, so
 * it wears the info colour without the halo.
 */
export function isLiveSessionStatus(status: string): boolean {
  return status === 'active' || status === 'needs-input';
}

/**
 * The sessions a project's count stands for. Archived ones are finished work
 * the user has put away: the badge answers "how much is going on in here", not
 * "how many sessions ever existed", so they are left out everywhere a project
 * is summarised by a single number.
 */
export function countedSessions<T extends Countable>(sessions: T[]): T[] {
  return sessions.filter((s) => s.status !== 'archived');
}

export type ProjectSessionMeta = {
  count: number;
  active: boolean;
  needsInput: boolean;
  /** A session stopped in here while the user was away and hasn't been looked at. */
  finished: boolean;
};

/**
 * Per-project tally for the Projects panel rows: the badge number plus whether
 * the project has anything running (green dot), waiting on the user (amber
 * dot) or finished unseen (blue dot) - the row shows the most pressing one, in
 * that order. Sessions with no project are skipped; archived ones don't count.
 */
export function projectSessionMeta<T extends Countable>(
  sessions: T[],
): Map<string, ProjectSessionMeta> {
  const map = new Map<string, ProjectSessionMeta>();
  for (const s of countedSessions(sessions)) {
    if (!s.projectId) continue;
    const m = map.get(s.projectId) ?? {
      count: 0,
      active: false,
      needsInput: false,
      finished: false,
    };
    m.count += 1;
    if (s.status === 'active') m.active = true;
    else if (s.status === 'needs-input') m.needsInput = true;
    else if (s.status === 'finished') m.finished = true;
    map.set(s.projectId, m);
  }
  return map;
}
