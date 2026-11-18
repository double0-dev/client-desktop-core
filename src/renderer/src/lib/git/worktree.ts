/**
 * Pure helper for a git client's worktree list.
 *
 * Kept free of React/Electron so the row's "you are looking at this one" marker
 * is testable on its own.
 */

import { isWithin, relativeTo, trimSeparators } from '@renderer/lib/path-within';

/**
 * Which listed checkout a git client's root belongs to - the row to mark as
 * the one being shown.
 *
 * The root is either a worktree path exactly (a row was picked) or the session's
 * own folder, which can sit in a subdirectory of one (a project of several repos
 * roots its sessions at `<repo>/client-desktop`). So containment decides, not
 * equality.
 *
 * Worktrees nest - `.worktree/fix-auth` lives inside the main checkout - which
 * is why the LONGEST containing path wins. A first-match scan would mark the
 * main row for every isolated worktree, i.e. always the wrong one.
 */
export function activeWorktree(worktrees: { path: string }[], root: string | null): string | null {
  if (!root) return null;
  const target = trimSeparators(root);
  let best: string | null = null;
  let bestLength = -1;
  for (const w of worktrees) {
    const path = trimSeparators(w.path);
    if (!isWithin(target, path)) continue;
    if (path.length > bestLength) {
      best = w.path;
      bestLength = path.length;
    }
  }
  return best;
}

/**
 * The folder names already taken under `<repoRoot>/.worktree/` - a folder whose
 * branch was deleted still blocks `git worktree add` there. Either separator:
 * on Windows a `/`-only prefix matched none, and the launch offered a name
 * whose folder existed ("already exists").
 */
export function worktreeFolderNames(worktrees: { path: string }[], repoRoot: string): string[] {
  const base = `${trimSeparators(repoRoot)}/.worktree`;
  return worktrees
    .filter((w) => isWithin(w.path, base) && relativeTo(w.path, base) !== '')
    .map((w) => relativeTo(w.path, base));
}
