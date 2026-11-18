import type { AgentSession } from '@renderer/lib/collections';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { confirmDeleteBusySession } from '@renderer/components/busy-tabs-dialog';
import { confirmWorktreeSessionDelete } from '@renderer/components/worktree-delete-dialog';
import { getKnownSessionLayout } from '@renderer/lib/session/bridge';
import {
  busyShellTabs,
  getTerminalBusy,
  type BusyTab,
  type TerminalBusyStatus,
} from '@renderer/lib/terminal/busy';
import { allTabs, conversationPtyId } from '@renderer/lib/workspace/layout';

/**
 * Split a worktree path (`<project>/.worktree/<branch>`, as built by
 * launch-session) into its project dir - the git cwd to run removal/branch
 * commands from - and the branch name. The branch is sanitized to a single path
 * segment at creation time, so it's always the final segment.
 */
export function worktreeParts(worktreePath: string): { projectDir: string; branch: string } {
  // Either separator: a Windows worktree is `C:\acme\.worktree\x`, or the
  // mixed `C:\acme/.worktree/x` that sessions created before 2026-10-28 carry.
  const m = /[\\/]\.worktree[\\/]/.exec(worktreePath);
  if (!m) return { projectDir: worktreePath, branch: worktreePath.split(/[\\/]/).pop() ?? '' };
  return {
    projectDir: worktreePath.slice(0, m.index),
    branch: worktreePath.slice(m.index + m[0].length),
  };
}

/**
 * The session's tabs that still host busy work, for the delete warnings: every
 * shell tab of its live layout (open or evicted here), else of the layout the
 * previous run left it (not opened yet this run - workspace-host observes
 * those same shells), else only its eager conversation terminal. Checking the
 * conversation terminal alone missed an agent working in a second tab, and the
 * delete killed it without a word (2026-10-29).
 */
function busyTabsOf(session: AgentSession): BusyTab[] {
  const layout = getKnownSessionLayout(session.id);
  if (layout) return busyShellTabs(allTabs(layout));
  const status = getTerminalBusy(conversationPtyId(session.id));
  return status ? [{ title: session.agent, status }] : [];
}

/**
 * The session's aggregate busy state for a one-pill-per-session summary (the
 * project delete dialog): 'needs-input' outranks 'running' - an agent blocked
 * on the user is the more urgent thing to surface.
 */
export function sessionBusyStatus(session: AgentSession): TerminalBusyStatus | null {
  const tabs = busyTabsOf(session);
  if (tabs.length === 0) return null;
  return tabs.some((t) => t.status === 'needs-input') ? 'needs-input' : 'running';
}

/**
 * Confirmation + cleanup that must run before a session record is deleted.
 *
 * A session whose tabs are still busy - an agent mid-turn or waiting for input -
 * always warns, listing those tabs. For a plain session that's the only gate
 * (no busy tabs → resolves `true` immediately). For a session backed by a git
 * worktree it shows the worktree warning dialog (busy tabs folded in) and, per
 * the user's choices, removes the worktree (retrying forced when it's
 * dirty/locked) and optionally deletes its branch. Resolves `true` when the
 * record should now be deleted, or `false` when the user cancelled (leaving
 * both the session and its worktree untouched).
 */
export async function confirmSessionDeletion(session: AgentSession): Promise<boolean> {
  const busyTabs = busyTabsOf(session);
  const worktreePath = session.worktreePath;
  if (!worktreePath) {
    return busyTabs.length === 0 || confirmDeleteBusySession({ tabs: busyTabs });
  }

  const { projectDir, branch } = worktreeParts(worktreePath);
  const choice = await confirmWorktreeSessionDelete({
    worktreePath,
    branch: branch || null,
    busyTabs,
  });
  if (!choice) return false;

  if (!choice.removeWorktree) return true; // keep the worktree on disk; just drop the session

  const git = window.api.git;
  let r = await git.worktreeRemove(projectDir, worktreePath, false);
  if (!r.ok && /(modified|untracked|--force|dirty|locked|not empty)/i.test(r.error ?? '')) {
    const force = await confirmDialog({
      title: 'Worktree has changes',
      description: 'The worktree has uncommitted changes or is locked. Remove it anyway?',
      confirmLabel: 'Remove anyway',
      destructive: true,
    });
    if (!force) return false;
    r = await git.worktreeRemove(projectDir, worktreePath, true);
  }
  if (!r.ok) {
    await alertDialog({
      title: 'Couldn’t remove the worktree',
      description: r.error ?? 'The worktree could not be removed.',
    });
    return false;
  }

  // The worktree is gone, so its branch is no longer checked out and can be
  // deleted. The user already accepted losing unmerged commits, so force (-D).
  if (choice.deleteBranch && branch) {
    const b = await git.deleteBranch(projectDir, branch, true);
    if (!b.ok) {
      await alertDialog({
        title: 'Couldn’t delete the branch',
        description: b.error ?? 'The branch could not be deleted.',
      });
      // The worktree is already removed; still delete the session record.
    }
  }
  return true;
}
