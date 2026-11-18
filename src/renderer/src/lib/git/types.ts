// Renderer-side names for the git IPC payloads (mirrors src/main/git.ts - the
// `window.api.git` calls are typed by the preload contract, so any drift here
// fails the typecheck at the assignment in git-context.tsx, same convention as
// DirEntry/DbChange mirrors elsewhere in lib/).

export type GitFileStatus = {
  /** Path relative to the repo root. */
  path: string;
  /** Pre-rename path, when the entry is a (staged) rename. */
  origPath?: string;
  /** Index (staged) status letter: M A D R C - or ' ' when unchanged there. */
  index: string;
  /** Worktree (unstaged) status letter: M D - or ' ' / '?' for untracked. */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
};

export type GitStatus = {
  repo: boolean;
  branch: string | null;
  /** Detached HEAD - `branch` then holds nothing useful; show the short sha. */
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  userName: string | null;
  userEmail: string | null;
  /** First line of .git/MERGE_MSG while a merge/cherry-pick awaits its commit
   * - the commit panel prefills its summary with it. */
  mergeMsg: string | null;
  /** The operation paused in this checkout (mirrors src/main/git-types.ts):
   * the commit button reads Continue ‹op› and the commit menu switches off.
   * Omitted = none. */
  operation?: GitOperation | null;
  /** HEAD is already on its upstream - amending it means the next push has
   * to force. False without an upstream. */
  headPushed?: boolean;
};

/** A multi-step git operation that can stop half way for the user. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** How `git reset` treats the index and the working tree. */
export type GitResetMode = 'soft' | 'mixed' | 'hard';

/** One file's ±line counts vs HEAD (git diff --numstat); null = binary. */
export type GitNumstatEntry = {
  path: string;
  add: number | null;
  del: number | null;
};

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
};

/** One `git stash list` entry (mirrors src/main/git-types.ts). `parents[0]`
 * is the commit the stash was made on - where the graph hangs its node;
 * `parents[2]`, when present, is the untracked-files commit. */
export type GitStash = {
  index: number;
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  message: string;
};

/** A tag as the remote reports it (`ls-remote --tags`): `sha` is the COMMIT it
 * points at - an annotated tag's peeled `^{}` line, never the tag object. */
export type GitRemoteTag = { name: string; sha: string };

export type GitRefs = {
  repo: boolean;
  branches: GitBranch[];
  remotes: { name: string; branches: string[] }[];
  worktrees: { path: string; name: string; branch: string | null }[];
  stashes: GitStash[];
  tags: string[];
  /** mtime (ms) of .git/FETCH_HEAD - when the repo last talked to a remote. */
  fetchedAt: number | null;
};

export type GitCommitRef = { name: string; type: 'branch' | 'remote' | 'tag'; head: boolean };

export type GitCommit = {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  refs: GitCommitRef[];
  subject: string;
};

export type GitLog = {
  repo: boolean;
  commits: GitCommit[];
  headSha: string | null;
};

/** Avatar URLs for commit authors via the connected hosting provider
 * (mirrors src/main/integrations.ts). Keys: commit sha / lowercased email. */
export type CommitAvatars = {
  bySha: Record<string, string>;
  byEmail: Record<string, string>;
};

/** One file touched by a commit (M A D R C; T renders as M). */
export type GitCommitFile = {
  path: string;
  /** Pre-rename/copy path. */
  origPath?: string;
  letter: string;
};

/** Whether (and how) a commit's message can be rewritten - the commit detail
 * panel's inline reword affordance (mirrors src/main/git.ts). */
export type GitRewordInfo = {
  eligible: boolean;
  /** Why not, for the read-only tooltip. Null when eligible. */
  reason: 'in-progress' | 'detached' | 'merge-commit' | 'not-on-branch' | 'merges-between' | null;
  /** HEAD commit - reword is a plain amend. */
  isHead: boolean;
  /** Commit already exists on a remote-tracking ref - rewording means the
   * branch will need a force push. */
  onRemote: boolean;
};

/** The three index stages (+ side labels) of one unmerged file - the merge
 * view's input. `null` content = that side has no version of the file
 * (add/add or modify/delete conflicts). */
export type GitConflict = {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** Short HEAD sha (the "ours" side). */
  oursSha: string | null;
  /** Short sha of MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD. */
  theirsSha: string | null;
  /** Friendly ref name for the incoming sha (git name-rev), when resolvable. */
  theirsName: string | null;
  /** Which operation is paused on conflicts. */
  op: GitOperation | null;
};

/** Files split for the commit panel: a file can appear in both lists. */
export function splitStatusFiles(files: GitFileStatus[]): {
  unstaged: GitFileStatus[];
  staged: GitFileStatus[];
} {
  return {
    unstaged: files.filter((f) => f.untracked || f.conflicted || f.worktree !== ' '),
    staged: files.filter((f) => !f.untracked && !f.conflicted && f.index !== ' '),
  };
}

/** The single status letter shown for a file in one of the two lists. */
export function statusLetter(file: GitFileStatus, staged: boolean): string {
  if (file.conflicted) return '!';
  if (file.untracked) return 'A';
  const letter = staged ? file.index : file.worktree;
  return letter === ' ' ? '·' : letter;
}

/** One letter for a file regardless of side - worktree state wins over index
 * (what the explorer shows next to a file). */
export function combinedStatusLetter(file: GitFileStatus): string {
  if (file.conflicted) return '!';
  if (file.untracked) return 'A';
  return file.worktree !== ' ' ? file.worktree : file.index;
}
