import { projectsCollection, type AgentSession, type Project } from '@renderer/lib/collections';
import { projectFamily } from '@renderer/lib/projects/linked';
import { getHost } from '@renderer/lib/hosts/host-directory';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { confirmProjectDelete } from '@renderer/components/project-delete-dialog';
import { sessionBusyStatus, worktreeParts } from '@renderer/lib/session/worktree-delete';

/** Removal errors that a `--force` retry can get past (mirrors the per-session flow). */
const FORCEABLE = /(modified|untracked|--force|dirty|locked|not empty)/i;

/**
 * Confirmation + cleanup that must run before a project record is deleted -
 * the DB cascade takes every session in the project with it, so this is the
 * only chance to warn and to clean up the sessions' worktrees.
 *
 * With no sessions it's a plain confirm. Otherwise the project dialog lists
 * the sessions (busy state included) and, per the user's choices, removes
 * their worktrees (one forced retry after an explicit confirm when some are
 * dirty/locked) and optionally deletes the branches. Resolves `true` when the
 * project record should now be deleted, `false` when the user cancelled or a
 * worktree could not be removed (the project and its sessions stay).
 */
export async function confirmProjectDeletion(
  project: Project,
  allSessions: AgentSession[],
): Promise<boolean> {
  const sessions = allSessions.filter((s) => s.projectId === project.id);
  const note = linkedSessionsNote(project.id, allSessions);
  if (sessions.length === 0) {
    return confirmDialog({
      title: 'Delete project?',
      description:
        `“${project.name}” will be removed from your projects. Its folder on disk is not affected.` +
        (note ? ` ${note}` : ''),
      confirmLabel: 'Delete project',
      destructive: true,
    });
  }

  const choice = await confirmProjectDelete({
    projectName: project.name,
    note,
    sessions: sessions.map((s) => ({
      label: s.label,
      agent: s.agent,
      worktreePath: s.worktreePath ?? null,
      busy: sessionBusyStatus(s),
    })),
  });
  if (!choice) return false;
  if (!choice.removeWorktrees) return true; // keep the worktrees on disk; just drop the records

  const git = window.api.git;
  const worktrees = sessions
    .map((s) => s.worktreePath)
    .filter((p): p is string => !!p)
    .map((path) => ({ path, ...worktreeParts(path) }));

  const dirty: typeof worktrees = [];
  for (const wt of worktrees) {
    const r = await git.worktreeRemove(wt.projectDir, wt.path, false);
    if (r.ok) continue;
    if (FORCEABLE.test(r.error ?? '')) {
      dirty.push(wt);
      continue;
    }
    await alertDialog({
      title: 'Couldn’t remove a worktree',
      description: r.error ?? `The worktree at ${wt.path} could not be removed.`,
    });
    return false;
  }

  if (dirty.length > 0) {
    const one = dirty.length === 1;
    const force = await confirmDialog({
      title: one ? 'Worktree has changes' : `${dirty.length} worktrees have changes`,
      description: one
        ? 'The worktree has uncommitted changes or is locked. Remove it anyway?'
        : 'These worktrees have uncommitted changes or are locked. Remove them anyway?',
      confirmLabel: 'Remove anyway',
      destructive: true,
    });
    if (!force) return false;
    for (const wt of dirty) {
      const r = await git.worktreeRemove(wt.projectDir, wt.path, true);
      if (!r.ok) {
        await alertDialog({
          title: 'Couldn’t remove a worktree',
          description: r.error ?? `The worktree at ${wt.path} could not be removed.`,
        });
        return false;
      }
    }
  }

  // The worktrees are gone, so the branches are no longer checked out and can
  // be deleted. The user already accepted losing unmerged commits, so force
  // (-D); a failed branch delete is reported but doesn't keep the project.
  if (choice.deleteBranches) {
    for (const wt of worktrees) {
      if (!wt.branch) continue;
      const b = await git.deleteBranch(wt.projectDir, wt.branch, true);
      if (!b.ok) {
        await alertDialog({
          title: 'Couldn’t delete a branch',
          description: b.error ?? `The branch “${wt.branch}” could not be deleted.`,
        });
      }
    }
  }
  return true;
}

/**
 * The sessions listed under `projectId` that live in its linked host projects
 * (lib/projects/linked.ts): deleting the project keeps them - the host project
 * shows as a project of its own again - and the dialog says so.
 */
export function linkedSessionsNote(
  projectId: string,
  allSessions: readonly AgentSession[],
  projects: readonly Project[] = projectsCollection.toArray,
): string | null {
  const family = projectFamily(projectId, projects);
  family.delete(projectId);
  const kept = allSessions.filter((s) => s.projectId != null && family.has(s.projectId));
  if (kept.length === 0) return null;
  const hosts = [
    ...new Set(
      kept.map((s) => {
        const hostId = projects.find((p) => p.id === s.projectId)?.hostId;
        return getHost(hostId)?.label ?? 'a server';
      }),
    ),
  ].join(', ');
  const n = kept.length;
  return `Its ${n} session${n === 1 ? '' : 's'} on ${hosts} stay${n === 1 ? 's' : ''}, under ${n === 1 ? 'its' : 'their'} own project there.`;
}
