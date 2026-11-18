import { ipcMain, shell, type WebContents } from 'electron';
import { gitRemoteHooks } from './git-remote-hooks';
import { constants, type FSWatcher } from 'node:fs';
import { isTrustedSender } from './ipc-util';
import {
  buildOutputOf,
  crossPlatform,
  lockedReason,
  partitionLocalSeedPaths,
  partitionSeedPaths,
} from './worktree-seed';
import { runUpload } from './upload';
import nodePath from 'node:path';
import { findChildRepos } from './child-repos';
import {
  NO_PROMPT_ENV,
  localRuntime,
  pathFor,
  runtimeFor,
  runtimeReady,
  type HostWatcher,
} from './host-runtime';
import { gitCredentialsEnv } from './git-credentials';
import { nativePath } from './shell-path';
import type {
  GitIgnoredEntry,
  GitChangeKind,
  GitLog,
  GitNumstatEntry,
  GitOperation,
  GitRefs,
  GitRewordInfo,
  GitStatus,
} from './git-types';
import {
  REF_SEP,
  classifyGitPath,
  countNewFileLines,
  gitErrorLine,
  gitHostKeyFailure,
  hostAuthMessage,
  hostKeyMessage,
  isGitAuthFailure,
  isNoiseGitPath,
  parseBranches,
  parseRemotes,
  parseShortstat,
  parseStashes,
  parseStatus,
  parseUntrackedFiles,
  parseWorktrees,
  parseIgnoredEntries,
} from './git-parse';

/**
 * Git bridge for the workspace's git surfaces. Runs the user's `git` CLI in
 * the session's project directory - no bundled git implementation, so whatever
 * auth/config works in their terminal works here. Follows the fs.ts conventions:
 * handlers never throw across IPC, they resolve `{ error, code? }` instead, and
 * watchers are ref-counted per (window, root).
 */

export const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A hex object id - also excludes option-shaped strings by construction. */
export const isSha = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{4,40}$/i.test(v);

export type ErrResult = { error: string; code?: string };

export const INVALID_PATH: ErrResult = { error: 'Invalid path', code: 'EINVAL' };
export const UNTRUSTED: ErrResult = { error: 'Untrusted sender', code: 'EACCES' };

// --- Shared payload shapes ----------------------------------------------------
// Declared in git-types.ts (which the pure parsers in git-parse.ts also read,
// so they stay Electron-free) and re-exported here - `./git` remains the one
// import site for the bridge's public surface.

export type {
  GitBranch,
  GitChangeKind,
  GitCommit,
  GitCommitFile,
  GitConflict,
  GitFileStatus,
  GitIgnoredEntry,
  GitLog,
  GitNumstatEntry,
  GitOperation,
  GitRefs,
  GitResetMode,
  GitRewordInfo,
  GitStatus,
} from './git-types';

// --- git runner ---------------------------------------------------------------

export type RunResult = { code: number; stdout: string; stderr: string };

export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The files of the machine `path` lives on (host-runtime.ts). */
export const hostFs = (path: string) => runtimeFor(path).fs;

// Path grammar by the machine the path is on (host-runtime.ts › pathFor): a
// remote host's paths stay POSIX on a Windows client.
export const join = (first: string, ...rest: string[]): string =>
  pathFor(first).join(first, ...rest);
const dirname = (p: string): string => pathFor(p).dirname(p);
export const isAbsolute = (p: string): boolean => pathFor(p).isAbsolute(p);
export const relative = (from: string, to: string): string => pathFor(from).relative(from, to);
export const resolve = (p: string): string => pathFor(p).resolve(p);
/** A path git REPORTED, in the app's spelling - Windows' rules for local paths only. */
const reportedPath = (cwd: string, p: string): string =>
  runtimeFor(cwd).remote ? p : nativePath(p);

/**
 * The environment every git run gets, on top of this process's. On a remote
 * host (spec 10.1) only git's own switches travel: the run starts from the
 * host's login env there, and double0's integration auth (askpass, tokens,
 * the ssh wrapper) never leaves this machine - the server's credentials apply.
 * `background` runs (the quiet fetch, prune) also get NO_PROMPT_ENV there.
 */
function gitEnv(
  cwd: string,
  extra?: Record<string, string>,
  background = false,
): NodeJS.ProcessEnv {
  if (runtimeFor(cwd).remote) return {};
  void background;
  return {
    ...process.env,
    // Hosting-integration auth (askpass + host-scoped ssh wrapper) when the
    // user has connected GitHub/GitLab; inert {} otherwise and for other hosts.
    ...gitCredentialsEnv(cwd),
    // Read commands shouldn't take optional locks (no index churn from us),
    // and nothing here is interactive - fail instead of waiting on stdin.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

/**
 * Run git with args in `cwd`, optionally piping `input` to stdin. Resolves with
 * the exit code rather than rejecting on non-zero, so callers branch on `code`.
 * Rejects only when the process can't run at all (git missing, bad cwd). Runs
 * on the machine `cwd` lives on (host-runtime.ts).
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: {
    input?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /** A run nobody asked for (the quiet fetch, prune): no prompts on a host. */
    background?: boolean;
  } = {},
): Promise<RunResult> {
  const once = (): Promise<RunResult> =>
    runtimeFor(cwd).exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      env: gitEnv(cwd, opts.env, opts.background),
      overlayEnv: gitOverlay(cwd, opts.env, opts.background),
      input: opts.input,
      timeoutMs: opts.timeoutMs,
      timeoutMessage: 'git timed out',
      maxStdout: MAX_OUTPUT_BYTES,
      maxStderr: 256 * 1024,
    });
  return runtimeReady().then(async () => {
    const r = await once();
    // A host that has never talked to GitHub / GitLab / Bitbucket over ssh
    // refuses at the host key, before anything is sent - so the run changed
    // nothing and may run again once the service's pinned keys are known
    // there (provider-host-keys.ts). Never for a key the host already has.
    if (r.code === 0) return r;
    const rt = runtimeFor(cwd);
    if (!rt.remote) return r;
    const hostKey = gitHostKeyFailure(r.stderr);
    const hooks = gitRemoteHooks();
    if (!hostKey || !hooks?.hasPinnedKeys(hostKey.server)) return r;
    if ((await hooks.trustProviderHostKey(rt, hostKey.server)) !== 'added') return r;
    return once();
  });
}

/**
 * What a remote git run sends verbatim (ExecOptions.overlayEnv): git's own
 * switches, NO_PROMPT_ENV for a background run, the caller's extras. Never
 * the laptop's env or double0's integration auth (spec 10.1). Undefined
 * locally - `gitEnv` already holds everything there.
 */
function gitOverlay(
  cwd: string,
  extra?: Record<string, string>,
  background = false,
): Record<string, string> | undefined {
  if (!runtimeFor(cwd).remote) return undefined;
  return {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...(background ? NO_PROMPT_ENV : {}),
    ...extra,
  };
}

type RunBinaryResult = { code: number; stdout: Buffer; stderr: string };

/**
 * Like runGit, but keeps stdout as raw bytes (no utf8 decode) - for reading
 * binary blobs (`git show <rev>:<path>` on an image) that would be corrupted by
 * the text runner's `setEncoding('utf8')`.
 */
export function runGitBinary(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunBinaryResult> {
  return runtimeReady().then(() =>
    runtimeFor(cwd).execBinary('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      env: gitEnv(cwd),
      overlayEnv: gitOverlay(cwd),
      timeoutMs: opts.timeoutMs,
      timeoutMessage: 'git timed out',
      maxStdout: MAX_OUTPUT_BYTES,
      maxStderr: 256 * 1024,
    }),
  );
}

export const NOT_REPO = /not a git repository/i;

/**
 * Ceiling for the per-cwd caches below. They grow with the number of repos and
 * worktrees a session touches - modest in practice, but nothing ever evicted
 * them, so an app left running for days kept an entry for every folder it had
 * ever looked at. Map/Set preserve insertion order, so dropping from the front
 * evicts the least recently ADDED key, which is the right approximation here:
 * these are all cheap to recompute on a miss.
 */
const CACHE_MAX = 256;

export function capCache(
  cache: { size: number; keys(): IterableIterator<string>; delete(key: string): boolean },
  max = CACHE_MAX,
): void {
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

// --- commit-graph assist --------------------------------------------------------
// `git log --topo-order`, `rev-list --count` and per-branch ahead/behind all walk
// the commit DAG; a commit-graph file (generation numbers) makes those walks
// near-instant. `git gc` writes one by default since git 2.24, but big repos that
// never gc'd locally won't have it - so when a history read turns out slow, write
// one in the background, once per repo per session. `--split` appends an
// increment instead of rewriting the whole graph, so refreshing an existing one
// is cheap; failures (shallow clone, ancient git) are silently irrelevant.

const COMMIT_GRAPH_SLOW_MS = 400;
const commitGraphAttempted = new Set<string>();

export function maybeWriteCommitGraph(cwd: string, elapsedMs: number): void {
  if (elapsedMs < COMMIT_GRAPH_SLOW_MS || commitGraphAttempted.has(cwd)) return;
  commitGraphAttempted.add(cwd);
  capCache(commitGraphAttempted);
  runGit(cwd, ['commit-graph', 'write', '--reachable', '--split'], {
    timeoutMs: 10 * 60_000,
  }).catch(() => {});
}

/** Shape a failed run for the renderer: the telling stderr line, else a fallback. */
export function gitError(r: RunResult, fallback: string): ErrResult {
  const message = gitErrorLine(r.stderr) || gitErrorLine(r.stdout) || fallback;
  return { error: message.slice(0, 300) };
}

/**
 * A push / pull / fetch failure: on a remote host whose credentials were
 * refused, the copy says whose and what to do (spec 10.1, code EREMOTEAUTH).
 */
export function remoteGitError(cwd: string, r: RunResult, fallback: string): ErrResult {
  const remote = runtimeFor(cwd).remote;
  if (!remote) return gitError(r, fallback);
  // An empty label reads as the id, never as "'s credentials".
  const label = remote.label?.() || remote.hostId;
  const hostKey = gitHostKeyFailure(r.stderr);
  if (hostKey) return { error: hostKeyMessage(label, hostKey.server), code: 'EHOSTKEY' };
  if (isGitAuthFailure(r.stderr)) return { error: hostAuthMessage(label), code: 'EREMOTEAUTH' };
  return gitError(r, fallback);
}

/**
 * On-disk size of a folder via `du -sk` (macOS/Linux) - undefined on Windows
 * or when du can't answer. du exits non-zero for an unreadable subfolder but
 * still prints the total, so the exit code is ignored when a number came back.
 */
function dirSizeBytes(dir: string): Promise<number | undefined> {
  const rt = runtimeFor(dir);
  // A remote host is POSIX whatever this machine is; `du` runs there.
  if (process.platform === 'win32' && !rt.remote) return Promise.resolve(undefined);
  return rt
    .exec('du', ['-sk', dir], { cwd: dir, timeoutMs: 15_000, maxStdout: 4096, maxStderr: 4096 })
    .then(
      (r) => {
        const kb = Number.parseInt(r.stdout.trim().split(/\s/)[0] ?? '', 10);
        return Number.isFinite(kb) ? kb * 1024 : undefined;
      },
      () => undefined,
    );
}

/** The OS bin locally; a remote host's own trash folder there (spec 7.5). */
export function trashPath(path: string): Promise<void> {
  const rt = runtimeFor(path);
  return rt.trash ? rt.trash(path) : shell.trashItem(path);
}

export function spawnError(err: unknown): ErrResult {
  // A remote host that is not connected says so (spec 1.3) - the renderer
  // words it as unreachable, never as "git failed".
  if ((err as NodeJS.ErrnoException | null)?.code === 'EHOSTDOWN') {
    return { error: 'Host is unreachable', code: 'EHOSTDOWN' };
  }
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
    return { error: 'git is not installed (or not on PATH)', code: 'ENOGIT' };
  }
  return { error: err instanceof Error ? err.message : 'git failed', code: 'ESPAWN' };
}

// --- reword -------------------------------------------------------------------

/**
 * Work out whether `sha`'s message can be rewritten right now. Reword is only
 * offered for non-merge commits reachable from the checked-out branch through
 * merge-free history (a reword rebase would flatten merges otherwise), and not
 * while a merge/rebase/cherry-pick is paused.
 */
export async function probeReword(
  cwd: string,
  sha: string,
): Promise<{ info: GitRewordInfo; parents: string[] } | ErrResult> {
  try {
    const [full, head, symref, parentsR, remoteR, gitDirR] = await Promise.all([
      runGit(cwd, ['rev-parse', '--verify', `${sha}^{commit}`]),
      runGit(cwd, ['rev-parse', 'HEAD']),
      runGit(cwd, ['symbolic-ref', '-q', 'HEAD']),
      runGit(cwd, ['show', '-s', '--format=%P', sha]),
      runGit(cwd, ['branch', '-r', '--contains', sha, '--format=%(refname)']),
      runGit(cwd, ['rev-parse', '--absolute-git-dir']),
    ]);
    if (full.code !== 0) return gitError(full, 'Unknown commit');
    if (head.code !== 0) return gitError(head, 'Could not resolve HEAD');
    const fullSha = full.stdout.trim();
    const parents = parentsR.code === 0 ? parentsR.stdout.trim().split(/\s+/).filter(Boolean) : [];
    let inProgress = false;
    if (gitDirR.code === 0) {
      const gitDir = gitDirR.stdout.trim();
      const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'];
      const present = await Promise.all(
        markers.map((m) =>
          hostFs(gitDir)
            .stat(join(gitDir, m))
            .then(
              () => true,
              () => false,
            ),
        ),
      );
      inProgress = present.some(Boolean);
    }
    const isHead = head.stdout.trim() === fullSha;
    const onRemote = remoteR.code === 0 && remoteR.stdout.trim().length > 0;
    let reason: GitRewordInfo['reason'] = null;
    if (inProgress) reason = 'in-progress';
    else if (symref.code !== 0) reason = 'detached';
    else if (parents.length > 1) reason = 'merge-commit';
    else if (!isHead) {
      const ancestor = await runGit(cwd, ['merge-base', '--is-ancestor', fullSha, 'HEAD']);
      if (ancestor.code !== 0) reason = 'not-on-branch';
      else {
        const merges = await runGit(cwd, ['rev-list', '--merges', '-n', '1', `${fullSha}..HEAD`]);
        if (merges.code !== 0 || merges.stdout.trim()) reason = 'merges-between';
      }
    }
    return { info: { eligible: reason === null, reason, isHead, onRemote }, parents };
  } catch (err) {
    return spawnError(err);
  }
}

export const REWORD_BLOCKED: Record<NonNullable<GitRewordInfo['reason']>, string> = {
  'in-progress': 'A merge or rebase is in progress',
  detached: 'Cannot reword on a detached HEAD',
  'merge-commit': 'Merge commits cannot be reworded',
  'not-on-branch': 'Commit is not on the checked-out branch',
  'merges-between': 'History above this commit contains a merge',
};

// Full-shape "not a repository" payloads, so the renderer never reads fields
// off a partial object.
const NO_REPO_STATUS: GitStatus = {
  repo: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  userName: null,
  userEmail: null,
  mergeMsg: null,
  operation: null,
  headPushed: false,
};
const NO_REPO_REFS: GitRefs = {
  repo: false,
  branches: [],
  remotes: [],
  worktrees: [],
  stashes: [],
  tags: [],
  fetchedAt: null,
};
export const NO_REPO_LOG: GitLog = { repo: false, commits: [], headSha: null };

/** Absolute git dir per cwd (for linked worktrees `.git` is a file pointing
 * elsewhere). Cached for the session - it can't move for a given cwd - which
 * saves one spawn per status/refs read. Only successes are cached, so a folder
 * `git init`ed later still resolves. */
const gitDirCache = new Map<string, string>();

async function resolveGitDir(cwd: string): Promise<string | null> {
  const hit = gitDirCache.get(cwd);
  if (hit) return hit;
  const r = await runGit(cwd, ['rev-parse', '--git-dir']);
  if (r.code !== 0) return null;
  const dir = r.stdout.trim();
  const abs = isAbsolute(dir) ? dir : join(cwd, dir);
  gitDirCache.set(cwd, abs);
  capCache(gitDirCache);
  return abs;
}

/** First line of .git/MERGE_MSG (git's prepared merge/cherry-pick commit
 * message), or null when no merge is pending. */
export async function readMergeMsg(cwd: string): Promise<string | null> {
  try {
    const dir = await resolveGitDir(cwd);
    if (!dir) return null;
    const raw = await hostFs(dir).readFile(join(dir, 'MERGE_MSG'), 'utf8');
    const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    return line?.trim() || null;
  } catch {
    return null; // no MERGE_MSG - nothing pending
  }
}

/**
 * The multi-step operation paused in this checkout, from the marker files git
 * leaves in the git dir while it waits for the user. A rebase is checked
 * first: one stopped on a conflict also leaves CHERRY_PICK_HEAD behind.
 */
async function readOperation(cwd: string): Promise<GitOperation | null> {
  const dir = await resolveGitDir(cwd);
  if (!dir) return null;
  const has = (name: string): Promise<boolean> =>
    hostFs(dir)
      .stat(join(dir, name))
      .then(
        () => true,
        () => false,
      );
  if ((await has('rebase-merge')) || (await has('rebase-apply'))) return 'rebase';
  if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await has('REVERT_HEAD')) return 'revert';
  if (await has('MERGE_HEAD')) return 'merge';
  return null;
}

// --- .git watching --------------------------------------------------------------
// Same ref-counting scheme as fs.ts, but watching the resolved git dir so index /
// HEAD / refs changes (commits, stages, checkouts made from any terminal) notify
// the renderer. Object-store and lock churn is filtered out before debouncing.

type GitWatch = {
  watcher: FSWatcher;
  sender: WebContents;
  wcId: number;
  root: string;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Widest kind seen while the debounce timer runs ('history' wins). */
  pendingKind: GitChangeKind | null;
};

const gitWatchers = new Map<string, GitWatch>();
const watchKey = (wcId: number, root: string): string => `${wcId}::${root}`;

function closeGitWatch(entry: GitWatch): void {
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    // already closed
  }
}

/** Close every git watcher owned by a window (mirrors disposeFsWatchersForWindow). */
export function disposeGitWatchersForWindow(wcId: number): void {
  for (const [key, entry] of gitWatchers) {
    if (entry.wcId === wcId) {
      closeGitWatch(entry);
      gitWatchers.delete(key);
    }
  }
}

const CHANNELS = [
  'git:status',
  'git:repoRoot',
  'git:childRepos',
  'git:sessionStats',
  'git:refs',
  'git:show',
  'git:createBranch',
  'git:deleteBranch',
  'git:worktreeAdd',
  'git:worktreeRemove',
  'git:ignoredEntries',
  'git:worktreeSeed',
  'git:seedFromLocal',
  'git:watch',
  'git:unwatch',
] as const;

/**
 * History scope when the graph has no branch filter. Plain `--all` also walks
 * git's bookkeeping refs and renders their commits as live history:
 * `refs/original/*` (filter-branch backups - after an author rewrite the whole
 * pre-rewrite history, old identities included, kept showing in the graph),
 * `refs/rewritten/*` (in-flight rebase state), `refs/bisect/*`, and
 * `refs/notes/*` (commits that hold note blobs, not history). `refs/stash` is
 * excluded too: walking it renders the stash's WIP merge plus its `index on…`
 * / `untracked files on…` helper parents as ordinary commits - the graph
 * instead draws one stash node per `stash list` entry (see the renderer's
 * insertStashRows). `--exclude` only scopes the `--all` that follows it, so
 * the order here matters. Branches, remotes, tags and HEAD stay in.
 */
export const HISTORY_SCOPE: readonly string[] = [
  '--exclude=refs/original/*',
  '--exclude=refs/rewritten/*',
  '--exclude=refs/bisect/*',
  '--exclude=refs/notes/*',
  '--exclude=refs/stash',
  '--all',
];

/**
 * Extra history tips for the unscoped walk: each stash's FIRST parent - the
 * commit it was stashed from. The stash commits themselves stay out (see
 * HISTORY_SCOPE), but that base commit can be unreachable from every branch
 * (stashed on a since-deleted or rebased-away branch, kept alive only by the
 * stash) - without its chain in the walk the graph has nowhere to hang the
 * stash node and `git:locate` can't scroll to it. Every unscoped walk
 * (git:log, git:logTotal, git:locate) must use the same tips or their row
 * indexes and counts drift apart.
 */
export async function stashParentTips(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ['stash', 'list', '--format=%P']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter((sha) => /^[0-9a-f]{4,40}$/i.test(sha));
}

/**
 * Every status read lists untracked files one by one. Git's default collapses
 * a brand-new directory into a single `docs/` entry, which the Changes list
 * rendered as a folder row with no diff while the files inside stayed
 * invisible, and the discard handlers (which re-read status to resolve the
 * clicked path) matched nothing. Explicit so a user's
 * `status.showUntrackedFiles` config cannot bring the folder rows back.
 */
export const UNTRACKED_ALL = ['--untracked-files=all'] as const;

/** A new file bigger than this is listed without a line count: the counts are
 * re-read after every change in the folder, and the diff view refuses a patch
 * this size anyway. */
const UNTRACKED_FILE_MAX = 2 * 1024 * 1024;
/** Bytes one read may pull in across all new files - an unignored build folder
 * can hold thousands. Files past it are listed without a count. */
const UNTRACKED_READ_BUDGET = 32 * 1024 * 1024;

/**
 * Line counts of the untracked files, which `diff` against HEAD never sees: a
 * session whose only work is new files (an agent writing a spec and a plan)
 * read as clean in the sidebar while the Changes list held both. Each file
 * counts as all-added lines, as it will once staged; a binary, oversized or
 * vanished file, or a symlink, carries null counts. Paths are repo-relative
 * and cover the whole repo, like `diff`'s, whichever folder `cwd` is.
 */
export async function untrackedNumstat(cwd: string): Promise<GitNumstatEntry[]> {
  const r = await runGit(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--full-name',
    '-z',
    '--',
    ':/',
  ]);
  if (r.code !== 0) return [];
  const paths = parseUntrackedFiles(r.stdout);
  if (paths.length === 0) return [];
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return [];
  const root = top.stdout.trim();
  let budget = UNTRACKED_READ_BUDGET;
  const entries: GitNumstatEntry[] = [];
  for (const path of paths) {
    let add: number | null = null;
    try {
      const file = join(root, path);
      const info = await hostFs(file).lstat(file);
      if (info.isFile() && info.size <= Math.min(UNTRACKED_FILE_MAX, budget)) {
        budget -= info.size;
        add = countNewFileLines(await hostFs(file).readFile(file));
      }
    } catch {
      // Gone between the listing and the read - an agent mid-rename.
    }
    entries.push({ path, add, del: add == null ? null : 0 });
  }
  return entries;
}

export type GitIpcDeps = {
  /**
   * A host's `<os>-<arch>` (its facts, `linux-x64`), or null when unknown -
   * a copy from this computer refuses build output across platforms (plan 29 spec › 9.2).
   */
  hostPlatform?: (hostId: string) => string | null;
};

/** This computer's `<os>-<arch>`, spelled as a host's facts spell it. */
const LOCAL_PLATFORM = `${process.platform}-${process.arch}`;

/** Seed files land owner-only: they are `.env`s and keys (spec › 9.2). */
export const LOCAL_SEED_MODE = 0o600;

/** Run a plain mutating git command, mapping failure to `{error}`. */
export async function mutate(
  cwd: string,
  args: string[],
  fallback: string,
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ ok: true } | ErrResult> {
  try {
    const r = await runGit(cwd, args, opts);
    if (r.code !== 0) return gitError(r, fallback);
    return { ok: true };
  } catch (err) {
    return spawnError(err);
  }
}

export function registerGitIpc(deps: GitIpcDeps = {}): () => void {
  ipcMain.handle('git:status', async (e, payload: { cwd?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
    try {
      // All four reads are independent - one parallel round instead of two
      // sequential ones (status itself dominates; the rest finish under it).
      const [r, user, email, mergeMsg, operation, pushed] = await Promise.all([
        runGit(payload.cwd, ['status', '--porcelain=v2', '--branch', '-z', ...UNTRACKED_ALL]),
        runGit(payload.cwd, ['config', 'user.name']),
        runGit(payload.cwd, ['config', 'user.email']),
        readMergeMsg(payload.cwd),
        readOperation(payload.cwd),
        // Exit 0 = HEAD is an ancestor of (or equal to) its upstream: already
        // pushed. Fails harmlessly without an upstream or on an unborn branch.
        runGit(payload.cwd, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']),
      ]);
      if (r.code !== 0) {
        if (NOT_REPO.test(r.stderr)) return { status: NO_REPO_STATUS };
        return gitError(r, 'Could not read git status');
      }
      const status: GitStatus = {
        repo: true,
        userName: user.code === 0 ? user.stdout.trim() || null : null,
        userEmail: email.code === 0 ? email.stdout.trim() || null : null,
        mergeMsg,
        operation,
        ...parseStatus(r.stdout),
        headPushed: false,
      };
      status.headPushed = status.upstream != null && pushed.code === 0;
      return { status };
    } catch (err) {
      return spawnError(err);
    }
  });

  /**
   * The root of the repository containing `cwd` - `{ root: null }` when the
   * folder is in no repo at all. A project can hold several independent repos
   * (a folder-of-repos checkout), so a task/session rooted at a subfolder needs
   * to know which repo to cut its worktree from; `--show-toplevel` answers that
   * whichever level of the tree the folder sits at.
   *
   * `--show-toplevel` reports the *worktree* root, which is what callers want:
   * a folder already inside a linked worktree resolves to that worktree, not to
   * the main checkout.
   */
  ipcMain.handle('git:repoRoot', async (e, payload: { cwd?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
    try {
      const r = await runGit(payload.cwd, ['rev-parse', '--show-toplevel']);
      if (r.code !== 0) {
        // "not a git repository" is an answer, not a failure - the caller runs
        // the session plainly in the folder instead of erroring at the user.
        if (NOT_REPO.test(r.stderr)) return { root: null };
        return gitError(r, 'Could not resolve the repository root');
      }
      return { root: reportedPath(payload.cwd, r.stdout.trim()) || null };
    } catch (err) {
      return spawnError(err);
    }
  });

  /**
   * The checkouts directly under `cwd` when `cwd` itself is in no repository -
   * a folder-of-repos project (`acme/` holding `api/`, `web/`, …). A tool
   * offers them in a repo picker instead of reporting "not a git repository". Empty for a folder inside a repo: there the tools
   * already have their repo, and nested checkouts are the repo's business.
   */
  ipcMain.handle('git:childRepos', async (e, payload: { cwd?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
    try {
      const r = await runGit(payload.cwd, ['rev-parse', '--show-toplevel']);
      if (r.code === 0) return { repos: [] };
      if (!NOT_REPO.test(r.stderr)) return gitError(r, 'Could not list the repositories');
      return { repos: await findChildRepos(payload.cwd) };
    } catch (err) {
      return spawnError(err);
    }
  });

  /**
   * Added/removed line counts of a session's uncommitted work (worktree vs
   * HEAD, so staged edits count too - the same basis as the session-changes
   * drawer, so the row's counts vanish when the work is committed), plus the
   * lines of every new, untracked file (see untrackedNumstat). An unborn HEAD
   * degrades to the unstaged-only diff. Feeds the sidebar session rows - cheap
   * enough to poll per session.
   */
  ipcMain.handle('git:sessionStats', async (e, payload: { cwd?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
    const cwd = payload.cwd;
    const ZERO = { add: 0, del: 0 };
    try {
      let r = await runGit(cwd, ['diff', '--shortstat', 'HEAD']);
      if (r.code !== 0 && /bad revision|ambiguous argument/i.test(r.stderr)) {
        r = await runGit(cwd, ['diff', '--shortstat']);
      }
      if (r.code !== 0) {
        // Not a repo: nothing to count - the row shows no stats.
        if (NOT_REPO.test(r.stderr)) return { stats: ZERO };
        return gitError(r, 'Could not read diff stats');
      }
      const stats = parseShortstat(r.stdout);
      for (const entry of await untrackedNumstat(cwd)) stats.add += entry.add ?? 0;
      return { stats };
    } catch (err) {
      return spawnError(err);
    }
  });

  ipcMain.handle('git:refs', async (e, payload: { cwd?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
    const cwd = payload.cwd;
    try {
      // All six reads are independent - one parallel round. Note the branch
      // format deliberately omits %(upstream:track): it costs a graph walk per
      // branch, which dominates the whole call on many-branch repos. The
      // renderer fetches it separately (git:refsTrack) and fills it in.
      const [local, remoteRefs, remoteList, wt, stash, tagsOut, gitDir] = await Promise.all([
        runGit(cwd, [
          'for-each-ref',
          'refs/heads',
          `--format=%(refname:short)${REF_SEP}%(HEAD)${REF_SEP}%(upstream:short)`,
        ]),
        runGit(cwd, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']),
        runGit(cwd, ['remote']),
        runGit(cwd, ['worktree', 'list', '--porcelain']),
        runGit(cwd, [
          'stash',
          'list',
          `--format=%gd${REF_SEP}%H${REF_SEP}%P${REF_SEP}%an${REF_SEP}%ae${REF_SEP}%at${REF_SEP}%gs`,
        ]),
        runGit(cwd, ['tag', '--sort=-creatordate']),
        resolveGitDir(cwd),
      ]);
      if (local.code !== 0) {
        if (NOT_REPO.test(local.stderr)) return { refs: NO_REPO_REFS };
        return gitError(local, 'Could not list branches');
      }
      // Branch ahead/behind/gone come back zeroed - git:refsTrack fills them in
      // (deferred; see the format note above).
      const branches = parseBranches(local.stdout);
      const remotes = parseRemotes(remoteList.stdout, remoteRefs.stdout);
      const worktrees = parseWorktrees(wt.stdout).map((w) => ({
        ...w,
        path: reportedPath(cwd, w.path),
      }));
      const stashes = parseStashes(stash.stdout);
      const tags = tagsOut.stdout.split('\n').filter(Boolean);

      // FETCH_HEAD's mtime = last fetch/pull.
      let fetchedAt: number | null = null;
      if (gitDir) {
        try {
          fetchedAt = (await hostFs(gitDir).stat(join(gitDir, 'FETCH_HEAD'))).mtimeMs;
        } catch {
          fetchedAt = null; // never fetched
        }
      }

      const refs: GitRefs = { repo: true, branches, remotes, worktrees, stashes, tags, fetchedAt };
      return { refs };
    } catch (err) {
      return spawnError(err);
    }
  });

  // The INDEX version of one file (`git show :0:<rel>`) - the editor gutter's
  // diff base, so unstaged edits light up and staged ones don't. `path` arrives
  // absolute; a file outside the repo (or not in the index - untracked) resolves
  // `content: null`, which the renderer treats as "everything is new".
  ipcMain.handle('git:show', async (e, payload: { cwd?: unknown; path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.cwd) || !isNonEmptyStr(payload?.path)) return INVALID_PATH;
    const rel = relative(payload.cwd, payload.path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return { error: 'File is outside the repository', code: 'EOUTSIDE' };
    }
    try {
      const r = await runGit(payload.cwd, [
        'show',
        `:0:${rel.split(pathFor(payload.cwd).sep).join('/')}`,
      ]);
      if (r.code !== 0) {
        if (NOT_REPO.test(r.stderr)) return { error: 'Not a git repository', code: 'ENOREPO' };
        // Not in the index (untracked / newly created): a valid, empty base.
        return { content: null };
      }
      if (r.stdout.length > 8 * 1024 * 1024) {
        return { error: 'File is too large to diff', code: 'TOO_LARGE' };
      }
      if (r.stdout.slice(0, 8000).includes('\0')) return { binary: true };
      return { content: r.stdout };
    } catch (err) {
      return spawnError(err);
    }
  });

  // Create a worktree at `path` on a new branch `branch` (off current HEAD),
  // run from the repo at `cwd`. Then ensure `.worktree/` is gitignored so the
  // linked-worktree dirs don't show up as untracked in the parent repo.
  ipcMain.handle(
    'git:worktreeAdd',
    async (e, payload: { cwd?: unknown; path?: unknown; branch?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.cwd) || !isNonEmptyStr(payload?.path)) return INVALID_PATH;
      const args = isNonEmptyStr(payload.branch)
        ? ['worktree', 'add', '-b', payload.branch, payload.path]
        : ['worktree', 'add', payload.path];
      const res = await mutate(payload.cwd, args, 'Could not create worktree');
      if ('ok' in res) {
        try {
          const gitignore = join(payload.cwd, '.gitignore');
          const existing = await hostFs(gitignore)
            .readFile(gitignore, 'utf8')
            .catch(() => '');
          if (!/^\.worktree\/?\s*$/m.test(existing)) {
            const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
            await hostFs(gitignore).writeFile(
              gitignore,
              `${existing}${prefix}.worktree/\n`,
              'utf8',
            );
          }
        } catch {
          // Best-effort - a missing/unwritable .gitignore shouldn't fail the worktree.
        }
      }
      return res;
    },
  );

  // Remove a worktree. Resolve the MAIN worktree (first `worktree list` entry)
  // and run the removal from there - git refuses to remove the worktree you're
  // currently standing in (which is the session's own cwd).
  ipcMain.handle(
    'git:worktreeRemove',
    async (e, payload: { cwd?: unknown; path?: unknown; force?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.cwd) || !isNonEmptyStr(payload?.path)) return INVALID_PATH;
      try {
        const list = await runGit(payload.cwd, ['worktree', 'list', '--porcelain']);
        if (list.code !== 0) return gitError(list, 'Could not list worktrees');
        const firstLine = list.stdout.split('\n').find((l) => l.startsWith('worktree '));
        const mainRoot = firstLine ? firstLine.slice(9) : payload.cwd;
        const args = ['worktree', 'remove'];
        if (payload.force === true) args.push('--force');
        args.push(payload.path);
        return await mutate(mainRoot, args, 'Could not remove worktree');
      } catch (err) {
        return spawnError(err);
      }
    },
  );

  // Everything git ignores in the checkout containing `cwd`, relative to its
  // root - the source list for Settings → Worktrees → project. Folders the app
  // never copies come back `locked` (see worktree-seed.ts). With `sizes`,
  // ignored folders carry their on-disk size - a `du` per folder, slow on a
  // big node_modules, so the project list asks without and only the project's
  // own screen asks with.
  // `fileSizes` adds each ignored FILE's size too (an lstat each) - the laptop
  // seed list shows them against its 64 MiB cap (plan 29 spec › 9.2).
  ipcMain.handle(
    'git:ignoredEntries',
    async (e, payload: { cwd?: unknown; sizes?: unknown; fileSizes?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.cwd)) return INVALID_PATH;
      try {
        const top = await runGit(payload.cwd, ['rev-parse', '--show-toplevel']);
        if (top.code !== 0) {
          // Not a repo is an answer: such a project can't have worktrees at all.
          if (NOT_REPO.test(top.stderr)) return { root: null, entries: [] };
          return gitError(top, 'Could not resolve the repository root');
        }
        const root = top.stdout.trim();
        const r = await runGit(root, [
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
          '-z',
        ]);
        if (r.code !== 0) return gitError(r, 'Could not list ignored files');
        const entries: GitIgnoredEntry[] = parseIgnoredEntries(r.stdout).map((entry) => {
          const locked = lockedReason(entry.path);
          return locked ? { ...entry, locked } : entry;
        });
        if (payload.sizes === true) {
          await Promise.all(
            entries.map(async (entry) => {
              if (entry.kind !== 'dir' || entry.locked) return;
              const bytes = await dirSizeBytes(join(root, entry.path));
              if (bytes != null) entry.bytes = bytes;
            }),
          );
        }
        if (payload.fileSizes === true) {
          await Promise.all(
            entries.map(async (entry) => {
              if (entry.kind !== 'file') return;
              const st = await hostFs(root)
                .lstat(join(root, entry.path))
                .catch(() => null);
              if (st?.isFile()) entry.bytes = Number(st.size);
            }),
          );
        }
        return { root: reportedPath(root, root), entries };
      } catch (err) {
        return spawnError(err);
      }
    },
  );

  // Copy a project's chosen ignored paths from its checkout into a freshly
  // created worktree at the same relative paths - folders whole, copy-on-write
  // where the filesystem allows it (an APFS clone costs no disk). Best-effort
  // per path: one that vanished since the scan is skipped, one that fails is
  // reported, and the launch goes on either way. The renderer sends what the
  // user ticked, but the file system is main's to guard: only repo-relative
  // paths that stay inside the root and aren't locked are copied.
  ipcMain.handle(
    'git:worktreeSeed',
    async (e, payload: { repoRoot?: unknown; worktreePath?: unknown; paths?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.repoRoot) || !isNonEmptyStr(payload?.worktreePath)) {
        return INVALID_PATH;
      }
      const from = resolve(payload.repoRoot);
      const to = resolve(payload.worktreePath);
      if (from === to) return INVALID_PATH;
      const { paths, rejected } = partitionSeedPaths(payload.paths);
      // One host holds both checkouts: the copy runs there (reflink included).
      const seedFs = hostFs(from);
      const copied: string[] = [];
      const skipped: string[] = [...rejected];
      const errors: { path: string; message: string }[] = [];
      for (const rel of paths) {
        const clean = rel.replace(/\/+$/, '');
        const src = join(from, clean);
        const dst = join(to, clean);
        try {
          const st = await seedFs.lstat(src).catch(() => null);
          if (!st) {
            skipped.push(rel);
            continue;
          }
          await seedFs.mkdir(dirname(dst), { recursive: true });
          await seedFs.cp(src, dst, {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
            mode: constants.COPYFILE_FICLONE,
          });
          copied.push(rel);
        } catch (err) {
          errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return { copied, skipped, errors };
    },
  );

  // Copy what the user ticked from THIS computer's checkout of the repo into
  // a new worktree on a host (plan 29 spec › 9.2): repo-relative paths,
  // re-checked here with the worktree seed's rules plus the build-output rule
  // across platforms; every file written 0600, an existing one replaced.
  // Answers like `git:worktreeSeed`.
  ipcMain.handle(
    'git:seedFromLocal',
    async (e, payload: { sourceRoot?: unknown; worktreePath?: unknown; paths?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      await runtimeReady();
      const sourceRoot = payload?.sourceRoot;
      const worktreePath = payload?.worktreePath;
      if (!isNonEmptyStr(sourceRoot) || !isNonEmptyStr(worktreePath)) return INVALID_PATH;
      if (!Array.isArray(payload?.paths)) return INVALID_PATH;
      // The source is this computer's checkout; the destination a host's.
      const source = runtimeFor(sourceRoot);
      const dest = runtimeFor(worktreePath);
      if (source.remote || !nodePath.isAbsolute(sourceRoot)) {
        return { error: 'The source must be a folder on this computer', code: 'EINVAL' };
      }
      if (!dest.remote || !worktreePath.startsWith('/')) {
        return { error: 'The worktree must be on a host', code: 'EINVAL' };
      }
      try {
        // A checkout's own top level - never a folder inside one, never a
        // path that only looks like one.
        const top = await runGit(sourceRoot, ['rev-parse', '--show-toplevel']);
        if (
          top.code !== 0 ||
          nodePath.resolve(nativePath(top.stdout.trim())) !== nodePath.resolve(sourceRoot)
        ) {
          return { error: 'The source is not a repository root', code: 'EINVAL' };
        }
        const st = await dest.fs.stat(worktreePath);
        if (!st.isDirectory()) return { error: 'Not a folder', code: 'ENOTDIR' };
      } catch (err) {
        return spawnError(err);
      }
      const crossOs = crossPlatform(
        LOCAL_PLATFORM,
        deps.hostPlatform?.(dest.remote.hostId) ?? null,
      );
      const { paths, rejected } = partitionLocalSeedPaths(payload.paths, { crossOs });
      const skipped: string[] = rejected.map((r) => r.path);
      const errors: { path: string; message: string }[] = [];
      if (paths.length === 0) return { copied: [], skipped, errors };
      const clean = paths.map((p) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
      const result = await runUpload({
        id: `seed${Date.now().toString(36)}`,
        source: { fs: localRuntime.fs, path: nodePath },
        dest: { fs: dest.fs, path: nodePath.posix },
        destDir: worktreePath,
        items: clean.map((rel) => ({
          localPath: nodePath.join(sourceRoot, ...rel.split('/')),
          rel,
        })),
        onClash: 'replace',
        mode: LOCAL_SEED_MODE,
        // Inside a ticked folder too: no nested build output across platforms.
        refuse: (rel) => {
          const out = crossOs ? buildOutputOf(rel) : null;
          return out ? `${out} is built for this computer's OS` : null;
        },
      }).catch((err: unknown) => err as Error);
      if (result instanceof Error) return spawnError(result);
      if ('clash' in result) return { copied: [], skipped, errors }; // never with 'replace'
      if ('refused' in result) return { error: result.refused, code: 'ETOOMANY' };
      if (result.unreachable) return { error: 'Host is unreachable', code: 'EHOSTDOWN' };
      // Per requested path: copied when every file under it landed.
      const copied: string[] = [];
      clean.forEach((rel, i) => {
        const under = (p: string): boolean => p === rel || p.startsWith(`${rel}/`);
        const failed = result.errors.filter((x) => under(x.path));
        const missed = result.skipped.filter((x) => under(x.path.replace(/\/$/, '')));
        errors.push(...failed);
        if (failed.length > 0) return;
        // A ticked folder none of whose files landed (each past the cap, say)
        // was not copied, whatever empty folder it left behind.
        const nothingLanded = missed.length > 0 && !result.copied.some(under);
        if (nothingLanded || missed.some((x) => x.path.replace(/\/$/, '') === rel)) {
          skipped.push(paths[i]);
        } else copied.push(paths[i]);
        // Left out inside a ticked folder (a nested build output folder, a link).
        for (const x of missed) if (x.path.replace(/\/$/, '') !== rel) skipped.push(x.path);
      });
      return { copied, skipped, errors };
    },
  );

  ipcMain.handle(
    'git:createBranch',
    (e, payload: { cwd?: unknown; name?: unknown; checkout?: unknown; from?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.cwd) || !isNonEmptyStr(payload?.name)) return INVALID_PATH;
      const name = payload.name.trim();
      if (!name || name.startsWith('-')) return { error: 'Invalid branch name', code: 'EINVAL' };
      // Start point - a commit sha (defaults to HEAD); `switch -c` also checks it out.
      const from = isNonEmptyStr(payload.from) ? payload.from.trim() : null;
      if (from && from.startsWith('-')) return { error: 'Invalid start point', code: 'EINVAL' };
      return payload.checkout === true
        ? mutate(
            payload.cwd,
            from ? ['switch', '-c', name, from] : ['switch', '-c', name],
            'Could not create the branch',
          )
        : mutate(
            payload.cwd,
            from ? ['branch', '--', name, from] : ['branch', '--', name],
            'Could not create the branch',
          );
    },
  );

  ipcMain.handle(
    'git:deleteBranch',
    (e, payload: { cwd?: unknown; name?: unknown; force?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      if (!isNonEmptyStr(payload?.cwd) || !isNonEmptyStr(payload?.name)) return INVALID_PATH;
      const name = payload.name.trim();
      if (!name || name.startsWith('-')) return { error: 'Invalid branch name', code: 'EINVAL' };
      // -d refuses unmerged branches; the renderer asks again and retries with -D.
      return mutate(
        payload.cwd,
        ['branch', payload.force === true ? '-D' : '-d', '--', name],
        'Could not delete the branch',
      );
    },
  );

  // Watch the repo's git dir so commits/stages/checkouts made anywhere (the
  // agent's shell, another terminal) refresh the Changes UI. Worktree file edits
  // are already covered by the fs.ts project watcher (which ignores .git).
  ipcMain.handle('git:watch', async (event, payload: { root?: unknown }) => {
    if (!isTrustedSender(event)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.root)) return INVALID_PATH;
    const root = payload.root;
    const sender = event.sender;
    const key = watchKey(sender.id, root);
    const existing = gitWatchers.get(key);
    if (existing) {
      existing.refs++;
      return { ok: true };
    }
    let gitDir: string | null;
    try {
      gitDir = await resolveGitDir(root);
      if (!gitDir) return { error: 'Not a git repository' };
    } catch (err) {
      return spawnError(err);
    }
    // Another watch on this root may have landed while git answered (a view's
    // Changes provider and the sidebar's diff stats ask together on mount).
    // Join it: a second OS watcher would overwrite the entry below and leak,
    // never closed and firing duplicate events for the life of the window.
    const joined = gitWatchers.get(key);
    if (joined) {
      joined.refs++;
      return { ok: true };
    }
    let watcher: FSWatcher;
    try {
      watcher = runtimeFor(root).watch(gitDir, { recursive: true, kind: 'gitdir' });
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Could not watch the repository',
      };
    }
    const entry: GitWatch = {
      watcher,
      sender,
      wcId: sender.id,
      root,
      refs: 1,
      timer: null,
      pendingKind: null,
    };
    gitWatchers.set(key, entry);
    watcher.on('error', () => {
      closeGitWatch(entry);
      gitWatchers.delete(key);
    });
    watcher.on('change', (_eventType, filename) => {
      const rel = filename == null ? '' : filename.toString();
      if (rel && isNoiseGitPath(rel)) return;
      // No filename (platform quirk) - assume the wider scope.
      const kind = rel ? classifyGitPath(rel) : 'history';
      if (entry.pendingKind !== 'history') entry.pendingKind = kind;
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const pending = entry.pendingKind ?? 'history';
        entry.pendingKind = null;
        if (!entry.sender.isDestroyed()) {
          entry.sender.send('git:changed', { root: entry.root, kind: pending });
        }
      }, 300);
    });
    // A remote git-dir watch the host refused (or a host that went away while
    // arming) is an error, never a quiet ok that never fires.
    const ready = (watcher as unknown as Partial<HostWatcher>).ready;
    if (ready) {
      try {
        await ready;
      } catch (err) {
        closeGitWatch(entry);
        if (gitWatchers.get(key) === entry) gitWatchers.delete(key);
        const code = (err as { code?: unknown }).code;
        return {
          error: err instanceof Error ? err.message : 'Could not watch the repository',
          ...(typeof code === 'string' ? { code } : {}),
        };
      }
    }
    return { ok: true };
  });

  ipcMain.handle('git:unwatch', (event, payload: { root?: unknown }) => {
    if (!isTrustedSender(event)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.root)) return { ok: true };
    const key = watchKey(event.sender.id, payload.root);
    const entry = gitWatchers.get(key);
    if (!entry) return { ok: true };
    entry.refs--;
    if (entry.refs <= 0) {
      closeGitWatch(entry);
      gitWatchers.delete(key);
    }
    return { ok: true };
  });
  return () => {
    for (const entry of gitWatchers.values()) closeGitWatch(entry);
    gitWatchers.clear();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
