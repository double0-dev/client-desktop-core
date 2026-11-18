import { agentSessionsCollection, type AgentSession } from '@renderer/lib/collections';
import { worktreeParts } from '@renderer/lib/session/worktree-delete';

/**
 * Delete an archived session the cleanup sweep found expired (Settings →
 * Sessions). The unattended twin of `confirmSessionDeletion`: nothing is
 * asked, so nothing is forced - with `removeWorktree` its worktree goes only
 * when git removes it without `--force` (no modified or untracked files, not
 * locked); otherwise it stays on disk and only the record goes. The branch is
 * always kept - unmerged commits are never lost to a timer.
 */
export async function deleteExpiredSession(
  session: AgentSession,
  removeWorktree: boolean,
): Promise<void> {
  if (removeWorktree && session.worktreePath) {
    const { projectDir } = worktreeParts(session.worktreePath);
    try {
      await window.api.git.worktreeRemove(projectDir, session.worktreePath, false);
    } catch {
      // A dirty or vanished worktree - keep what is on disk, drop the record.
    }
  }
  // The record may already be gone (deleted by hand while git ran).
  if (agentSessionsCollection.get(session.id)) agentSessionsCollection.delete(session.id);
}

/**
 * Whether the sweep may delete a session of a project on `hostId` now (spec
 * 15): a local one always; a remote one only while its host is connected -
 * removing its worktree needs the host, and a record dropped while the host
 * is away would leave the worktree behind for good. Skipped ones are retried
 * on the next hourly tick. Archiving needs no host and is never held back.
 */
export function mayDeleteOnHost(
  hostId: string | null | undefined,
  hostState: string | null | undefined,
): boolean {
  return !hostId || hostState === 'connected';
}
