import type {
  GitBranch,
  GitChangeKind,
  GitCommit,
  GitCommitFile,
  GitNumstatEntry,
  GitRefs,
  GitStatus,
  GitRemoteTag,
} from './git-types';

/**
 * Pure parsers for git CLI output - no Electron, no child_process, no fs.
 *
 * These live apart from git.ts so they can be exercised against captured
 * fixtures. Everything here is a total function: git output in, payload out,
 * never throwing on malformed input (a corrupt line is skipped, not fatal -
 * a git surface degrades rather than blanking).
 */

/** Field separator inside one record (`%x1f`). Shared with the `--format` /
 * `--pretty` strings in git.ts so the two can't drift. */
export const REF_SEP = '\u001f';

/** Record separator between commits (`%x1e`). */
export const REC_SEP = '\u001e';

export type ParsedStatus = Omit<GitStatus, 'repo' | 'userName' | 'userEmail' | 'mergeMsg'>;

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(out: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      if (head === '(detached)') result.detached = true;
      else result.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const xy = line.slice(2, 4);
      const path = line.split(' ').slice(8).join(' ');
      result.files.push({
        path,
        index: xy[0] === '.' ? ' ' : xy[0],
        worktree: xy[1] === '.' ? ' ' : xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const xy = line.slice(2, 4);
      const path = line.split(' ').slice(9).join(' ');
      const origPath = tokens[++i] ?? undefined;
      result.files.push({
        path,
        origPath,
        index: xy[0] === '.' ? ' ' : xy[0],
        worktree: xy[1] === '.' ? ' ' : xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const path = line.split(' ').slice(10).join(' ');
      result.files.push({ path, index: 'U', worktree: 'U', untracked: false, conflicted: true });
    } else if (line.startsWith('? ')) {
      result.files.push({
        path: line.slice(2),
        index: ' ',
        worktree: '?',
        untracked: true,
        conflicted: false,
      });
    }
  }
  return result;
}

/** Parse `%(upstream:track)`: "[ahead 2, behind 3]" / "[gone]" / "". */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.includes('gone'),
  };
}

/** Parse `for-each-ref refs/heads --format=%(refname:short)|%(HEAD)|%(upstream:short)`.
 * ahead/behind/gone stay zeroed - git:refsTrack fills them in later. */
export function parseBranches(out: string): GitBranch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split(REF_SEP);
      return {
        name,
        current: head === '*',
        upstream: upstream || null,
        ahead: 0,
        behind: 0,
        gone: false,
      };
    });
}

/** Group `for-each-ref refs/remotes` output under each configured remote,
 * dropping the `<remote>/HEAD` symbolic pointer. */
export function parseRemotes(remoteList: string, remoteRefs: string): GitRefs['remotes'] {
  const refs = remoteRefs.split('\n').filter(Boolean);
  return remoteList
    .split('\n')
    .filter(Boolean)
    .map((name) => ({
      name,
      branches: refs
        .filter((r) => r.startsWith(`${name}/`) && r !== `${name}/HEAD`)
        .map((r) => r.slice(name.length + 1)),
    }));
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(out: string): GitRefs['worktrees'] {
  const worktrees: GitRefs['worktrees'] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push({ ...current, name: current.path.split('/').pop() ?? '' });
      current = { path: line.slice(9), branch: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && current) {
      current.branch = null;
    }
  }
  if (current) worktrees.push({ ...current, name: current.path.split('/').pop() ?? '' });
  return worktrees;
}

/** Parse `git stash list --format=%gd|%H|%P|%an|%ae|%at|%gs` - the index
 * comes out of `stash@{N}`; sha/parents let the graph hang a node off the
 * stash's first parent (and read untracked files from the third). */
export function parseStashes(out: string): GitRefs['stashes'] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, parents, author, email, time, message] = line.split(REF_SEP);
      const m = /\{(\d+)\}/.exec(ref ?? '');
      return {
        index: m ? Number(m[1]) : 0,
        sha: sha ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        author: author ?? '',
        email: email ?? '',
        time: Number(time ?? 0),
        message: message ?? '',
      };
    });
}

/** Classify the `%D` decoration list of one commit. */
export function parseDecorations(decorations: string, remoteNames: Set<string>): GitCommit['refs'] {
  if (!decorations) return [];
  const refs: GitCommit['refs'] = [];
  for (const raw of decorations.split(', ')) {
    const item = raw.trim();
    if (!item || item === 'HEAD') continue; // detached marker - not a pill
    // Belt and braces: the log scope excludes refs/stash, but a scoped log
    // (`git:log` with a ref) could still surface it - never render it as a
    // branch pill; the graph draws stashes as their own nodes.
    if (item === 'refs/stash') continue;
    if (item.startsWith('tag: ')) {
      refs.push({ name: item.slice(5), type: 'tag', head: false });
      continue;
    }
    const head = item.startsWith('HEAD -> ');
    const name = head ? item.slice(8) : item;
    const slash = name.indexOf('/');
    const isRemote = slash > 0 && remoteNames.has(name.slice(0, slash));
    refs.push({ name, type: isRemote ? 'remote' : 'branch', head });
  }
  return refs;
}

/** Parse `git log --pretty=format:%H|%P|%an|%ae|%at|%D|%s<REC>` output. */
export function parseCommits(out: string, remoteNames: Set<string>): GitCommit[] {
  return out
    .split(REC_SEP)
    .map((rec) => rec.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, email, time, decorations, subject] = rec.split(REF_SEP);
      return {
        sha,
        parents: (parents ?? '').split(' ').filter(Boolean),
        author: author ?? '',
        email: email ?? '',
        time: Number(time ?? 0),
        refs: parseDecorations(decorations ?? '', remoteNames),
        subject: subject ?? '',
      };
    });
}

/** Parse `git diff --numstat -z`. Entries are `add\tdel\tpath NUL`, except
 * renames, which emit an empty path then `old NUL new NUL`. A `-` count means
 * the file is binary. */
export function parseNumstat(out: string): GitNumstatEntry[] {
  const entries: GitNumstatEntry[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    if (!path) continue;
    entries.push({
      path,
      add: m[1] === '-' ? null : Number(m[1]),
      del: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return entries;
}

/**
 * `git ls-files --others --exclude-standard -z`: the untracked files. A nested
 * repository - another checkout, or a session worktree under `.worktree/` in a
 * repo that doesn't ignore the folder - is listed as one `dir/` entry and never
 * walked. Its work is its own, so it is dropped.
 */
export function parseUntrackedFiles(out: string): string[] {
  return out.split('\0').filter((path) => path.length > 0 && !path.endsWith('/'));
}

/**
 * The lines a new file adds, counted the way `git diff --numstat` counts them
 * once the file is tracked: one per newline plus an unterminated last line, so
 * an empty file adds 0. Null for a binary file - a NUL byte in the first 8000
 * bytes, git's own test.
 */
export function countNewFileLines(bytes: Uint8Array): number | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  let lines = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) lines++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines++;
  return lines;
}

/** Pull the insertion/deletion totals out of `git diff --shortstat`. */
export function parseShortstat(out: string): { add: number; del: number } {
  return {
    add: Number(/(\d+) insertion/.exec(out)?.[1] ?? 0),
    del: Number(/(\d+) deletion/.exec(out)?.[1] ?? 0),
  };
}

/** Parse `--name-status -z -M` output (diff or diff-tree). Renames and copies
 * carry two path tokens; a type change (T) renders as a modification. */
export function parseCommitFiles(out: string): GitCommitFile[] {
  const tokens = out.split('\0');
  const files: GitCommitFile[] = [];
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++];
    if (!status) continue;
    const letter = status[0] === 'T' ? 'M' : status[0];
    if (letter === 'R' || letter === 'C') {
      const origPath = tokens[i++];
      const path = tokens[i++];
      if (path) files.push({ path, origPath, letter });
    } else {
      const path = tokens[i++];
      if (path) files.push({ path, letter });
    }
  }
  return files;
}

/** The index only moves the working-tree status; anything else that survives
 * the noise filter (HEAD, refs/**, packed-refs, MERGE_HEAD, FETCH_HEAD…) can
 * move refs or history. */
export function classifyGitPath(rel: string): GitChangeKind {
  return rel === 'index' ? 'status' : 'history';
}

/** Skip object-store writes, reflog appends and transient lock files. */
export function isNoiseGitPath(rel: string): boolean {
  return rel.startsWith('objects') || rel.startsWith('logs') || rel.endsWith('.lock');
}

/**
 * `git ls-files --others --ignored --exclude-standard --directory -z` from the
 * repo root: NUL-separated paths, folders with a trailing slash. A folder an
 * ignore rule matches outright comes as one entry (`node_modules/`, git never
 * looks inside); a folder that merely holds nothing but ignored files comes
 * as an entry AND its contents (`packages/`, `packages/api/`,
 * `packages/api/.env.local`). The second kind is noise for a pick list - the
 * specific files are what the user recognises - so a folder git enumerated
 * inside is dropped in favour of what it listed beneath it.
 */
export function parseIgnoredEntries(out: string): { path: string; kind: 'file' | 'dir' }[] {
  const paths = out.split('\0').filter((path) => path.length > 0);
  return paths
    .filter(
      (path) =>
        !path.endsWith('/') || !paths.some((other) => other !== path && other.startsWith(path)),
    )
    .map((path) => ({ path, kind: path.endsWith('/') ? 'dir' : 'file' }));
}

/**
 * `git ls-remote --tags <remote>`: `<sha>\t<refs/tags/name>` lines, and after
 * every annotated tag a `refs/tags/name^{}` line carrying the commit it points
 * at. The peeled sha wins, so `sha` is always the commit - comparable with the
 * graph's rows. Anything that is not under refs/tags is ignored.
 */
export function parseRemoteTags(out: string): GitRemoteTag[] {
  const byName = new Map<string, string>();
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const sha = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith('refs/tags/') || !sha) continue;
    const peeled = ref.endsWith('^{}');
    const name = ref.slice('refs/tags/'.length, peeled ? -3 : undefined);
    if (!name) continue;
    if (peeled || !byName.has(name)) byName.set(name, sha);
  }
  return [...byName].map(([name, sha]) => ({ name, sha }));
}

/** The remote-tracking refs `git remote prune <remote>` removed, from its
 * ` * [pruned] origin/feature/x` lines (the `Pruning` / `URL:` header is
 * dropped). */
export function parsePrunedRefs(out: string): string[] {
  const pruned: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*\*\s+\[pruned\]\s+(\S.*)$/.exec(line);
    if (m) pruned.push(m[1].trim());
  }
  return pruned;
}

/**
 * The line of a failed git run's output worth showing. A push prints
 * `To <remote url>` first, so the first line alone named the remote and hid
 * the reason (`! [rejected] … (non-fast-forward)`, a hook's `remote:` text)
 * behind it; `hint:` lines are advice, never the error.
 */
export function gitErrorLine(out: string): string | undefined {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^To \S+$/.test(l) && !/^hint:/.test(l) && l !== 'remote:');
  const line = lines[0];
  // ` ! [rejected]            HEAD -> x (non-fast-forward)` - git pads the
  // columns for a table the dock shows as one line.
  return line?.replace(/\s{2,}/g, ' ');
}

/**
 * Whether a remote operation failed because the credentials were refused -
 * a push, pull or fetch run on a remote host with the server's own keys and
 * helpers (a private plan › 10.1).
 */
export function isGitAuthFailure(stderr: string): boolean {
  if (gitHostKeyFailure(stderr)) return false;
  return /Permission denied \(publickey|Authentication failed|could not read Username|could not read Password|terminal prompts disabled|invalid username or password|HTTP Basic: Access denied|403 Forbidden/i.test(
    stderr,
  );
}

/** What a git action says when a host's credentials were refused. */
export function hostAuthMessage(hostLabel: string): string {
  return `${hostLabel}'s credentials were refused. Push from a terminal on ${hostLabel}, or turn on Forward SSH agent in Settings › Hosts.`;
}

/**
 * The host has never accepted the git remote's ssh host key (no credential
 * was even tried): the server named, when ssh said which. Null otherwise.
 */
export function gitHostKeyFailure(stderr: string): { server: string | null } | null {
  if (!/Host key verification failed/i.test(stderr)) return null;
  const named =
    /host key is known for (\S+?)(?:\s|$)/i.exec(stderr) ??
    /authenticity of host '([^' ]+)/i.exec(stderr) ??
    /Offending \S+ key for (\S+)/i.exec(stderr);
  return { server: named ? named[1].replace(/[.,]$/, '') : null };
}

/** What a git action says when the host does not know the remote's host key. */
export function hostKeyMessage(hostLabel: string, server: string | null): string {
  const who = server ? `${server}'s` : "the remote's";
  return `${hostLabel} has not accepted ${who} host key - ssh to it once from a terminal there.`;
}
