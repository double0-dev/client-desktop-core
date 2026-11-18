import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { GitIgnoredEntry } from './git-types';

/**
 * Integration tests for the git bridge, run against real throwaway repositories
 * in a temp dir.
 *
 * These drive the ACTUAL ipcMain handlers rather than extracted helpers, so the
 * sender-trust check and the payload validation are covered along with the git
 * work itself - the handlers are what the renderer reaches, and validation bugs
 * (an option-shaped ref, a path outside the repo) are exactly what matters here.
 *
 * Electron is stubbed: `ipcMain.handle` records handlers so the tests can invoke
 * them, and `shell.trashItem` stands in for the OS trash (discard/delete paths
 * would otherwise move real files to the user's Bin).
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const trashed: string[] = [];

// Every OS watcher `git:watch` holds open - `watch` is wrapped so a test can
// see one that leaked (opened, and never closed by any unwatch).
const { openWatchers } = vi.hoisted(() => ({ openWatchers: new Set<unknown>() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = ((...args: Parameters<typeof actual.watch>) => {
    const watcher = actual.watch(...args);
    openWatchers.add(watcher);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      openWatchers.delete(watcher);
      close();
    };
    return watcher;
  }) as typeof actual.watch;
  return { ...actual, watch };
});

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'double0-git-test-userdata') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: vi.fn() },
  shell: {
    trashItem: async (path: string) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    openExternal: vi.fn(),
  },
}));

const { registerGitIpc } = await import('./git');

/** A sender the real isTrustedSender() accepts: main frame, app origin. */
const trustedEvent = (() => {
  const mainFrame = { url: `${APP_ORIGIN}/index.html` };
  return { senderFrame: mainFrame, sender: { mainFrame, id: 1 } };
})();

const invoke = async <T = Record<string, unknown>>(
  channel: string,
  payload: unknown,
  event: unknown = trustedEvent,
): Promise<T> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(event, payload)) as T;
};

// --- repo fixtures ------------------------------------------------------------

let root: string;
let disposeIpc: () => void;

/** Run git in a fixture repo, ignoring the user's own global/system config so
 * the fixtures are identical on every machine. stderr is dropped - git narrates
 * ordinary success there ("Switched to a new branch…") and would drown the
 * test output. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

const write = (cwd: string, rel: string, body: string): void => {
  const full = join(cwd, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
};

/** A repo with one commit ("first"), on a known branch, with identity set. */
function makeRepo(name: string): string {
  const dir = mkdtempSync(join(root, `${name}-`));
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Emma Wilson');
  git(dir, 'config', 'user.email', 'emmaw@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // The handlers under test run the user's git WITH its config, and Git for
  // Windows ships `core.autocrlf=true` system-wide: checkouts came back `\r\n`
  // and a clean tree read as modified. The repo's own setting wins.
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'README.md', '# production-pipeline\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'first');
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'double0-git-'));
  disposeIpc = registerGitIpc();
});

afterAll(() => {
  disposeIpc();
  rmSync(root, { recursive: true, force: true });
});

let repo: string;
beforeEach(() => {
  repo = makeRepo('repo');
  trashed.length = 0;
});

// --- guards -------------------------------------------------------------------

describe('sender + payload guards', () => {
  const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };

  it('refuses a call from a frame that is not the app', async () => {
    expect(await invoke('git:status', { cwd: repo }, untrusted)).toMatchObject({ code: 'EACCES' });
  });

  it('refuses a call from a subframe even on the app origin', async () => {
    const mainFrame = { url: `${APP_ORIGIN}/index.html` };
    const subframe = { senderFrame: { url: mainFrame.url }, sender: { mainFrame } };
    expect(await invoke('git:status', { cwd: repo }, subframe)).toMatchObject({ code: 'EACCES' });
  });

  it('refuses a missing or non-string cwd', async () => {
    expect(await invoke('git:status', {})).toMatchObject({ code: 'EINVAL' });
    expect(await invoke('git:status', { cwd: 42 })).toMatchObject({ code: 'EINVAL' });
    expect(await invoke('git:status', { cwd: '' })).toMatchObject({ code: 'EINVAL' });
  });

  it('reports a non-repository directory without throwing', async () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    const { status } = await invoke<{ status: { repo: boolean } }>('git:status', { cwd: plain });
    expect(status.repo).toBe(false);
  });

  it('refuses a file outside the repository', async () => {
    const res = await invoke('git:show', { cwd: repo, path: '/etc/hosts' });
    expect(res).toMatchObject({ code: 'EOUTSIDE' });
  });
});

// --- reads --------------------------------------------------------------------

type Status = {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: {
    path: string;
    index: string;
    worktree: string;
    untracked: boolean;
    conflicted: boolean;
    origPath?: string;
  }[];
  userName: string | null;
  userEmail: string | null;
  operation?: string | null;
  headPushed?: boolean;
};

const statusOf = async (cwd = repo): Promise<Status> =>
  (await invoke<{ status: Status }>('git:status', { cwd })).status;

describe('git:status', () => {
  it('reads a clean repo', async () => {
    const status = await statusOf();
    expect(status).toMatchObject({ repo: true, branch: 'main', files: [] });
    expect(status.userName).toBe('Emma Wilson');
    expect(status.userEmail).toBe('emmaw@example.com');
  });

  it('sees an unstaged edit', async () => {
    write(repo, 'README.md', '# changed\n');
    const status = await statusOf();
    expect(status.files).toEqual([
      { path: 'README.md', index: ' ', worktree: 'M', untracked: false, conflicted: false },
    ]);
  });

  it('sees a staged edit', async () => {
    write(repo, 'README.md', '# changed\n');
    git(repo, 'add', '-A');
    expect((await statusOf()).files[0]).toMatchObject({ index: 'M', worktree: ' ' });
  });

  it('sees an untracked file', async () => {
    write(repo, 'new.ts', 'export {};\n');
    expect((await statusOf()).files[0]).toMatchObject({ path: 'new.ts', untracked: true });
  });

  it('lists every file inside an untracked folder, not the folder', async () => {
    // Without --untracked-files=all git collapses a brand-new directory into a
    // single `docs/` entry: the Changes list showed a folder row whose diff
    // could not open, and a second file in the same folder was invisible.
    write(repo, 'docs/deploy.md', '# deploy\n');
    write(repo, 'docs/guide/setup.md', '# setup\n');
    expect((await statusOf()).files.map((f) => f.path)).toEqual([
      'docs/deploy.md',
      'docs/guide/setup.md',
    ]);
  });

  it('sees a staged rename with its original path', async () => {
    git(repo, 'mv', 'README.md', 'DOCS.md');
    const file = (await statusOf()).files[0] as { path: string; origPath?: string };
    expect(file.path).toBe('DOCS.md');
    expect(file.origPath).toBe('README.md');
  });

  it('keeps spaces in paths', async () => {
    write(repo, 'design notes.md', 'hi\n');
    expect((await statusOf()).files.map((f) => f.path)).toContain('design notes.md');
  });

  it('reports no upstream for a local-only branch', async () => {
    const status = await statusOf();
    expect(status.upstream).toBeNull();
    expect(status).toMatchObject({ ahead: 0, behind: 0 });
  });
});

describe('git:refs', () => {
  type Refs = {
    repo: boolean;
    branches: { name: string; current: boolean }[];
    remotes: { name: string; branches: string[] }[];
    worktrees: { path: string; name: string; branch: string | null }[];
    stashes: {
      index: number;
      sha: string;
      parents: string[];
      author: string;
      email: string;
      time: number;
      message: string;
    }[];
    tags: string[];
  };
  const refsOf = async (cwd = repo): Promise<Refs> =>
    (await invoke<{ refs: Refs }>('git:refs', { cwd })).refs;

  it('lists branches and marks the checked-out one', async () => {
    git(repo, 'branch', 'feature/tasks');
    const refs = await refsOf();
    expect(refs.branches.map((b) => b.name).sort()).toEqual(['feature/tasks', 'main']);
    expect(refs.branches.find((b) => b.current)?.name).toBe('main');
  });

  it('lists tags newest first', async () => {
    git(repo, 'tag', 'v1.0.0');
    git(repo, 'tag', 'v1.1.0');
    expect((await refsOf()).tags).toContain('v1.0.0');
    expect((await refsOf()).tags).toContain('v1.1.0');
  });

  it('lists stashes with index, sha and parents', async () => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    write(repo, 'README.md', '# stash me\n');
    write(repo, 'scratch.txt', 'untracked\n');
    git(repo, 'stash', 'push', '--include-untracked', '-m', 'wip');
    const refs = await refsOf();
    const stash = refs.stashes[0];
    expect(stash).toMatchObject({ index: 0 });
    expect(stash.message).toContain('wip');
    expect(stash.sha).toMatch(/^[0-9a-f]{40}$/);
    // First parent = the commit the stash hangs off; third = untracked files.
    expect(stash.parents[0]).toBe(head);
    expect(stash.parents).toHaveLength(3);
    expect(stash.author.length).toBeGreaterThan(0);
    expect(stash.time).toBeGreaterThan(0);
  });

  it('lists the main worktree, and a linked one with its branch', async () => {
    const wt = join(repo, '.worktree', 'fix-flaky-tests');
    git(repo, 'worktree', 'add', '-b', 'fix-flaky-tests', wt);
    const refs = await refsOf();
    expect(refs.worktrees).toHaveLength(2);
    expect(refs.worktrees.map((w) => w.name)).toContain('fix-flaky-tests');
    expect(refs.worktrees.find((w) => w.name === 'fix-flaky-tests')?.branch).toBe(
      'fix-flaky-tests',
    );
  });

  it('reports repo: false outside a repository', async () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    expect((await refsOf(plain)).repo).toBe(false);
  });
});

describe('git:sessionStats', () => {
  it('counts staged work too (worktree vs HEAD)', async () => {
    write(repo, 'README.md', '# changed\n');
    git(repo, 'add', '-A');
    const { stats } = await invoke<{ stats: { add: number; del: number } }>('git:sessionStats', {
      cwd: repo,
    });
    expect(stats).toEqual({ add: 1, del: 1 });
  });

  it('is zero on a clean tree', async () => {
    const { stats } = await invoke<{ stats: { add: number; del: number } }>('git:sessionStats', {
      cwd: repo,
    });
    expect(stats).toEqual({ add: 0, del: 0 });
  });
});

describe('git:watch', () => {
  // A sender that can receive the debounced `git:changed` should one fire.
  const watchEvent = (() => {
    const mainFrame = { url: `${APP_ORIGIN}/index.html` };
    return {
      senderFrame: mainFrame,
      sender: { mainFrame, id: 7, send: vi.fn(), isDestroyed: () => false },
    };
  })();

  it('shares one OS watcher between watches that race for the same root', async () => {
    const before = openWatchers.size;
    // Both calls resolve the git dir before either registers - what a view's
    // Changes provider and its sidebar diff stats do on mount. Each used to
    // open its own watcher; the second overwrote the first, which leaked.
    const results = await Promise.all([
      invoke('git:watch', { root: repo }, watchEvent),
      invoke('git:watch', { root: repo }, watchEvent),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(openWatchers.size).toBe(before + 1);

    // Ref-counted: the watcher outlives the first release, not the second.
    await invoke('git:unwatch', { root: repo }, watchEvent);
    expect(openWatchers.size).toBe(before + 1);
    await invoke('git:unwatch', { root: repo }, watchEvent);
    expect(openWatchers.size).toBe(before);
  });

  it('opens nothing for a folder outside any repository', async () => {
    const before = openWatchers.size;
    const plain = mkdtempSync(join(root, 'plain-'));
    expect(await invoke('git:watch', { root: plain }, watchEvent)).toEqual({
      error: 'Not a git repository',
    });
    expect(openWatchers.size).toBe(before);
  });
});

describe('git:show', () => {
  it('returns the indexed content of a file', async () => {
    const res = await invoke<{ content: string | null }>('git:show', {
      cwd: repo,
      path: join(repo, 'README.md'),
    });
    expect(res.content).toBe('# production-pipeline\n');
  });

  it('returns null content for an untracked file', async () => {
    write(repo, 'new.ts', 'export {};\n');
    const res = await invoke<{ content: string | null }>('git:show', {
      cwd: repo,
      path: join(repo, 'new.ts'),
    });
    expect(res.content).toBeNull();
  });
});

describe('branches', () => {
  it('creates a branch and checks it out', async () => {
    expect(
      await invoke('git:createBranch', { cwd: repo, name: 'feature/tasks', checkout: true }),
    ).toEqual({ ok: true });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/tasks');
  });

  it('creates a branch without leaving the current one', async () => {
    await invoke('git:createBranch', { cwd: repo, name: 'feature/tasks', checkout: false });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(repo, 'branch', '--list', 'feature/tasks')).toContain('feature/tasks');
  });

  it('deletes a merged branch', async () => {
    git(repo, 'branch', 'side');
    expect(await invoke('git:deleteBranch', { cwd: repo, name: 'side' })).toEqual({ ok: true });
    expect(git(repo, 'branch', '--list', 'side').trim()).toBe('');
  });

  it('refuses to delete an unmerged branch unless forced', async () => {
    git(repo, 'checkout', '-b', 'side');
    write(repo, 'side.ts', 'side\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'side work');
    git(repo, 'checkout', 'main');

    const refused = await invoke<{ error?: string }>('git:deleteBranch', {
      cwd: repo,
      name: 'side',
    });
    expect(refused.error).toBeTruthy();
    expect(await invoke('git:deleteBranch', { cwd: repo, name: 'side', force: true })).toEqual({
      ok: true,
    });
  });
});

describe('git:repoRoot', () => {
  // This is what decides which repo a session's worktree is cut from, so the
  // sub-repo cases below are the feature, not edge cases: a project can be a
  // folder of independent checkouts.
  it('resolves the repo root from the repo itself', async () => {
    expect(await invoke('git:repoRoot', { cwd: repo })).toEqual({ root: realpathSync(repo) });
  });

  it('resolves the repo root from a folder deep inside it', async () => {
    mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
    expect(await invoke('git:repoRoot', { cwd: join(repo, 'src', 'auth') })).toEqual({
      root: realpathSync(repo),
    });
  });

  it('resolves a nested repo to ITSELF, not to the repo containing it', async () => {
    // The folder-of-repos case: `<project>/api` is its own checkout even though
    // it sits inside another one. Answering with the outer repo would branch the
    // session in the wrong place and show the wrong changes.
    const inner = join(repo, 'api');
    mkdirSync(inner);
    git(inner, 'init', '--initial-branch=main');
    expect(await invoke('git:repoRoot', { cwd: inner })).toEqual({ root: realpathSync(inner) });
  });

  it('answers null for a folder in no repository at all', async () => {
    // Not an error: the caller then launches the session plainly in the folder
    // instead of failing at the user.
    const plain = mkdtempSync(join(root, 'plain-'));
    expect(await invoke('git:repoRoot', { cwd: plain })).toEqual({ root: null });
  });

  it('reports a linked worktree as its own root rather than the main checkout', async () => {
    const path = join(repo, '.worktree', 'fix-auth');
    await invoke('git:worktreeAdd', { cwd: repo, path, branch: 'fix-auth' });
    expect(await invoke('git:repoRoot', { cwd: path })).toEqual({ root: realpathSync(path) });
  });
});

describe('git:childRepos', () => {
  // A folder-of-repos project: `acme/` is no checkout, its stacks are. This is
  // what a tool's repo picker lists.
  it('lists the checkouts under a folder that is in no repository', async () => {
    const parent = mkdtempSync(join(root, 'acme-'));
    git(parent, 'init', '--initial-branch=main', 'web');
    git(parent, 'init', '--initial-branch=main', 'api');
    mkdirSync(join(parent, 'notes'));
    expect(await invoke('git:childRepos', { cwd: parent })).toEqual({
      repos: [
        { name: 'api', path: join(parent, 'api') },
        { name: 'web', path: join(parent, 'web') },
      ],
    });
  });

  it('answers empty inside a repository, nested checkouts or not', async () => {
    // The folder already has its repo - offering a picker there would let the
    // tools wander off into a vendored checkout.
    git(repo, 'init', '--initial-branch=main', 'vendor-lib');
    expect(await invoke('git:childRepos', { cwd: repo })).toEqual({ repos: [] });
  });

  it('answers a folder that is gone without throwing', async () => {
    // A project whose folder was moved or deleted: the picker treats any
    // answer without repos as a plain folder, so this only must not reject.
    const res = await invoke<{ repos?: unknown[]; error?: string }>('git:childRepos', {
      cwd: join(root, 'moved-away'),
    });
    expect(res.repos ?? []).toEqual([]);
  });

  it('refuses a bad payload and an untrusted sender', async () => {
    const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };
    expect(await invoke('git:childRepos', { cwd: root }, untrusted)).toMatchObject({
      code: 'EACCES',
    });
    expect(await invoke('git:childRepos', { cwd: 42 })).toMatchObject({ code: 'EINVAL' });
  });
});

describe('worktrees', () => {
  it('adds a worktree on a new branch', async () => {
    const path = join(repo, '.worktree', 'fix-flaky-tests');
    expect(await invoke('git:worktreeAdd', { cwd: repo, path, branch: 'fix-flaky-tests' })).toEqual(
      { ok: true },
    );
    expect(existsSync(join(path, 'README.md'))).toBe(true);
  });

  it('removes a worktree again', async () => {
    const path = join(repo, '.worktree', 'fix-flaky-tests');
    await invoke('git:worktreeAdd', { cwd: repo, path, branch: 'fix-flaky-tests' });
    expect(await invoke('git:worktreeRemove', { cwd: repo, path })).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to remove a dirty worktree unless forced', async () => {
    const path = join(repo, '.worktree', 'fix-flaky-tests');
    await invoke('git:worktreeAdd', { cwd: repo, path, branch: 'fix-flaky-tests' });
    write(path, 'dirty.ts', 'uncommitted\n');

    const refused = await invoke<{ error?: string }>('git:worktreeRemove', { cwd: repo, path });
    expect(refused.error).toBeTruthy();
    expect(await invoke('git:worktreeRemove', { cwd: repo, path, force: true })).toEqual({
      ok: true,
    });
  });
});

// --- worktree seeding (Settings → Worktrees) -----------------------------------

/** A sender the trust check refuses: a frame from outside the app origin. */
const foreignEvent = (() => {
  const mainFrame = { url: 'https://evil.example/index.html' };
  return { senderFrame: mainFrame, sender: { mainFrame, id: 2 } };
})();

describe('ignored entries', () => {
  const commitIgnores = (body: string): void => {
    write(repo, '.gitignore', body);
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore');
  };

  it('lists what the checkout ignores - folders as one entry - and locks .worktree/', async () => {
    commitIgnores('.env\nnode_modules/\ncoverage/\n.worktree/\n*.local\n');
    write(repo, '.env', 'SECRET=1\n');
    write(repo, 'node_modules/left-pad/index.js', 'module.exports = 1\n');
    write(repo, 'packages/api/.env.local', 'PORT=4000\n');
    write(repo, 'notes.txt', 'untracked but not ignored\n');
    const wt = join(repo, '.worktree', 'fix-auth');
    await invoke('git:worktreeAdd', { cwd: repo, path: wt, branch: 'fix-auth' });

    // Asked from a subfolder: the list is always relative to the repo root.
    const res = await invoke<{ root: string; entries: GitIgnoredEntry[] }>('git:ignoredEntries', {
      cwd: join(repo, 'packages'),
      sizes: true,
    });
    expect(res.root).toBe(realpathSync(repo));
    expect(res.entries.map((e) => e.path)).toEqual([
      '.env',
      '.worktree/',
      'node_modules/',
      'packages/api/.env.local',
    ]);
    expect(res.entries[0]).toEqual({ path: '.env', kind: 'file' });
    expect(res.entries[1]).toEqual({ path: '.worktree/', kind: 'dir', locked: 'never copied' });
    expect(res.entries[2].kind).toBe('dir');
    if (process.platform !== 'win32') expect(res.entries[2].bytes).toBeGreaterThan(0);
    // Sizes are opt-in - the project list never pays for a du per folder.
    const plain = await invoke<{ entries: GitIgnoredEntry[] }>('git:ignoredEntries', { cwd: repo });
    expect(plain.entries[2]).toEqual({ path: 'node_modules/', kind: 'dir' });
  });

  it('answers root null for a folder in no repository', async () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    expect(await invoke('git:ignoredEntries', { cwd: plain })).toEqual({ root: null, entries: [] });
  });

  it('rejects a foreign sender and a missing cwd', async () => {
    expect(await invoke('git:ignoredEntries', { cwd: repo }, foreignEvent)).toEqual({
      error: 'Untrusted sender',
      code: 'EACCES',
    });
    expect(await invoke('git:ignoredEntries', {})).toEqual({
      error: 'Invalid path',
      code: 'EINVAL',
    });
  });
});

describe('worktree seed', () => {
  const seeded = async (): Promise<string> => {
    write(repo, '.gitignore', '.env\ndist/\n*.local\n.worktree/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore');
    write(repo, '.env', 'SECRET=1\n');
    write(repo, 'packages/api/.env.local', 'PORT=4000\n');
    write(repo, 'dist/index.js', 'built\n');
    write(repo, 'dist/assets/app.css', 'body{}\n');
    const wt = join(repo, '.worktree', 'fix-auth');
    await invoke('git:worktreeAdd', { cwd: repo, path: wt, branch: 'fix-auth' });
    return wt;
  };

  it('copies ticked files and folders to the same paths, skipping the missing and the locked', async () => {
    const wt = await seeded();
    const res = await invoke('git:worktreeSeed', {
      repoRoot: repo,
      worktreePath: wt,
      paths: ['.env', 'packages/api/.env.local', 'dist/', '.worktree/', '../escape', 'gone.txt'],
    });
    expect(res).toEqual({
      copied: ['.env', 'packages/api/.env.local', 'dist/'],
      skipped: ['.worktree/', '../escape', 'gone.txt'],
      errors: [],
    });
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(wt, 'packages', 'api', '.env.local'), 'utf8')).toBe('PORT=4000\n');
    expect(readFileSync(join(wt, 'dist', 'assets', 'app.css'), 'utf8')).toBe('body{}\n');
    expect(existsSync(join(wt, '.worktree'))).toBe(false);
    // The copies are ignored in the new checkout too - nothing the agent could
    // commit by accident.
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('copies nothing when nothing is ticked', async () => {
    const wt = await seeded();
    expect(
      await invoke('git:worktreeSeed', { repoRoot: repo, worktreePath: wt, paths: [] }),
    ).toEqual({ copied: [], skipped: [], errors: [] });
    expect(existsSync(join(wt, '.env'))).toBe(false);
  });

  it('refuses to seed a checkout onto itself, a foreign sender, and a missing path', async () => {
    expect(
      await invoke('git:worktreeSeed', { repoRoot: repo, worktreePath: repo, paths: ['.env'] }),
    ).toEqual({ error: 'Invalid path', code: 'EINVAL' });
    expect(
      await invoke(
        'git:worktreeSeed',
        { repoRoot: repo, worktreePath: '/x', paths: [] },
        foreignEvent,
      ),
    ).toEqual({ error: 'Untrusted sender', code: 'EACCES' });
    expect(await invoke('git:worktreeSeed', { repoRoot: repo })).toEqual({
      error: 'Invalid path',
      code: 'EINVAL',
    });
  });
});

// Files from this computer copied into a remote worktree. Its copy is covered in
// git-remote.test.ts (it needs a host); here, what it refuses on this machine.
describe('seed from this computer - refusals', () => {
  it('refuses a foreign sender, a bad payload and option-shaped or relative paths', async () => {
    expect(
      await invoke(
        'git:seedFromLocal',
        { sourceRoot: repo, worktreePath: '/x', paths: ['.env'] },
        foreignEvent,
      ),
    ).toEqual({ error: 'Untrusted sender', code: 'EACCES' });
    expect(await invoke('git:seedFromLocal', null)).toEqual({
      error: 'Invalid path',
      code: 'EINVAL',
    });
    expect(
      await invoke('git:seedFromLocal', { sourceRoot: repo, worktreePath: repo, paths: '.env' }),
    ).toEqual({ error: 'Invalid path', code: 'EINVAL' });
    expect(
      await invoke('git:seedFromLocal', {
        sourceRoot: '--upload-pack=x',
        worktreePath: '/w',
        paths: [],
      }),
    ).toMatchObject({ code: 'EINVAL' });
  });

  it('refuses a destination on this computer - a local worktree is seeded by git:worktreeSeed', async () => {
    const wt = join(repo, '.worktree', 'local-dest');
    mkdirSync(wt, { recursive: true });
    write(repo, '.env', 'SECRET=1\n');
    expect(
      await invoke('git:seedFromLocal', { sourceRoot: repo, worktreePath: wt, paths: ['.env'] }),
    ).toEqual({ error: 'The worktree must be on a host', code: 'EINVAL' });
    expect(existsSync(join(wt, '.env'))).toBe(false);
  });
});
