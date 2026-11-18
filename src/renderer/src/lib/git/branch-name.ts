/**
 * Branch-name normalisation, shared by every surface that COINS a new git ref:
 * the session worktree branch (New Session dialog / task cards) and the Changes
 * tool's "New branch" dialog.
 *
 * Kept free of React/Electron so the rules are testable on their own.
 *
 * Names we create are always lowercase. Git refs are case-sensitive but the
 * macOS/Windows filesystems the `.worktree/` dirs live on are not, so a
 * `Fix-Auth` / `fix-auth` pair collides on disk; lowercasing everything up front
 * makes a session name's case irrelevant and keeps branches uniform.
 *
 * Names that already EXIST elsewhere (checking out `origin/Some-Branch`) are
 * never passed through here - they must match the remote exactly.
 */

import { refNameProblem } from './tag-name';

/** Lowercase a user-typed branch name; `/` and the rest of its shape survive. */
export function normalizeBranchName(name: string): string {
  return name.toLowerCase();
}

/**
 * A git-ref-safe branch/worktree name that mirrors the session name as closely as
 * possible. Case is folded down ("Fix Auth" → "fix-auth"); only characters git
 * forbids in a ref name are swapped for a dash - letters (incl. non-ASCII),
 * digits, `_` and `.` pass through untouched.
 */
export function sanitizeWorktreeName(name: string): string {
  return (
    normalizeBranchName(name)
      .trim()
      // git ref names forbid whitespace, ~ ^ : ? * [ \ and (to keep our flat
      // .worktree/ layout) /. Replace any run of them with a single dash.
      .replace(/[\s~^:?*[\\/]+/g, '-')
      // '@{' is reserved and '..' is illegal in a ref name.
      .replace(/@\{/g, '-')
      .replace(/\.\.+/g, '.')
      // Collapse dash runs; a leading dash reads as a git flag, a leading dot is
      // illegal, and a ref may end with neither a dash nor a dot.
      .replace(/-+/g, '-')
      .replace(/^[-.]+/, '')
      .replace(/[-.]+$/, '')
      .slice(0, 60)
      .replace(/[-.]+$/, '')
  );
}

/**
 * The first of `base`, `base-2`, `base-3`, … that no name in `taken` already
 * uses. Compared case-insensitively: the names we coin are lowercase, but the
 * `.worktree/` folders they become live on case-insensitive filesystems, so
 * an existing `Fix-Auth` must block `fix-auth` too.
 *
 * A second session launched from the same card or ticket wants the same
 * branch as the first - `git worktree add -b` refuses to reuse one, so the
 * launch takes the next free suffix instead of failing.
 */
export function uniqueBranchName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Why `name` cannot become a local branch (the Rename dialog), or null when it
 * can: git's ref-name rules plus a name another local branch already has.
 * `current` is the branch being renamed - keeping its own name is no problem,
 * just no change.
 */
export function validateBranchName(
  name: string,
  existing: Iterable<string> = [],
  current?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a branch name';
  const problem = refNameProblem(trimmed, 'Branch');
  if (problem) return problem;
  for (const taken of existing) {
    if (taken === trimmed && taken !== current) return `A branch named ${trimmed} already exists.`;
  }
  return null;
}
