/**
 * Pure helpers for a session's root folder - the folder its terminals, its agent
 * and its git surfaces start in.
 *
 * A project can be a folder of several independent git checkouts (`double0/` is
 * itself one: `client-desktop/`, `landing/`, `backend/` are each their own
 * repo). Picking a session's root is therefore also picking WHICH repo the
 * session works on, which is why the worktree is cut from the repo containing
 * that folder rather than from the project folder.
 *
 * Kept free of Electron/React so both dialogs and launch-session share one
 * implementation and the rules are testable on their own.
 *
 * Separator-agnostic: on Windows the project folder is `C:\…` and a subfolder
 * may come back with either separator.
 */

import { isWithin, relativeTo, trimSeparators } from '@renderer/lib/path-within';
import { joinPath } from '@renderer/lib/utils';

/** How a root folder is rendered: `<project>/` in subtle + the leaf in bold. */
export type RootDisplay = {
  /** Trailing-slashed project prefix, or '' when the path isn't under it. */
  prefix: string;
  /** The part the eye should land on - the subfolder, or the project itself. */
  leaf: string;
  /** True when the session simply uses the project folder (nothing picked). */
  isDefault: boolean;
};

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Describe `path` relative to `projectPath` for the root row.
 *
 * `null` (or the project folder itself) is the default; a path under the project
 * shows `project/` + the relative remainder; anything else falls back to its own
 * basename with the full path as the prefix, so an outside folder is still
 * identifiable rather than showing a bare, ambiguous leaf.
 */
export function describeRoot(path: string | null, projectPath: string | null): RootDisplay {
  const project = (projectPath && trimSeparators(projectPath)) || null;
  const clean = (path && trimSeparators(path)) || null;
  if (!clean || (project && clean === project)) {
    return { prefix: '', leaf: project ? baseName(project) : '', isDefault: true };
  }
  if (project && isWithin(clean, project)) {
    return {
      prefix: `${baseName(project)}/`,
      leaf: relativeTo(clean, project),
      isDefault: false,
    };
  }
  const leaf = baseName(clean);
  return { prefix: clean.slice(0, clean.length - leaf.length), leaf, isDefault: false };
}

/**
 * Where a session rooted at `path` lands once `repoRoot` has been checked out as
 * a worktree at `worktreePath`.
 *
 * - the folder IS the repo → `null`, i.e. the worktree root itself
 * - a folder inside the repo → the same subpath inside the worktree
 * - anything else (no path, or outside the repo) → left untouched, so a session
 *   deliberately rooted elsewhere isn't dragged into the worktree
 */
export function reRootInWorktree(
  path: string | null,
  repoRoot: string | null,
  worktreePath: string,
): string | null {
  if (!path || !repoRoot) return path;
  if (!isWithin(path, repoRoot)) return path;
  const rel = relativeTo(path, repoRoot);
  return rel ? joinPath(worktreePath, rel) : null;
}
