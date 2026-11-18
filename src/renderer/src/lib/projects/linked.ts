/**
 * Host projects made FOR a project of this machine (a clone there, a found
 * copy, a plain terminal's folder) are not projects of their own to the
 * user (user decision 2026-11-01): their sessions are listed under the project
 * they were started from, and they are not listed themselves. Main still knows
 * them as projects - that is how it tells a host's folders from this
 * machine's (hosts/host-roots.ts) - so the link is display only.
 *
 * A link to a project that no longer exists reads as no link: the host project
 * shows again, never vanishes with its sessions.
 */

export type LinkableProject = {
  id: string;
  hostId?: string | null;
  linkedProjectId?: string | null;
};

/** The project `project` is listed as: the one it is linked to, else itself. */
export function listedProjectId(
  project: LinkableProject | null | undefined,
  projects: readonly LinkableProject[],
): string | null {
  if (!project) return null;
  const parent = project.linkedProjectId;
  if (parent && parent !== project.id && projects.some((p) => p.id === parent && !p.hostId)) {
    return parent;
  }
  return project.id;
}

/** Whether `project` is listed on its own (the Projects panel, Search Everywhere). */
export function isListedProject(
  project: LinkableProject,
  projects: readonly LinkableProject[],
): boolean {
  return listedProjectId(project, projects) === project.id;
}

/** `projectId` and every project listed under it - the projects whose sessions it shows. */
export function projectFamily(
  projectId: string | null | undefined,
  projects: readonly LinkableProject[],
): Set<string> {
  const family = new Set<string>();
  if (!projectId) return family;
  family.add(projectId);
  for (const p of projects) {
    if (p.id !== projectId && listedProjectId(p, projects) === projectId) family.add(p.id);
  }
  return family;
}

/**
 * The project of THIS machine `projectId` is listed as, or null when that is a
 * host project (one of its own). A host project made from a session that
 * already runs on a host - moved from one host to another - links to the local
 * project the chain started from, never to another host project (which
 * `listedProjectId` would not honour).
 */
export function localProjectFor(
  projectId: string | null | undefined,
  projects: readonly LinkableProject[],
): string | null {
  const own = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const listed = listedProjectId(own, projects);
  const target = listed ? projects.find((p) => p.id === listed) : undefined;
  return target && !target.hostId ? target.id : null;
}
