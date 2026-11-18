import { describe, expect, it } from 'vitest';
import {
  REC_SEP,
  REF_SEP,
  classifyGitPath,
  countNewFileLines,
  gitErrorLine,
  isNoiseGitPath,
  parseBranches,
  parseCommitFiles,
  parseCommits,
  parseDecorations,
  parseIgnoredEntries,
  parseNumstat,
  parseRemotes,
  parseShortstat,
  parseStashes,
  parseStatus,
  parseTrack,
  parseUntrackedFiles,
  parseWorktrees,
  parseRemoteTags,
  parsePrunedRefs,
} from './git-parse';

/** Join `-z` records the way git emits them: every record NUL-terminated. */
const z = (...records: string[]): string => records.join('\0') + '\0';

/** One porcelain-v2 ordinary (`1`) entry - the fields the parser skips are
 * filled with plausible-but-irrelevant values, as git would. */
const ordinary = (xy: string, path: string): string =>
  `1 ${xy} N... 100644 100644 100644 9cff349d687a5e369690e6848dbdc26bc4720dee 9cff349d687a5e369690e6848dbdc26bc4720dee ${path}`;

/** One porcelain-v2 rename/copy (`2`) entry. The original path is NOT part of
 * this record - it is the next NUL-separated token (see parseStatus). */
const renamed = (xy: string, path: string): string =>
  `2 ${xy} N... 100644 100644 100644 9cff349d687a5e369690e6848dbdc26bc4720dee 9cff349d687a5e369690e6848dbdc26bc4720dee R100 ${path}`;

/** One porcelain-v2 unmerged (`u`) entry. */
const unmerged = (xy: string, path: string): string =>
  `u ${xy} N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 ${path}`;

describe('record separators', () => {
  // The parsers and git.ts's --format strings have to agree on the exact
  // bytes: %x1f between fields, %x1e between commit records.
  it('are the ASCII unit and record separators git emits', () => {
    expect(REF_SEP.charCodeAt(0)).toBe(0x1f);
    expect(REF_SEP).toHaveLength(1);
    expect(REC_SEP.charCodeAt(0)).toBe(0x1e);
    expect(REC_SEP).toHaveLength(1);
  });
});

describe('parseStatus', () => {
  it('reads the branch header block', () => {
    const out = z(
      '# branch.oid ce6e183bdebad76a6e71b95f7f1a0a6b90a92d91',
      '# branch.head tasks',
      '# branch.upstream origin/tasks',
      '# branch.ab +3 -7',
    );
    expect(parseStatus(out)).toMatchObject({
      branch: 'tasks',
      detached: false,
      upstream: 'origin/tasks',
      ahead: 3,
      behind: 7,
      files: [],
    });
  });

  it('flags a detached HEAD and leaves the branch null', () => {
    const status = parseStatus(z('# branch.head (detached)'));
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
  });

  it('leaves ahead/behind at zero with no upstream', () => {
    const status = parseStatus(z('# branch.head main'));
    expect(status).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
  });

  it('maps the XY letters, turning "." into a space', () => {
    const status = parseStatus(
      z(ordinary('.M', 'src/main/git.ts'), ordinary('M.', 'package.json'), ordinary('MM', 'a.ts')),
    );
    expect(status.files).toEqual([
      { path: 'src/main/git.ts', index: ' ', worktree: 'M', untracked: false, conflicted: false },
      { path: 'package.json', index: 'M', worktree: ' ', untracked: false, conflicted: false },
      { path: 'a.ts', index: 'M', worktree: 'M', untracked: false, conflicted: false },
    ]);
  });

  it('keeps spaces in paths', () => {
    const status = parseStatus(z(ordinary('.M', 'docs/design notes/final draft.md')));
    expect(status.files[0].path).toBe('docs/design notes/final draft.md');
  });

  it('takes a rename’s original path from the following NUL token', () => {
    const status = parseStatus(z(renamed('R.', 'src/main/git-parse.ts'), 'src/main/parsers.ts'));
    expect(status.files).toEqual([
      {
        path: 'src/main/git-parse.ts',
        origPath: 'src/main/parsers.ts',
        index: 'R',
        worktree: ' ',
        untracked: false,
        conflicted: false,
      },
    ]);
  });

  it('does not let a rename swallow the entry that follows it', () => {
    // The origPath token consumes an extra index - a bug here silently drops
    // every file listed after the first rename.
    const status = parseStatus(
      z(
        renamed('R.', 'new-a.ts'),
        'old-a.ts',
        ordinary('.M', 'untouched.ts'),
        renamed('R.', 'new-b.ts'),
        'old-b.ts',
        ordinary('.M', 'last.ts'),
      ),
    );
    expect(status.files.map((f) => f.path)).toEqual([
      'new-a.ts',
      'untouched.ts',
      'new-b.ts',
      'last.ts',
    ]);
    expect(status.files.map((f) => f.origPath)).toEqual([
      'old-a.ts',
      undefined,
      'old-b.ts',
      undefined,
    ]);
  });

  it('marks unmerged entries conflicted on both sides', () => {
    const status = parseStatus(z(unmerged('UU', 'src/conflicted.ts')));
    expect(status.files).toEqual([
      { path: 'src/conflicted.ts', index: 'U', worktree: 'U', untracked: false, conflicted: true },
    ]);
  });

  it('marks untracked entries', () => {
    const status = parseStatus(z('? src/renderer/src/lib/new-file.ts'));
    expect(status.files).toEqual([
      {
        path: 'src/renderer/src/lib/new-file.ts',
        index: ' ',
        worktree: '?',
        untracked: true,
        conflicted: false,
      },
    ]);
  });

  it('parses a mixed working tree in one pass', () => {
    const status = parseStatus(
      z(
        '# branch.head tasks',
        '# branch.upstream origin/tasks',
        '# branch.ab +1 -0',
        ordinary('.M', 'package.json'),
        renamed('R.', 'b.ts'),
        'a.ts',
        unmerged('UU', 'merge-me.ts'),
        '? untracked.ts',
      ),
    );
    expect(status.branch).toBe('tasks');
    expect(status.ahead).toBe(1);
    expect(status.files).toHaveLength(4);
    expect(status.files.filter((f) => f.conflicted)).toHaveLength(1);
    expect(status.files.filter((f) => f.untracked)).toHaveLength(1);
  });

  it('returns the empty state for empty output (clean repo)', () => {
    expect(parseStatus('')).toEqual({
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    });
  });

  it('skips lines it does not recognise instead of throwing', () => {
    const status = parseStatus(z('# stash 2', 'garbage', ordinary('.M', 'real.ts')));
    expect(status.files.map((f) => f.path)).toEqual(['real.ts']);
  });
});

describe('parseTrack', () => {
  it('reads both counts', () => {
    expect(parseTrack('[ahead 2, behind 3]')).toEqual({ ahead: 2, behind: 3, gone: false });
  });

  it('reads a one-sided track', () => {
    expect(parseTrack('[ahead 12]')).toEqual({ ahead: 12, behind: 0, gone: false });
    expect(parseTrack('[behind 4]')).toEqual({ ahead: 0, behind: 4, gone: false });
  });

  it('flags a gone upstream', () => {
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
  });

  it('treats an empty track as in sync', () => {
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  });
});

describe('parseBranches', () => {
  const line = (name: string, head: string, upstream: string): string =>
    [name, head, upstream].join(REF_SEP);

  it('marks the checked-out branch and keeps its upstream', () => {
    const branches = parseBranches(
      [line('dev', ' ', 'origin/dev'), line('tasks', '*', 'origin/tasks')].join('\n'),
    );
    expect(branches).toEqual([
      { name: 'dev', current: false, upstream: 'origin/dev', ahead: 0, behind: 0, gone: false },
      { name: 'tasks', current: true, upstream: 'origin/tasks', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('nulls an empty upstream', () => {
    expect(parseBranches(line('local-only', ' ', ''))[0].upstream).toBeNull();
  });

  it('returns nothing for empty output', () => {
    expect(parseBranches('')).toEqual([]);
  });
});

describe('parseRemotes', () => {
  it('groups remote-tracking refs under their remote', () => {
    const remotes = parseRemotes(
      'origin\nupstream',
      ['origin/HEAD', 'origin/main', 'origin/dev', 'upstream/main'].join('\n'),
    );
    expect(remotes).toEqual([
      { name: 'origin', branches: ['main', 'dev'] },
      { name: 'upstream', branches: ['main'] },
    ]);
  });

  it('keeps slashes in nested branch names', () => {
    const remotes = parseRemotes('origin', 'origin/release/1.4');
    expect(remotes[0].branches).toEqual(['release/1.4']);
  });

  it('returns nothing when no remote is configured', () => {
    expect(parseRemotes('', 'origin/main')).toEqual([]);
  });
});

describe('parseWorktrees', () => {
  it('reads path + branch, naming each by its directory', () => {
    const out = [
      'worktree /Users/emmaw/Code/double0/client-desktop',
      'HEAD ce6e183bdebad76a6e71b95f7f1a0a6b90a92d91',
      'branch refs/heads/tasks',
      '',
      'worktree /Users/emmaw/Code/double0/.worktree/checkout-flow',
      'HEAD 746496c0000000000000000000000000000000aa',
      'branch refs/heads/checkout-flow',
      '',
    ].join('\n');
    expect(parseWorktrees(out)).toEqual([
      {
        path: '/Users/emmaw/Code/double0/client-desktop',
        name: 'client-desktop',
        branch: 'tasks',
      },
      {
        path: '/Users/emmaw/Code/double0/.worktree/checkout-flow',
        name: 'checkout-flow',
        branch: 'checkout-flow',
      },
    ]);
  });

  it('leaves a detached worktree without a branch', () => {
    const out = ['worktree /tmp/wt', 'HEAD abc1234', 'detached', ''].join('\n');
    expect(parseWorktrees(out)).toEqual([{ path: '/tmp/wt', name: 'wt', branch: null }]);
  });

  it('emits the final worktree even without a trailing blank line', () => {
    const out = ['worktree /tmp/wt', 'HEAD abc1234', 'branch refs/heads/main'].join('\n');
    expect(parseWorktrees(out)).toHaveLength(1);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktrees('')).toEqual([]);
  });
});

describe('parseStashes', () => {
  const line = (
    ref: string,
    sha: string,
    parents: string,
    author: string,
    email: string,
    time: string,
    message: string,
  ): string => [ref, sha, parents, author, email, time, message].join(REF_SEP);

  it('parses index, sha, parents, author and time', () => {
    const out = [
      line(
        'stash@{0}',
        'aaa111',
        'p1 p2 p3',
        'Emma Wilson',
        'emmaw@example.com',
        '1757400000',
        'WIP on tasks: ce6e183 Improvements on tasks',
      ),
      line(
        'stash@{1}',
        'bbb222',
        'p4 p5',
        'James Carter',
        'jamesc@example.com',
        '1757300000',
        'On dev: quick fix',
      ),
    ].join('\n');
    expect(parseStashes(out)).toEqual([
      {
        index: 0,
        sha: 'aaa111',
        parents: ['p1', 'p2', 'p3'],
        author: 'Emma Wilson',
        email: 'emmaw@example.com',
        time: 1757400000,
        message: 'WIP on tasks: ce6e183 Improvements on tasks',
      },
      {
        index: 1,
        sha: 'bbb222',
        parents: ['p4', 'p5'],
        author: 'James Carter',
        email: 'jamesc@example.com',
        time: 1757300000,
        message: 'On dev: quick fix',
      },
    ]);
  });

  it('falls back to index 0 on an unparseable ref', () => {
    const parsed = parseStashes(
      line('weird', 'ccc333', 'p1 p2', 'A', 'a@example.com', '1', 'a message'),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ index: 0, sha: 'ccc333', message: 'a message' });
  });

  it('returns nothing when the stash is empty', () => {
    expect(parseStashes('')).toEqual([]);
  });
});

describe('parseDecorations', () => {
  const remotes = new Set(['origin', 'upstream']);

  it('classifies the checked-out branch as head', () => {
    expect(parseDecorations('HEAD -> tasks, origin/tasks', remotes)).toEqual([
      { name: 'tasks', type: 'branch', head: true },
      { name: 'origin/tasks', type: 'remote', head: false },
    ]);
  });

  it('drops a bare HEAD (detached marker, not a pill)', () => {
    expect(parseDecorations('HEAD, origin/main', remotes)).toEqual([
      { name: 'origin/main', type: 'remote', head: false },
    ]);
  });

  it('reads tags', () => {
    expect(parseDecorations('tag: v1.4.0', remotes)).toEqual([
      { name: 'v1.4.0', type: 'tag', head: false },
    ]);
  });

  it('only treats a slashed name as remote when the prefix is a real remote', () => {
    // A local branch called feature/git-graph must not be mistaken for the
    // "feature" remote's git-graph branch.
    expect(parseDecorations('feature/git-graph, upstream/main', remotes)).toEqual([
      { name: 'feature/git-graph', type: 'branch', head: false },
      { name: 'upstream/main', type: 'remote', head: false },
    ]);
  });

  it('never renders refs/stash as a branch pill', () => {
    // The log scope excludes refs/stash, but a scoped log could still surface
    // it - the graph draws stashes as their own nodes instead.
    expect(parseDecorations('refs/stash, main', remotes)).toEqual([
      { name: 'main', type: 'branch', head: false },
    ]);
  });

  it('returns nothing for an undecorated commit', () => {
    expect(parseDecorations('', remotes)).toEqual([]);
  });
});

describe('parseCommits', () => {
  const remotes = new Set(['origin']);
  const record = (fields: string[]): string => fields.join(REF_SEP) + REC_SEP;

  it('parses a run of records', () => {
    const out =
      record([
        'ce6e183bdebad76a6e71b95f7f1a0a6b90a92d91',
        'b8235f8000000000000000000000000000000001',
        'Emma Wilson',
        'emmaw@example.com',
        '1754487000',
        'HEAD -> tasks, origin/tasks',
        'Improvements on tasks and sessions',
      ]) +
      record([
        'b8235f8000000000000000000000000000000001',
        '7c1147c000000000000000000000000000000002 746496c000000000000000000000000000000003',
        'James Carter',
        'jcarter@example.com',
        '1754400000',
        '',
        'Add tasks, improvements',
      ]);
    const commits = parseCommits(out, remotes);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'ce6e183bdebad76a6e71b95f7f1a0a6b90a92d91',
      parents: ['b8235f8000000000000000000000000000000001'],
      author: 'Emma Wilson',
      email: 'emmaw@example.com',
      time: 1754487000,
      refs: [
        { name: 'tasks', type: 'branch', head: true },
        { name: 'origin/tasks', type: 'remote', head: false },
      ],
      subject: 'Improvements on tasks and sessions',
    });
    // A merge commit carries both parents.
    expect(commits[1].parents).toHaveLength(2);
    expect(commits[1].refs).toEqual([]);
  });

  it('strips the newline git puts between records', () => {
    // `--pretty=format:...%x1e` separates records with %x1e but git still emits
    // a newline before the next one; it must not leak into the sha.
    const out =
      record(['aaa1111', '', 'Emma Wilson', 'emmaw@example.com', '1754487000', '', 'first']) +
      '\n' +
      record([
        'bbb2222',
        'aaa1111',
        'Emma Wilson',
        'emmaw@example.com',
        '1754400000',
        '',
        'second',
      ]);
    const commits = parseCommits(out, remotes);
    expect(commits.map((c) => c.sha)).toEqual(['aaa1111', 'bbb2222']);
  });

  it('handles a root commit with no parents', () => {
    const out = record(['aaa1111', '', 'Emma Wilson', 'emmaw@example.com', '1', '', 'init']);
    expect(parseCommits(out, remotes)[0].parents).toEqual([]);
  });

  it('keeps a subject containing commas and arrows', () => {
    const out = record(['aaa1111', '', 'Emma Wilson', 'e@example.com', '1', '', 'Fix a, b -> c']);
    expect(parseCommits(out, remotes)[0].subject).toBe('Fix a, b -> c');
  });

  it('returns nothing for an empty log', () => {
    expect(parseCommits('', remotes)).toEqual([]);
  });
});

describe('parseNumstat', () => {
  it('reads add/del counts per file', () => {
    const out = z('3\t0\t.gitignore', '55\t334\tsrc/main/git.ts');
    expect(parseNumstat(out)).toEqual([
      { path: '.gitignore', add: 3, del: 0 },
      { path: 'src/main/git.ts', add: 55, del: 334 },
    ]);
  });

  it('reports binary files as null counts', () => {
    expect(parseNumstat(z('-\t-\tdesign/images/logo.png'))).toEqual([
      { path: 'design/images/logo.png', add: null, del: null },
    ]);
  });

  it('reads a rename, whose paths arrive as two extra NUL tokens', () => {
    // -M renames emit `add\tdel\t` with an EMPTY path, then old NUL new NUL.
    const out = z('12\t4\t', 'src/main/parsers.ts', 'src/main/git-parse.ts');
    expect(parseNumstat(out)).toEqual([{ path: 'src/main/git-parse.ts', add: 12, del: 4 }]);
  });

  it('keeps reading entries after a rename', () => {
    const out = z('12\t4\t', 'old.ts', 'new.ts', '1\t1\tafter.ts');
    expect(parseNumstat(out).map((e) => e.path)).toEqual(['new.ts', 'after.ts']);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('parseUntrackedFiles', () => {
  it('lists every untracked file', () => {
    expect(parseUntrackedFiles(z('.claude/plans/120-geofence.md', 'notes.txt'))).toEqual([
      '.claude/plans/120-geofence.md',
      'notes.txt',
    ]);
  });

  it('drops a nested repository, which git lists as one folder entry', () => {
    // A session worktree under an unignored .worktree/ - its files are that
    // session's work and must not inflate the checkout's counts.
    expect(parseUntrackedFiles(z('.worktree/fix-login/', 'vendor/sdk/', 'new.ts'))).toEqual([
      'new.ts',
    ]);
  });

  it('returns nothing for an empty listing', () => {
    expect(parseUntrackedFiles('')).toEqual([]);
  });
});

describe('countNewFileLines', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  // Each expectation is what `git diff --numstat` reports for the same file
  // once it is added with intent-to-add.
  it('counts one line per newline', () => {
    expect(countNewFileLines(bytes('one\ntwo\nthree\n'))).toBe(3);
  });

  it('counts an unterminated last line', () => {
    expect(countNewFileLines(bytes('x\ny'))).toBe(2);
  });

  it('counts blank lines', () => {
    expect(countNewFileLines(bytes('\n\n'))).toBe(2);
  });

  it('counts nothing for an empty file', () => {
    expect(countNewFileLines(bytes(''))).toBe(0);
  });

  it('reports a file with a NUL byte up front as binary', () => {
    expect(countNewFileLines(Uint8Array.from([0x89, 0x50, 0x00, 0x0a]))).toBeNull();
  });

  it('looks for the NUL only in the first 8000 bytes, as git does', () => {
    const late = new Uint8Array(8002).fill(0x61);
    late[8000] = 0;
    late[8001] = 0x0a;
    expect(countNewFileLines(late)).toBe(1);
    late[7999] = 0;
    expect(countNewFileLines(late)).toBeNull();
  });
});

describe('parseShortstat', () => {
  it('reads both totals', () => {
    expect(parseShortstat(' 27 files changed, 1057 insertions(+), 477 deletions(-)')).toEqual({
      add: 1057,
      del: 477,
    });
  });

  it('reads an insert-only change', () => {
    expect(parseShortstat(' 1 file changed, 3 insertions(+)')).toEqual({ add: 3, del: 0 });
  });

  it('reads a delete-only change', () => {
    expect(parseShortstat(' 1 file changed, 8 deletions(-)')).toEqual({ add: 0, del: 8 });
  });

  it('reads a singular insertion', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+), 1 deletion(-)')).toEqual({
      add: 1,
      del: 1,
    });
  });

  it('is zero for an empty diff', () => {
    expect(parseShortstat('')).toEqual({ add: 0, del: 0 });
  });
});

describe('parseCommitFiles', () => {
  it('reads plain status letters', () => {
    const out = z('M', 'package.json', 'A', 'src/main/git-parse.ts', 'D', 'src/main/old.ts');
    expect(parseCommitFiles(out)).toEqual([
      { path: 'package.json', letter: 'M' },
      { path: 'src/main/git-parse.ts', letter: 'A' },
      { path: 'src/main/old.ts', letter: 'D' },
    ]);
  });

  it('reads a rename as two path tokens', () => {
    const out = z('R100', 'src/main/parsers.ts', 'src/main/git-parse.ts');
    expect(parseCommitFiles(out)).toEqual([
      {
        path: 'src/main/git-parse.ts',
        origPath: 'src/main/parsers.ts',
        letter: 'R',
      },
    ]);
  });

  it('reads a copy the same way', () => {
    const out = z('C75', 'src/main/git.ts', 'src/main/git-copy.ts');
    expect(parseCommitFiles(out)).toEqual([
      { path: 'src/main/git-copy.ts', origPath: 'src/main/git.ts', letter: 'C' },
    ]);
  });

  it('renders a type change as a modification', () => {
    expect(parseCommitFiles(z('T', 'scripts/link'))).toEqual([
      { path: 'scripts/link', letter: 'M' },
    ]);
  });

  it('keeps reading files after a rename', () => {
    const out = z('R100', 'old.ts', 'new.ts', 'M', 'after.ts');
    expect(parseCommitFiles(out).map((f) => f.path)).toEqual(['new.ts', 'after.ts']);
  });

  it('returns nothing for an empty commit', () => {
    expect(parseCommitFiles('')).toEqual([]);
  });
});

describe('classifyGitPath', () => {
  it('scopes an index write to a status refresh', () => {
    expect(classifyGitPath('index')).toBe('status');
  });

  it('treats ref and HEAD movement as history', () => {
    expect(classifyGitPath('HEAD')).toBe('history');
    expect(classifyGitPath('refs/heads/tasks')).toBe('history');
    expect(classifyGitPath('packed-refs')).toBe('history');
    expect(classifyGitPath('MERGE_HEAD')).toBe('history');
    expect(classifyGitPath('FETCH_HEAD')).toBe('history');
  });
});

describe('isNoiseGitPath', () => {
  it('filters object-store writes, reflogs and lock files', () => {
    expect(isNoiseGitPath('objects/ce/6e183bde')).toBe(true);
    expect(isNoiseGitPath('logs/HEAD')).toBe(true);
    expect(isNoiseGitPath('index.lock')).toBe(true);
    expect(isNoiseGitPath('refs/heads/tasks.lock')).toBe(true);
  });

  it('lets the paths the watcher cares about through', () => {
    expect(isNoiseGitPath('index')).toBe(false);
    expect(isNoiseGitPath('HEAD')).toBe(false);
    expect(isNoiseGitPath('refs/heads/tasks')).toBe(false);
    expect(isNoiseGitPath('packed-refs')).toBe(false);
  });
});

describe('parseIgnoredEntries', () => {
  it('splits the NUL-separated list and tells folders by their trailing slash', () => {
    expect(parseIgnoredEntries('.env\0node_modules/\0packages/api/.env.local\0')).toEqual([
      { path: '.env', kind: 'file' },
      { path: 'node_modules/', kind: 'dir' },
      { path: 'packages/api/.env.local', kind: 'file' },
    ]);
  });

  it('keeps a wholly-ignored folder but drops one git enumerated inside', () => {
    // `packages/` only holds ignored files, so git reports the folder AND its
    // contents; `node_modules/` matched a rule outright and stays a single entry.
    expect(
      parseIgnoredEntries('node_modules/\0packages/\0packages/api/\0packages/api/.env.local\0'),
    ).toEqual([
      { path: 'node_modules/', kind: 'dir' },
      { path: 'packages/api/.env.local', kind: 'file' },
    ]);
  });

  it('yields nothing for an empty listing', () => {
    expect(parseIgnoredEntries('')).toEqual([]);
    expect(parseIgnoredEntries('\0')).toEqual([]);
  });
});

describe('parseRemoteTags', () => {
  it('folds an annotated tag’s peeled line into the tag, so sha is always the commit', () => {
    const out = [
      'aaaa0000000000000000000000000000000000aa\trefs/tags/v1.0.0',
      'bbbb0000000000000000000000000000000000bb\trefs/tags/v1.1.0',
      'cccc0000000000000000000000000000000000cc\trefs/tags/v1.1.0^{}',
      'dddd0000000000000000000000000000000000dd\trefs/heads/main',
      '',
    ].join('\n');
    expect(parseRemoteTags(out)).toEqual([
      { name: 'v1.0.0', sha: 'aaaa0000000000000000000000000000000000aa' },
      { name: 'v1.1.0', sha: 'cccc0000000000000000000000000000000000cc' },
    ]);
  });

  it('is empty for an empty listing', () => {
    expect(parseRemoteTags('')).toEqual([]);
  });
});

describe('parsePrunedRefs', () => {
  it('reads the pruned refs and skips the Pruning / URL header', () => {
    const out = [
      'Pruning origin',
      'URL: git@example.com:acme/production-pipeline.git',
      ' * [pruned] origin/feature/merged',
      ' * [pruned] origin/fix/login',
      '',
    ].join('\n');
    expect(parsePrunedRefs(out)).toEqual(['origin/feature/merged', 'origin/fix/login']);
  });

  it('reads nothing from a remote that had nothing stale', () => {
    expect(parsePrunedRefs('Pruning origin\nURL: ../bare.git\n')).toEqual([]);
  });
});

describe('gitErrorLine', () => {
  it('skips the push destination line and the hints to reach the reason', () => {
    const stderr = [
      'To gitlab.com:acme/production-pipeline.git',
      ' ! [rejected]            HEAD -> feature/x (non-fast-forward)',
      "error: failed to push some refs to 'gitlab.com:acme/production-pipeline.git'",
      'hint: Updates were rejected because the tip of your current branch is behind',
    ].join('\n');
    expect(gitErrorLine(stderr)).toBe('! [rejected] HEAD -> feature/x (non-fast-forward)');
  });

  it('keeps a hook message the remote sent', () => {
    const stderr = [
      'remote: ',
      'remote: GitLab: You are not allowed to push code to protected branches on this project.',
      'To gitlab.com:acme/production-pipeline.git',
      ' ! [remote rejected] main -> main (pre-receive hook declined)',
    ].join('\n');
    expect(gitErrorLine(stderr)).toBe(
      'remote: GitLab: You are not allowed to push code to protected branches on this project.',
    );
  });

  it('returns the first line of any other error and nothing for empty output', () => {
    expect(gitErrorLine('fatal: not a git repository\n')).toBe('fatal: not a git repository');
    expect(gitErrorLine('\n  \n')).toBeUndefined();
  });
});

describe('a refused remote operation on a host (plan 28 › spec 10.1)', () => {
  it('tells refused credentials from an unknown host key', async () => {
    const { isGitAuthFailure, gitHostKeyFailure, hostKeyMessage, hostAuthMessage } =
      await import('./git-parse');
    expect(isGitAuthFailure('git@github.com: Permission denied (publickey).')).toBe(true);
    expect(isGitAuthFailure("fatal: could not read Username for 'https://example.com'")).toBe(true);
    const hostKey =
      'No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.';
    // Not a credential problem: no key was even offered.
    expect(isGitAuthFailure(hostKey)).toBe(false);
    expect(gitHostKeyFailure(hostKey)).toEqual({ server: 'github.com' });
    expect(gitHostKeyFailure('Host key verification failed.')).toEqual({ server: null });
    // Other ssh wordings, and a non-22 port, which is never a pinned name
    // (provider-host-keys.ts keys on the bare service name only).
    expect(
      gitHostKeyFailure(
        "The authenticity of host 'gitlab.com (172.65.251.78)' can't be established.\nHost key verification failed.",
      ),
    ).toEqual({ server: 'gitlab.com' });
    expect(
      gitHostKeyFailure(
        'No ED25519 host key is known for [github.com]:2222 and you have requested strict checking.\nHost key verification failed.',
      ),
    ).toEqual({ server: '[github.com]:2222' });
    expect(gitHostKeyFailure('error: failed to push some refs')).toBeNull();
    expect(hostKeyMessage('build-box', 'github.com')).toBe(
      "build-box has not accepted github.com's host key - ssh to it once from a terminal there.",
    );
    expect(hostKeyMessage('build-box', null)).toContain("the remote's host key");
    expect(hostAuthMessage('build-box')).toMatch(/^build-box's credentials were refused/);
  });
});
