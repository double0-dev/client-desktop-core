/**
 * Path-boundary checks for absolute folder paths, with either separator -
 * Windows paths come back from main with backslashes, and a `/`-only check
 * matched nothing below a repo there. Twin of `isWithin` in
 * `src/main/project-scopes.ts` (the renderer cannot import main's modules).
 */

const isSep = (ch: string | undefined): boolean => ch === '/' || ch === '\\';

/** Trailing separators off, so `/a/b/` and `/a/b` are the same folder. */
export function trimSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && isSep(path[end - 1])) end--;
  return path.slice(0, end);
}

/**
 * A Windows path (a drive or UNC path) with one separator and ASCII lower
 * case, for comparing only: worktree paths of sessions created on Windows
 * before 2026-10-28 are mixed (`C:\acme/.worktree/x`) while git now reports
 * `C:\acme\.worktree\x`, and agents write `c:/…` for the same folder (review,
 * 2026-10-29). Length-preserving, so a slice by the base's length still
 * lines up. POSIX paths compare exactly - their file systems are
 * case-sensitive.
 */
const comparablePath = (path: string): string =>
  /^([A-Za-z]:|\\\\)/.test(path)
    ? path.replace(/\\/g, '/').replace(/[A-Z]/g, (ch) => ch.toLowerCase())
    : path;

/** `target` is `base` or lies below it - never a sibling sharing its prefix. */
export function isWithin(target: string, base: string): boolean {
  const dir = comparablePath(trimSeparators(target));
  const root = comparablePath(trimSeparators(base));
  if (dir === root) return true;
  if (!dir.startsWith(root)) return false;
  // A root (`/`) already ends on its separator.
  return isSep(root[root.length - 1]) || isSep(dir[root.length]);
}

/**
 * `target` relative to `base`, for a target `isWithin` it - '' for the base
 * itself. Separator- and root-safe: `C:\` / `/` as the base keep the first
 * character (`slice(base.length + 1)` turned `C:\src` into `rc`).
 */
export function relativeTo(target: string, base: string): string {
  return trimSeparators(target)
    .slice(trimSeparators(base).length)
    .replace(/^[\\/]+/, '');
}

/** The folder holding `path` (`/a/b` → `/a`); the path itself at a root. */
export function parentFolder(path: string): string {
  const trimmed = trimSeparators(path);
  let i = trimmed.length - 1;
  while (i > 0 && !isSep(trimmed[i])) i--;
  return i <= 0 ? trimmed : trimmed.slice(0, i);
}

/** The last segment of a path - a new project's name. */
export function folderName(path: string): string {
  return trimSeparators(path).split(/[\\/]/).filter(Boolean).pop() ?? path;
}
