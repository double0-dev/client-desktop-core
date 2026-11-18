import { createContext, useContext } from 'react';
import type { GitStatus } from '@renderer/lib/git/types';

/**
 * What core reads of a workspace view's repo: its status (the explorer's
 * colours, the editor gutter, the repo picker's counts, the rail badge) and
 * the base text of a file (the gutter's diff). The core build's provider
 * (`workspace/git-status-provider.tsx`) reads and watches the status and
 * nothing else; an extension's git client swaps in its full provider
 * (`RendererExtension.git`), which
 * provides this same value beside its own. Kept JSX-free in lib/.
 */
export type GitStatusValue = {
  /** The checkout the status is read from (the session's folder, or the
   * repo / worktree a tool picked); null = no repo in reach. */
  cwd: string | null;
  /** The project the workspace shows. */
  projectId: string | null;
  /** Working tree + branch status; null = not loaded yet. */
  status: GitStatus | null;
  /** Re-read now (after an action that moved the repo). */
  refresh: () => void;
  /** HEAD's text of a repo-relative or absolute path - the editor gutter's base. */
  loadFileBase: (
    path: string,
  ) => Promise<{ content?: string | null; binary?: boolean; error?: string }>;
};

export const GitContext = createContext<GitStatusValue | null>(null);

export function useGit(): GitStatusValue {
  const value = useContext(GitContext);
  if (!value) throw new Error('useGit must be used inside a git provider');
  return value;
}

/**
 * Like useGit, but tolerates missing context - for components that also render
 * outside a git provider (the file explorer / editors in detached tear-off
 * windows).
 */
export function useGitOptional(): GitStatusValue | null {
  return useContext(GitContext);
}
