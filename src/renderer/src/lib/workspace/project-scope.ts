import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { listedProjectId, type LinkableProject } from '@renderer/lib/projects/linked';

/**
 * A project window (a private plan) boots the normal router
 * and the full `_app` chrome, scoped to ONE project. The scope is a module
 * singleton seeded once at boot (main.tsx), before React mounts, from the
 * window's bootstrap payload; the chrome reads it to name its project,
 * list only this project's sessions, redirect the project-level routes and
 * hand clicks on other projects to the main window. The main window has no
 * scope (`null`), which is also what every test sees unless it sets one.
 *
 * Layouts: the sessions the origin held travel in the payload with their
 * live tabs (pty ids intact); the host seeds each session's first mount from
 * them (`takeSeedLayout`) so the moved shells are adopted with a replay, the
 * same way a returned session seeds from its synced layout.
 */
export type ProjectScope = {
  projectId: string;
  /** The name the window was opened with - the title until the row loads. */
  projectName: string;
};

let scope: ProjectScope | null = null;
const seedLayouts = new Map<string, WorkspaceLayout>();

export function setProjectScope(
  next: ProjectScope | null,
  layouts: ReadonlyArray<{ sessionId: string; layout: WorkspaceLayout | null }> = [],
): void {
  scope = next;
  seedLayouts.clear();
  for (const { sessionId, layout } of layouts) if (layout) seedLayouts.set(sessionId, layout);
}

/** The project this window is scoped to, or null in the main window. */
export function getProjectScope(): ProjectScope | null {
  return scope;
}

/** The layout a session was moved here with, consumed on its first mount. */
export function takeSeedLayout(sessionId: string): WorkspaceLayout | undefined {
  const layout = seedLayouts.get(sessionId);
  seedLayouts.delete(sessionId);
  return layout;
}

/**
 * Whether the window scoped to `s` hosts `projectId`: its project, or - with
 * `projects` given - a host project listed under it (lib/projects/linked.ts):
 * a project window hosts the sessions its sidebar lists, the linked host
 * projects' included, and main returns them there (their windows carry the
 * listed project's id).
 */
function scopeHosts(
  projectId: string | null | undefined,
  s: ProjectScope,
  projects?: readonly LinkableProject[],
): boolean {
  if (projectId === s.projectId) return true;
  if (!projects || projectId == null) return false;
  return (
    listedProjectId(
      projects.find((p) => p.id === projectId),
      projects,
    ) === s.projectId
  );
}

/** Whether `projectId` is the one this window is scoped to (always true without a scope). */
export function inProjectScope(
  projectId: string | null | undefined,
  s = scope,
  projects?: readonly LinkableProject[],
): boolean {
  return s == null || scopeHosts(projectId, s, projects);
}

/** The subset of `sessions` this window hosts: all of them without a scope. */
export function scopedSessions<T extends { projectId: string | null }>(
  sessions: readonly T[],
  s = scope,
  projects?: readonly LinkableProject[],
): T[] {
  return s == null ? [...sessions] : sessions.filter((x) => scopeHosts(x.projectId, s, projects));
}

/**
 * Where a route outside the scope goes: the no-project workspace and the
 * workspace of any other project land on the scoped project's workspace
 * (which swaps to its last-viewed session). Null = the route is fine.
 */
export function scopedRedirect(
  pathname: string,
  s = scope,
): { to: '/workspace/$projectId'; params: { projectId: string } } | null {
  if (s == null) return null;
  const target = { to: '/workspace/$projectId' as const, params: { projectId: s.projectId } };
  // A bare /workspace is where startup lands with no project - in a project
  // window, its project row going away; the host closes the window then.
  if (pathname === '/workspace' || pathname === '/workspace/') return target;
  const workspace = /^\/workspace\/([^/]+)/.exec(pathname);
  if (workspace && decodeURIComponent(workspace[1]) !== s.projectId) return target;
  return null;
}

/**
 * The chrome's persisted keys are per window KIND: a project window keeps its
 * own dock panels, overlays, widths and Commands-dock state (one namespace
 * shared by every project window, like the `double0-detached-*` keys of a
 * session window), so resizing or opening a tool there never shoves the main
 * window's chrome around. Everything else (settings, per-session and
 * per-project memory) stays on the shared key and syncs across windows
 * through `storage` (use-persisted-state.ts).
 */
export function windowChromeKey(sharedKey: string, s = scope): string {
  if (s == null) return sharedKey;
  return sharedKey.replace(/^double0-(workspace-)?/, 'double0-project-');
}
