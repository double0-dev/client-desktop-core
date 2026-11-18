import { projectsCollection, type Project } from '@renderer/lib/collections';
import { projectDropSortOrder } from '@renderer/lib/project-order';
import { getSessionLayout } from '@renderer/lib/session/bridge';
import type { ProjectDescriptor } from '@renderer/lib/transfer';
import { projectFamily, type LinkableProject } from '@renderer/lib/projects/linked';

/**
 * The descriptor a project is opened in its own window with
 * (a private plan): every session of the project, with the
 * live layout of the ones this window holds - open or evicted (the session
 * bridge publishes both) - so main pre-assigns their shells to the new window
 * and that window seeds each view from the layout it had here. A session this
 * window never opened (or one living in a session window of its own) carries
 * null; main routes its eager shells by id, or leaves them where they are.
 */
export function projectWindowDescriptor(
  project: Pick<Project, 'id' | 'name'>,
  sessions: ReadonlyArray<{ id: string; projectId: string | null }>,
  projects: readonly LinkableProject[] = projectsCollection.toArray,
): ProjectDescriptor {
  // The project's own sessions and its linked host projects' (lib/projects/
  // linked.ts) - the window lists them all, so their shells go with it.
  const family = projectFamily(project.id, projects);
  return {
    kind: 'project',
    projectId: project.id,
    projectName: project.name,
    sessions: sessions
      .filter((s) => s.projectId != null && family.has(s.projectId))
      .map((s) => ({ sessionId: s.id, layout: getSessionLayout(s.id) })),
  };
}

/** "Open in separate window" on a project: main opens the window and releases it here. */
export function openProjectInWindow(
  project: Pick<Project, 'id' | 'name'>,
  sessions: ReadonlyArray<{ id: string; projectId: string | null }>,
): void {
  window.api?.project?.openInWindow(projectWindowDescriptor(project, sessions));
}

/** "Bring to this window" on a project in its own window: main closes it, returning the project. */
export function bringProjectToWindow(projectId: string): void {
  window.api?.project?.bringBack(projectId);
}

// Shared project mutations, used by the New project dialog, the Projects
// panel's menu and the clone entry.

/** The fields the New / Edit project dialogs set. */
export type ProjectEdits = {
  name: string;
  description: string | null;
  path: string;
  /** Null = no color of its own: the project follows the app accent color. */
  color: string | null;
  /** The host the project lives on, null = this machine (set at creation only). */
  hostId?: string | null;
};

/**
 * Insert a project (the New project dialog, a clone that landed
 * outside every project) and answer its id; null when the name or path trims
 * to empty. It sorts on top: ascending order, so the newest (most negative)
 * comes first - a drag later lands it at the midpoint between its neighbours.
 */
export function createProject(input: {
  name: string;
  description: string | null;
  path: string;
  color?: string | null;
  hostId?: string | null;
  /** A host project listed under this project of this machine (lib/projects/linked.ts). */
  linkedProjectId?: string | null;
  ownerId: string;
}): string | null {
  const trimmed = input.name.trim();
  const trimmedPath = input.path.trim();
  if (!trimmed || !trimmedPath) return null;
  const now = new Date();
  const projectId = crypto.randomUUID();
  projectsCollection.insert({
    id: projectId,
    name: trimmed,
    description: input.description,
    path: trimmedPath,
    color: input.color ?? null,
    hostId: input.hostId ?? null,
    linkedProjectId: input.linkedProjectId ?? null,
    pinned: false,
    sortOrder: -now.getTime(),
    ownerId: input.ownerId,
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

/** Persist edited project fields; no-op if the name or path trims to empty. */
export function editProject(id: string, edits: ProjectEdits): void {
  const trimmed = edits.name.trim();
  const trimmedPath = edits.path.trim();
  if (!trimmed || !trimmedPath) return;
  projectsCollection.update(id, (draft) => {
    draft.name = trimmed;
    draft.description = edits.description;
    draft.path = trimmedPath;
    draft.color = edits.color;
  });
}

/**
 * List host project `id` under `parentId` (a project of this machine) - a
 * host project reused for this project's sessions stays with the project it
 * serves.
 */
export function linkProject(id: string, parentId: string): void {
  projectsCollection.update(id, (draft) => {
    draft.linkedProjectId = parentId;
  });
}

export function deleteProject(id: string): void {
  // Main broadcasts a delete for every agent_session the DB cascade removes
  // (see src/main/db/ipc.ts), so the sessions collection stays in sync.
  // Callers must confirm first via confirmProjectDeletion (lib/project-delete.ts),
  // which also cleans up the cascaded sessions' worktrees - this function alone
  // would strand them on disk with their branches still checked out.
  projectsCollection.delete(id);
}

/**
 * Persist a drag-reorder: drop `draggedId` at `targetIndex` of `sorted` (the
 * displayed, sortProjects-ordered list the drag ran over). The write broadcasts
 * to every window, so all three project lists move together.
 */
export function reorderProject(sorted: Project[], draggedId: string, targetIndex: number): void {
  const order = projectDropSortOrder(sorted, draggedId, targetIndex);
  if (order == null) return;
  projectsCollection.update(draggedId, (draft) => {
    draft.sortOrder = order;
  });
}
