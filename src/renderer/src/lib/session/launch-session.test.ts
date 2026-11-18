import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { bridgeSlots } from '@renderer/test-support';
import { stubApi } from '@renderer/test-support';

// Hoisted: `vi.mock` factories run before module-level consts are initialised.
const { insert, alertDialog, getProject } = vi.hoisted(() => ({
  insert: vi.fn(),
  alertDialog: vi.fn(async () => {}),
  getProject: vi.fn((): Record<string, unknown> | undefined => undefined),
}));
vi.mock('@renderer/lib/collections', () => ({
  agentSessionsCollection: { insert },
  projectsCollection: { get: getProject },
}));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({ alertDialog }));

import { launchSession, seedFailure } from '@renderer/lib/session/launch-session';

// Core reads the hosts and session-view bridges through the extension's slots.
beforeEach(() => installRendererExtension(bridgeSlots()));
afterEach(() => resetRendererExtensionForTest());

const OPTS = {
  startCommand: '',
  agentLabel: 'Terminal',
  runOnNewTerminal: false,
  projectId: 'project-1',
  projectPath: '/repo/production-pipeline',
  ownerId: 'local',
  worktree: true,
  setupCommand: '',
};

/**
 * `window.api` with the git calls launch makes for a worktree session. `taken`
 * seeds what the repo already holds: local branch names and registered
 * worktree paths (both block a new branch of that name).
 */
function apiWithGit(taken: { branches?: string[]; worktrees?: string[] } = {}) {
  return stubApi({
    git: {
      repoRoot: vi.fn(async () => ({ root: '/repo/production-pipeline' })),
      refs: vi.fn(async () => ({
        refs: {
          repo: true,
          branches: (taken.branches ?? []).map((name) => ({
            name,
            current: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            gone: false,
          })),
          remotes: [],
          worktrees: (taken.worktrees ?? []).map((path) => ({
            path,
            name: path.split('/').pop() ?? '',
            branch: null,
          })),
          stashes: [],
          tags: [],
          fetchedAt: null,
        },
      })),
      worktreeAdd: vi.fn(async () => ({ ok: true })),
      createBranch: vi.fn(async (): Promise<{ ok?: true; error?: string }> => ({ ok: true })),
      worktreeSeed: vi.fn(async () => ({ copied: [], skipped: [], errors: [] })),
    },
    terminal: { create: vi.fn() },
  });
}

describe('launchSession worktree naming', () => {
  beforeEach(() => {
    // Module-level spies survive restoreMocks.
    insert.mockClear();
    alertDialog.mockClear();
  });

  it('creates the branch and the worktree folder in lowercase', async () => {
    const api = apiWithGit();

    await launchSession({ ...OPTS, name: 'Fix Login Redirect' });

    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-login-redirect',
      'fix-login-redirect',
    );
  });

  it('keeps the session label as typed - only the git ref is folded down', async () => {
    apiWithGit();

    await launchSession({ ...OPTS, name: 'Fix Login Redirect' });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Fix Login Redirect',
        worktreePath: '/repo/production-pipeline/.worktree/fix-login-redirect',
      }),
    );
  });

  it('takes the next free suffix when the branch already exists', async () => {
    // A second session from the same card or ticket wants the branch the
    // first one took; `git worktree add -b` refuses it, and the launch used to
    // die on that alert instead of creating anything.
    const api = apiWithGit({ branches: ['fix-login-redirect'] });

    const id = await launchSession({ ...OPTS, name: 'Fix Login Redirect' });

    expect(id).not.toBeNull();
    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-login-redirect-2',
      'fix-login-redirect-2',
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Fix Login Redirect',
        worktreePath: '/repo/production-pipeline/.worktree/fix-login-redirect-2',
      }),
    );
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it('also skips a registered worktree folder whose branch is gone', async () => {
    // Branch deleted but the worktree never removed: the folder still blocks
    // the path, so `-2` is taken by the branch and `-3` is the first free name.
    const api = apiWithGit({
      branches: ['fix-login-redirect-2'],
      worktrees: ['/repo/production-pipeline/.worktree/fix-login-redirect'],
    });

    await launchSession({ ...OPTS, name: 'Fix Login Redirect' });

    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-login-redirect-3',
      'fix-login-redirect-3',
    );
  });

  it('launches under the plain name when the refs read fails', async () => {
    const api = apiWithGit();
    api.git.refs.mockRejectedValueOnce(new Error('boom'));

    await launchSession({ ...OPTS, name: 'Fix Login Redirect' });

    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-login-redirect',
      'fix-login-redirect',
    );
  });

  it('refuses a name that sanitizes to nothing instead of creating a worktree', async () => {
    const api = apiWithGit();

    expect(await launchSession({ ...OPTS, name: '///' })).toBeNull();
    expect(api.git.worktreeAdd).not.toHaveBeenCalled();
    expect(alertDialog).toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('launchSession with a branch instead of a worktree', () => {
  const BRANCH_OPTS = { ...OPTS, worktree: false, branch: true };

  beforeEach(() => {
    insert.mockClear();
    alertDialog.mockClear();
  });

  it('switches the repo containing the folder to a new branch and runs in the folder', async () => {
    const api = apiWithGit();

    const id = await launchSession({
      ...BRANCH_OPTS,
      name: 'Fix Login Redirect',
      rootPath: '/repo/production-pipeline/api',
    });

    expect(id).not.toBeNull();
    expect(api.git.repoRoot).toHaveBeenCalledWith('/repo/production-pipeline/api');
    expect(api.git.createBranch).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      'fix-login-redirect',
      true,
    );
    // No worktree: the session stays rooted where the card pointed it.
    expect(api.git.worktreeAdd).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: null, rootPath: '/repo/production-pipeline/api' }),
    );
  });

  it('takes the next free suffix when the branch already exists', async () => {
    // `git switch -c` refuses an existing branch just like `worktree add -b`.
    const api = apiWithGit({ branches: ['fix-login-redirect'] });

    await launchSession({ ...BRANCH_OPTS, name: 'Fix Login Redirect' });

    expect(api.git.createBranch).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      'fix-login-redirect-2',
      true,
    );
  });

  it('creates nothing and says why when git refuses the branch', async () => {
    const api = apiWithGit();
    api.git.createBranch.mockResolvedValueOnce({ error: 'Could not create the branch' });

    expect(await launchSession({ ...BRANCH_OPTS, name: 'Fix Login Redirect' })).toBeNull();
    expect(alertDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Couldn’t create a branch' }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('ignores the branch flag when a worktree is cut', async () => {
    // The worktree brings its own branch; switching the main checkout as well
    // would move the user's own working tree under them.
    const api = apiWithGit();

    await launchSession({ ...OPTS, branch: true, name: 'Fix Login Redirect' });

    expect(api.git.worktreeAdd).toHaveBeenCalled();
    expect(api.git.createBranch).not.toHaveBeenCalled();
  });

  it('leaves the checkout alone when neither is asked for', async () => {
    const api = apiWithGit();

    await launchSession({ ...OPTS, worktree: false, name: 'Fix Login Redirect' });

    expect(api.git.createBranch).not.toHaveBeenCalled();
    expect(api.git.worktreeAdd).not.toHaveBeenCalled();
  });
});

describe('launchSession for a project on a remote host', () => {
  beforeEach(() => {
    insert.mockClear();
    alertDialog.mockClear();
  });

  // M2: git runs on the host through main (host-runtime), so a remote
  // project's session gets its worktree cut there like a local one.
  it('cuts the worktree on the host like a local project', async () => {
    getProject.mockReturnValueOnce({ id: 'project-1', hostId: 'h1', worktreeCopyPaths: [] });
    const api = apiWithGit();
    const id = await launchSession({ ...OPTS, name: 'Fix Login Redirect' });
    expect(id).not.toBeNull();
    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-login-redirect',
      'fix-login-redirect',
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/repo/production-pipeline/.worktree/fix-login-redirect',
      }),
    );
  });

  it('cuts a branch on the host without a worktree', async () => {
    getProject.mockReturnValueOnce({ id: 'project-1', hostId: 'h1', worktreeCopyPaths: [] });
    const api = apiWithGit();
    await launchSession({ ...OPTS, worktree: false, branch: true, name: 'Fix Login Redirect' });
    expect(api.git.createBranch).toHaveBeenCalled();
  });
});

describe('launchSession without a name (auto-naming)', () => {
  beforeEach(() => {
    insert.mockClear();
    alertDialog.mockClear();
  });

  it('creates the session with the template label standing in, marked autoNamed', async () => {
    apiWithGit();

    const id = await launchSession({ ...OPTS, worktree: false, name: '  ' });

    expect(id).not.toBeNull();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ id, label: 'Terminal', autoNamed: true }),
    );
  });

  it('a typed name is never auto-named', async () => {
    apiWithGit();

    await launchSession({ ...OPTS, worktree: false, name: 'fix-auth' });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'fix-auth', autoNamed: false }),
    );
  });

  it('cuts the worktree branch from the template plus the session id head', async () => {
    // Renames never rename the branch, so an unnamed session's branch must be
    // unique and traceable on its own - the id head is both.
    const api = apiWithGit();

    const id = await launchSession({ ...OPTS, name: '' });

    expect(id).not.toBeNull();
    const branch = `terminal-${(id as string).slice(0, 8).toLowerCase()}`;
    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      `/repo/production-pipeline/.worktree/${branch}`,
      branch,
    );
  });
});

describe('launchSession with a name longer than the label column', () => {
  // A task card's title or a ticket's `KEY summary` is as long as it was
  // written there; the schema caps the label at 64 characters, and an
  // over-long one made `insert` throw - so the launch died with nothing
  // created (tick off) or a stray worktree + branch behind it (tick on).
  const LONG =
    'PROD-1234 Rate limit the webhook endpoint so that clients cannot overload the ingestion service';
  const LABEL = 'PROD-1234 Rate limit the webhook endpoint so that clients cannot';

  beforeEach(() => {
    insert.mockClear();
    alertDialog.mockClear();
  });

  it('runs the session in the project folder under the clamped label', async () => {
    const api = apiWithGit();

    const id = await launchSession({ ...OPTS, worktree: false, name: LONG });

    expect(id).not.toBeNull();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ id, label: LABEL, worktreePath: null, autoNamed: false }),
    );
    expect(api.git.worktreeAdd).not.toHaveBeenCalled();
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/production-pipeline' }),
    );
  });

  it('still cuts the worktree, from the clamped label, and records the session', async () => {
    const api = apiWithGit();

    const id = await launchSession({ ...OPTS, name: LONG });

    expect(id).not.toBeNull();
    // The ref mirrors the clamped label, folded down and cut at git's 60.
    const branch = 'prod-1234-rate-limit-the-webhook-endpoint-so-that-clients-ca';
    expect(api.git.worktreeAdd).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      `/repo/production-pipeline/.worktree/${branch}`,
      branch,
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        label: LABEL,
        worktreePath: `/repo/production-pipeline/.worktree/${branch}`,
      }),
    );
  });
});

describe('launchSession worktree setup (Settings → Worktrees)', () => {
  beforeEach(() => {
    insert.mockClear();
    getProject.mockReset();
  });

  const withSetup = (setup: {
    worktreeCopyPaths: string[];
    worktreeSetupCommand: string | null;
  }): void => {
    getProject.mockReturnValue({ id: 'project-1', name: 'production-pipeline', ...setup });
  };

  it("copies the project's ticked ignored files into the new worktree before any shell spawns", async () => {
    withSetup({
      worktreeCopyPaths: ['.env', 'packages/api/.env.local'],
      worktreeSetupCommand: 'pnpm install',
    });
    const api = apiWithGit();
    const id = await launchSession({ ...OPTS, name: 'fix-auth', setupCommand: undefined });
    expect(api.git.worktreeSeed).toHaveBeenCalledWith(
      '/repo/production-pipeline',
      '/repo/production-pipeline/.worktree/fix-auth',
      ['.env', 'packages/api/.env.local'],
    );
    const seededAt = api.git.worktreeSeed.mock.invocationCallOrder[0];
    for (const spawnedAt of api.terminal.create.mock.invocationCallOrder) {
      expect(spawnedAt).toBeGreaterThan(seededAt);
    }
    // With no setup command of its own, the launch runs the project's.
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: `setup:${id}`, initialCommand: 'pnpm install' }),
    );
  });

  it("lets the launch's own setup command win - an explicit empty one runs nothing", async () => {
    withSetup({ worktreeCopyPaths: [], worktreeSetupCommand: 'pnpm install' });
    const api = apiWithGit();
    await launchSession({ ...OPTS, name: 'a', setupCommand: 'npm ci' });
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ initialCommand: 'npm ci' }),
    );
    api.terminal.create.mockClear();
    await launchSession({ ...OPTS, name: 'b', setupCommand: '' });
    const spawned = api.terminal.create.mock.calls.map(([arg]) => String(arg.id));
    expect(spawned.some((ptyId) => ptyId.startsWith('setup:'))).toBe(false);
  });

  it('skips the copy when nothing is ticked or the project is unknown', async () => {
    const api = apiWithGit();
    await launchSession({ ...OPTS, name: 'a' });
    withSetup({ worktreeCopyPaths: [], worktreeSetupCommand: null });
    await launchSession({ ...OPTS, name: 'b' });
    expect(api.git.worktreeSeed).not.toHaveBeenCalled();
  });

  it('still launches when the copy fails', async () => {
    withSetup({ worktreeCopyPaths: ['.env'], worktreeSetupCommand: null });
    const api = apiWithGit();
    api.git.worktreeSeed.mockRejectedValueOnce(new Error('disk full'));
    expect(await launchSession({ ...OPTS, name: 'fix-auth' })).toBeTruthy();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe('launchSession for a runtime session', () => {
  beforeEach(() => {
    insert.mockClear();
    getProject.mockReset();
  });

  const CHAT = {
    ...OPTS,
    worktree: false,
    name: 'fix-login',
    startCommand: 'npx -y @agentclientprotocol/claude-agent-acp@0.85.1',
    agentLabel: 'Claude Code',
    runOnNewTerminal: true,
    runtime: 'gadget-runtime',
  };

  it('records the acp runtime, starts idle and never runs the agent command in a shell', async () => {
    const api = apiWithGit();
    const open = vi.fn(async () => ({ chunks: [] }));
    (api as unknown as { sessionView: unknown }).sessionView = { open };

    const id = await launchSession(CHAT);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(id));

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        runtime: 'gadget-runtime',
        status: 'idle',
        startCommand: CHAT.startCommand,
        // "+" terminals of a runtime session are plain shells.
        runOnNewTerminal: false,
      }),
    );
    expect(api.terminal.create).not.toHaveBeenCalled();
  });

  it('still runs the worktree setup command in its own tab', async () => {
    const api = apiWithGit();
    (api as unknown as { sessionView: unknown }).sessionView = { open: vi.fn(async () => null) };

    const id = await launchSession({ ...CHAT, worktree: true, setupCommand: 'pnpm i' });

    expect(api.terminal.create).toHaveBeenCalledTimes(1);
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: `setup:${id}`, initialCommand: 'pnpm i' }),
    );
  });

  it('a terminal session is unchanged: runtime null, conversation shell spawned', async () => {
    const api = apiWithGit();
    const id = await launchSession({ ...OPTS, worktree: false, name: 'x', startCommand: 'claude' });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ id, runtime: null, status: 'active' }),
    );
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: `conversation:${id}`, initialCommand: 'claude' }),
    );
  });
});

describe('launchSession on a worktree that already exists', () => {
  beforeEach(() => {
    insert.mockClear();
    getProject.mockReset();
  });

  it('cuts nothing, seeds it, records it and spawns under the id it was given', async () => {
    getProject.mockReturnValue({ worktreeCopyPaths: ['.env'], worktreeSetupCommand: null });
    const api = apiWithGit();
    const id = '0b9d7a8e-3c1f-4f2a-9e6d-5a4b3c2d1e0f';
    const wt = '/home/emmaw/production-pipeline/.worktree/login-fix';

    const got = await launchSession({
      ...OPTS,
      worktree: false,
      name: 'Fix login',
      startCommand: 'claude',
      id,
      existingWorktree: { path: wt, repoRoot: '/home/emmaw/production-pipeline' },
    });

    expect(got).toBe(id);
    expect(api.git.worktreeAdd).not.toHaveBeenCalled();
    expect(api.git.createBranch).not.toHaveBeenCalled();
    expect(api.git.worktreeSeed).toHaveBeenCalledWith('/home/emmaw/production-pipeline', wt, [
      '.env',
    ]);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ id, worktreePath: wt }));
    expect(api.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: `conversation:${id}`, cwd: wt, initialCommand: 'claude' }),
    );
  });
});

// Files from this computer copied into a worktree cut on a host - after the host
// project's own seed (so this computer's files win for the ticked paths) and
// before any shell spawns (so the agent's first command finds them).
describe('launchSession with files from this computer', () => {
  const BOX = '/home/emmaw/src/acme';
  const order: string[] = [];
  let seedFromLocal: ReturnType<typeof vi.fn<() => Promise<Record<string, unknown>>>>;
  beforeEach(() => {
    order.length = 0;
    insert.mockClear();
    alertDialog.mockClear();
    getProject.mockReturnValue({ worktreeCopyPaths: ['.env.host'], worktreeSetupCommand: null });
    seedFromLocal = vi.fn(async (): Promise<Record<string, unknown>> => {
      order.push('seedFromLocal');
      return { copied: ['.env'], skipped: [], errors: [] };
    });
    stubApi({
      git: {
        repoRoot: vi.fn(async () => ({ root: BOX })),
        refs: vi.fn(async () => ({ refs: { branches: [], worktrees: [] } })),
        worktreeAdd: vi.fn(async () => {
          order.push('worktreeAdd');
          return { ok: true };
        }),
        worktreeSeed: vi.fn(async () => {
          order.push('worktreeSeed');
          return { copied: ['.env.host'], skipped: [], errors: [] };
        }),
        seedFromLocal,
      },
      terminal: { create: vi.fn(() => order.push('terminal.create')) },
    });
  });

  const launch = (paths: string[]) =>
    launchSession({
      ...OPTS,
      name: 'fix-auth',
      projectId: 'p-box',
      projectPath: BOX,
      localSeed: { sourceRoot: '/Users/emmaw/acme', paths },
    });

  it("copies after the host's own seed and before any shell spawns", async () => {
    expect(await launch(['.env'])).toBeTruthy();
    expect(order).toEqual(['worktreeAdd', 'worktreeSeed', 'seedFromLocal', 'terminal.create']);
    expect(seedFromLocal).toHaveBeenCalledWith('/Users/emmaw/acme', `${BOX}/.worktree/fix-auth`, [
      '.env',
    ]);
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it('skips the call when nothing was ticked', async () => {
    await launch([]);
    expect(seedFromLocal).not.toHaveBeenCalled();
  });

  it('still launches when the copy fails, and says which files did not arrive', async () => {
    seedFromLocal.mockResolvedValueOnce({
      error: 'Host is unreachable',
      code: 'EHOSTDOWN',
    });
    expect(await launch(['.env'])).toBeTruthy();
    expect(order.at(-1)).toBe('terminal.create');
    expect(alertDialog).toHaveBeenCalledWith({
      title: 'Some files were not copied',
      description: 'The files from this computer were not copied: Host is unreachable',
    });
  });
});

describe('seedFailure', () => {
  it('is quiet when everything arrived, and lists failures then skips', () => {
    expect(seedFailure({ copied: ['.env'], skipped: [], errors: [] })).toBeNull();
    expect(seedFailure(undefined)).toBeNull();
    expect(
      seedFailure({
        copied: [],
        skipped: ['node_modules/'],
        errors: [{ path: '.env', message: 'The file arrived damaged' }],
      }),
    ).toBe('.env - The file arrived damaged\nnode_modules/ - left out');
  });
});
