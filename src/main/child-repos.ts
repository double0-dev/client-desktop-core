import { pathFor, runtimeFor } from './host-runtime';

/** One checkout directly under a folder-of-repos project. */
export type ChildRepo = { name: string; path: string };

/** Folders never worth probing: tool output and dependency trees. */
const SKIPPED = new Set(['node_modules']);

/** More than this and the folder is not a handful of stacks - stop looking. */
const MAX_REPOS = 64;

/**
 * The folders directly under `dir` that are git checkouts of their own (a
 * `.git` folder, or the `.git` file of a linked worktree / submodule), sorted
 * by name. One level only: a folder-of-repos project keeps its stacks side by
 * side (`acme/api`, `acme/web`), and a deeper walk would find vendored and
 * nested checkouts nobody meant as a stack. Dot-folders are skipped - that is
 * where `.worktree/` and `.double0/` live. Callers decide whether `dir` itself
 * being a repo rules the answer out (see `git:childRepos`).
 */
export async function findChildRepos(dir: string): Promise<ChildRepo[]> {
  const fs = runtimeFor(dir).fs;
  // A host's folder is POSIX on every client: `node:path` on Windows turned
  // `/home/u/acme` + `api` into `\home\u\acme\api`, and no stack was found.
  const { join } = pathFor(dir);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // gone or unreadable - no repos to offer
  }
  const names = entries
    // A symlinked stack (`acme/api -> ../api`) counts: the `.git` probe below
    // follows the link, and a link to a file or nowhere simply fails it.
    .filter(
      (e) =>
        (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !SKIPPED.has(e.name),
    )
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const repos: ChildRepo[] = [];
  for (const name of names) {
    if (repos.length >= MAX_REPOS) break;
    const path = join(dir, name);
    try {
      await fs.stat(join(path, '.git'));
      repos.push({ name, path });
    } catch {
      // not a checkout
    }
  }
  return repos;
}
