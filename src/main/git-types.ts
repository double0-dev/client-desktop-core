/**
 * Shared payload shapes for the git bridge (mirrored in
 * src/renderer/src/lib/git-types.ts).
 *
 * Split out of git.ts so the pure parsers in git-parse.ts - and their tests -
 * can name these without pulling in Electron.
 */

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
  /** Detached HEAD - `branch` then holds the short sha. */
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
  /** The operation paused in this checkout (a conflict or a pending commit
   * stopped it): the commit panel's button reads Continue ‹op› and the
   * graph's commit menu switches off. Omitted = none (older payloads). */
  operation?: GitOperation | null;
  /** HEAD is already on its upstream: amending (or resetting past) it means
   * the next push has to force. False without an upstream. */
  headPushed?: boolean;
};

/** A multi-step git operation that can stop half way for the user. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** How `git reset` treats the index and the working tree. */
export type GitResetMode = 'soft' | 'mixed' | 'hard';

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
};

/** One `git stash list` entry. `parents[0]` is the commit the stash was made
 * on (where the graph hangs its node); `parents[2]`, when present, is the
 * untracked-files commit. `time` is unix seconds. */
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

export type GitCommit = {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  refs: { name: string; type: 'branch' | 'remote' | 'tag'; head: boolean }[];
  subject: string;
};

export type GitLog = {
  repo: boolean;
  commits: GitCommit[];
  headSha: string | null;
};

/** One file touched by a commit (M A D R C; T renders as M). */
export type GitCommitFile = {
  path: string;
  /** Pre-rename/copy path. */
  origPath?: string;
  letter: string;
};

/** Per-file added/removed line counts. `null` = binary (git prints `-`). */
export type GitNumstatEntry = {
  path: string;
  add: number | null;
  del: number | null;
};

/** Whether (and how) a commit's message can be rewritten - the commit detail
 * panel's inline reword affordance. HEAD rewords via `commit --amend --only`;
 * older commits via a scripted `rebase -i` reword, which is only safe for
 * linear first-parent history below the checked-out branch. */
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

/** What a git-dir change invalidates: `status` = the working tree / index
 * moved (stage, unstage, worktree edit); `history` = refs or HEAD may have
 * moved too (commit, checkout, fetch, branch ops), so refs + log need a
 * re-read as well. The renderer scopes its refresh to this - re-walking the
 * history of a big repo on every `git add` is what made the tool feel slow. */
export type GitChangeKind = 'status' | 'history';

/**
 * One thing git ignores in a checkout (`ls-files --others --ignored
 * --exclude-standard --directory`): a path relative to the repo root, folders
 * with a trailing slash. `locked` names why the app never copies it into a
 * worktree; `bytes` is a folder's size when the caller asked for sizes.
 */
export type GitIgnoredEntry = {
  path: string;
  kind: 'file' | 'dir';
  locked?: string;
  bytes?: number;
};
