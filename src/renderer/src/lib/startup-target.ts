import { sortProjects } from '@renderer/lib/project-order';
import { isListedProject, listedProjectId, projectFamily } from '@renderer/lib/projects/linked';

// Where a project (or the whole app, at startup) opens. Kept free of collection
// and router imports so it's unit-testable, and shared by every caller: app
// startup, the Projects panel, Search Everywhere, the main window's
// `showProject`, the session-less view's auto-swap and the delete fallbacks.

type SessionOpenable = { id: string; projectId: string | null; status: string; sortOrder: number };
type ProjectOpenable = {
  id: string;
  sortOrder: number;
  createdAt: Date;
  hostId?: string | null;
  linkedProjectId?: string | null;
};

/** A route to navigate/redirect to, as a discriminated union the caller narrows. */
export type OpenTarget =
  | { to: '/workspace' }
  | { to: '/workspace/$projectId'; params: { projectId: string } }
  | { to: '/sessions/$sessionId'; params: { sessionId: string } };

/**
 * The session a project should open on, given `sessions` (that project's, in any
 * order) and the id it was last viewed on: the remembered one, else its top live
 * session, else its top archived one - sidebar order (ascending sortOrder) both
 * times. A remembered id that no longer exists is simply ignored, so a stale
 * entry is harmless. Undefined when the project has no sessions at all; the
 * caller opens its session-less workspace view instead.
 */
export function pickProjectSession<T extends SessionOpenable>(
  sessions: T[],
  lastSessionId: string | null,
): T | undefined {
  const inOrder = [...sessions].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    inOrder.find((s) => s.id === lastSessionId) ??
    inOrder.find((s) => s.status !== 'archived') ??
    inOrder[0]
  );
}

/**
 * Where `projectId` opens: its last-viewed session (`lastSessionOf`), else its
 * top live one, else its top archived one, else its session-less workspace.
 * The sessions of the host projects listed under it count as its own
 * (lib/projects/linked.ts).
 */
export function projectOpenTarget(
  projectId: string,
  projects: ProjectOpenable[],
  sessions: SessionOpenable[],
  lastSessionOf: (projectId: string) => string | null,
): OpenTarget {
  const family = projectFamily(projectId, projects);
  const session = pickProjectSession(
    sessions.filter((s) => s.projectId != null && family.has(s.projectId)),
    lastSessionOf(projectId),
  );
  return session
    ? { to: '/sessions/$sessionId', params: { sessionId: session.id } }
    : { to: '/workspace/$projectId', params: { projectId } };
}

/**
 * The screen the app opens on - and where a window goes when the project or
 * session it showed was deleted. With at least one project we go straight into
 * a workspace: the project last worked in (else the top one) on the session
 * last viewed there, so a restart resumes where the user left off. With none,
 * the no-project workspace (`/workspace`), whose empty state adds the first
 * one (a private plan).
 */
export function startupTarget(
  projects: ProjectOpenable[],
  sessions: SessionOpenable[],
  lastProjectId: string | null,
  lastSessionOf: (projectId: string) => string | null,
): OpenTarget {
  if (projects.length === 0) return { to: '/workspace' };
  // Host projects listed under a project of this machine open as that one,
  // with their sessions (lib/projects/linked.ts).
  const listed = projects.filter((p) => isListedProject(p, projects));
  const remembered = listedProjectId(
    projects.find((p) => p.id === lastProjectId),
    projects,
  );
  const project =
    listed.find((p) => p.id === remembered) ?? sortProjects(listed.length ? listed : projects)[0];
  return projectOpenTarget(project.id, projects, sessions, lastSessionOf);
}

/**
 * Where a window that starts fresh opens (lib/start-fresh.ts): the top
 * project's session list, with no session opened - the remembered project
 * and session are what may have crashed the window. Nothing is forgotten:
 * the next ordinary start resumes as before.
 */
export function freshStartTarget(projects: ProjectOpenable[]): OpenTarget {
  if (projects.length === 0) return { to: '/workspace' };
  const listed = projects.filter((p) => isListedProject(p, projects));
  const project = sortProjects(listed.length ? listed : projects)[0];
  return { to: '/workspace/$projectId', params: { projectId: project.id } };
}

/**
 * Where a view with no project to show goes (the no-project workspace, or a
 * session-less view whose project was deleted): wherever startup would open -
 * null while that is the bare no-project workspace it already is. `fresh`:
 * the window starts fresh (lib/start-fresh.ts) - where a fresh start opens,
 * never the remembered session (the projects can load after the fresh start
 * landed here, and healing into the last session reopened what crashed).
 */
export function noProjectTarget(
  viewProjectId: string | null,
  projects: ProjectOpenable[],
  sessions: SessionOpenable[],
  lastProjectId: string | null,
  lastSessionOf: (projectId: string) => string | null,
  fresh = false,
): OpenTarget | null {
  const target = fresh
    ? freshStartTarget(projects)
    : startupTarget(projects, sessions, lastProjectId, lastSessionOf);
  return target.to === '/workspace' && viewProjectId == null ? null : target;
}

/**
 * Where the window goes after deleting the project it shows: startup's pick
 * over what is left. The caller's lists still hold the deleted row (the
 * optimistic delete has not reached the render yet), so it is left out here.
 */
export function afterProjectDeleted(
  deletedId: string,
  projects: ProjectOpenable[],
  sessions: SessionOpenable[],
  lastProjectId: string | null,
  lastSessionOf: (projectId: string) => string | null,
): OpenTarget {
  return startupTarget(
    projects.filter((p) => p.id !== deletedId),
    sessions.filter((s) => s.projectId !== deletedId),
    lastProjectId === deletedId ? null : lastProjectId,
    lastSessionOf,
  );
}
