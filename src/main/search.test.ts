import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { SearchAnswer, SearchHosts } from './search';

/**
 * `search:listFiles` through the real ipcMain handler: this machine's
 * projects walked from real folders, a remote host's from its `fsIndex`
 * answers (a fake host manager) - local first, a host's list landing later,
 * its own budget, an unreachable host's last list, a changed tree re-walked.
 */

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
// fs.ts wires Electron at import; search only needs its hidden names.
vi.mock('./fs', () => ({ HIDDEN: new Set(['.DS_Store', '.git', 'node_modules', '.svn', '.hg']) }));

const { registerSearchIpc, changeTouchesIndex, HOST_TTL_MS, HOST_REWALK_MIN_MS } =
  await import('./search');

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const trusted = { senderFrame: mainFrame, sender: { mainFrame } };
const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };

const list = async (event: unknown = trusted): Promise<SearchAnswer> =>
  (await handlers.get('search:listFiles')!(event)) as SearchAnswer;

let dir: string;
let dispose: () => void;
let clock: number;

const HOST_ROOT = '/home/emmaw/src/acme';

type Rows = Array<{ id: string; name: string; path: string | null; hostId: string | null }>;

function fakeHosts() {
  const treeListeners = new Set<(hostId: string, paths: string[]) => void>();
  const state = { value: 'index' as 'index' | 'old' | 'down' };
  const walks: Array<{ root: string; max: number }> = [];
  let answers: Record<string, unknown> = {
    [HOST_ROOT]: { files: ['README.md', 'src/app.ts'], truncated: false },
  };
  let gate: Promise<void> = Promise.resolve();
  const hosts: SearchHosts = {
    state: () => state.value,
    index: async (_hostId, root, max) => {
      walks.push({ root, max });
      await gate;
      if (state.value === 'down') throw Object.assign(new Error('down'), { code: 'EHOSTDOWN' });
      return answers[root] ?? { err: { message: 'gone', code: 'ENOENT' } };
    },
    onTreeChange: (l) => {
      treeListeners.add(l);
      return () => treeListeners.delete(l);
    },
  };
  return {
    hosts,
    state,
    walks,
    setAnswers: (a: Record<string, unknown>) => {
      answers = a;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = Promise.resolve();
        release();
      };
    },
    change: (paths: string[]) => treeListeners.forEach((l) => l('build-box', paths)),
  };
}

function register(rows: Rows, host?: ReturnType<typeof fakeHosts>, broadcast = vi.fn()) {
  dispose = registerSearchIpc({
    projects: async () => rows,
    hosts: host?.hosts,
    broadcast,
    now: () => clock,
  });
  return broadcast;
}

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), 'double0-search-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), '');
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '');
});

afterEach(() => {
  dispose?.();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const LOCAL = (): Rows => [{ id: 'p-local', name: 'web', path: dir, hostId: null }];
const REMOTE: Rows = [{ id: 'p-remote', name: 'acme', path: HOST_ROOT, hostId: 'build-box' }];

describe('search:listFiles', () => {
  it('lists this machine’s project files as before, with no host', async () => {
    register(LOCAL());
    const res = await list();
    expect(res).toEqual({
      files: [
        {
          path: join(dir, 'src', 'main.ts'),
          name: 'main.ts',
          projectId: 'p-local',
          projectName: 'web',
          hostId: null,
        },
      ],
      pending: [],
      unreachable: [],
    });
  });

  it('refuses an untrusted sender', async () => {
    register(LOCAL());
    expect(await list(untrusted)).toEqual({ error: 'Untrusted sender' });
  });

  it('answers the local files at once and a host’s once its walk lands, then pushes', async () => {
    const host = fakeHosts();
    const release = host.hold();
    const broadcast = register([...LOCAL(), ...REMOTE], host);
    const first = await list();
    expect(first.files.map((f) => f.name)).toEqual(['main.ts']);
    expect(first.pending).toEqual(['build-box']);
    release();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    const second = await list();
    expect(second.pending).toEqual([]);
    expect(second.files.filter((f) => f.hostId === 'build-box')).toEqual([
      {
        path: `${HOST_ROOT}/README.md`,
        name: 'README.md',
        projectId: 'p-remote',
        projectName: 'acme',
        hostId: 'build-box',
      },
      {
        path: `${HOST_ROOT}/src/app.ts`,
        name: 'app.ts',
        projectId: 'p-remote',
        projectName: 'acme',
        hostId: 'build-box',
      },
    ]);
    // Fresh: no second walk within the TTL.
    expect(host.walks).toHaveLength(1);
  });

  it('gives each host its own budget, shared by its projects', async () => {
    const host = fakeHosts();
    host.setAnswers({
      '/srv/a': { files: ['a.txt'], truncated: false },
      '/srv/b': { files: ['b.txt'], truncated: false },
    });
    const broadcast = register(
      [
        { id: 'a', name: 'a', path: '/srv/a', hostId: 'build-box' },
        { id: 'b', name: 'b', path: '/srv/b', hostId: 'build-box' },
      ],
      host,
    );
    await list();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    expect(host.walks).toEqual([
      { root: '/srv/a', max: 20_000 },
      { root: '/srv/b', max: 19_999 },
    ]);
  });

  it('drops a path the host should never have named', async () => {
    const host = fakeHosts();
    host.setAnswers({ [HOST_ROOT]: { files: ['ok.ts', '../../etc/passwd', '/etc/x', 5] } });
    const broadcast = register(REMOTE, host);
    await list();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    expect((await list()).files.map((f) => f.path)).toEqual([`${HOST_ROOT}/ok.ts`]);
  });

  it('keeps an unreachable host’s last list, marked stale, and says so', async () => {
    const host = fakeHosts();
    const broadcast = register(REMOTE, host);
    await list();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    host.state.value = 'down';
    const res = await list();
    expect(res.unreachable).toEqual(['build-box']);
    expect(res.pending).toEqual([]);
    expect(res.files.every((f) => f.stale === true)).toBe(true);
    expect(res.files).toHaveLength(2);
  });

  it('leaves a host whose daemon predates the walk unindexed (the MVP behaviour)', async () => {
    const host = fakeHosts();
    host.state.value = 'old';
    register([...LOCAL(), ...REMOTE], host);
    const res = await list();
    expect(res).toMatchObject({ pending: [], unreachable: [] });
    expect(host.walks).toEqual([]);
  });

  it('re-walks after the TTL, and after a change in a project (never one in a worktree)', async () => {
    const host = fakeHosts();
    const broadcast = register(REMOTE, host);
    await list();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    // A session worktree under the project changed: not this index.
    host.change([`${HOST_ROOT}/.worktree/fix-login/src/app.ts`, '/somewhere/else']);
    clock += HOST_REWALK_MIN_MS + 1;
    expect((await list()).pending).toEqual([]);
    // A new file in the project: walked again (no sooner than the minimum).
    host.change([`${HOST_ROOT}/src/new.ts`]);
    expect((await list()).pending).toEqual(['build-box']);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
    clock += HOST_TTL_MS + 1;
    expect((await list()).pending).toEqual(['build-box']);
    await vi.waitFor(() => expect(host.walks).toHaveLength(3));
  });

  it('keeps the last list when the host goes away mid-walk', async () => {
    const host = fakeHosts();
    const broadcast = register(REMOTE, host);
    await list();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    clock += HOST_TTL_MS + 1;
    const release = host.hold();
    await list();
    host.state.value = 'down';
    release();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
    const res = await list();
    expect(res.files.map((f) => f.name)).toEqual(['README.md', 'app.ts']);
  });
});

describe('changeTouchesIndex', () => {
  it('counts a change in the project and not in what the walk skips', () => {
    expect(changeTouchesIndex('/r', '/r')).toBe(true);
    expect(changeTouchesIndex('/r', '/r/src/a.ts')).toBe(true);
    expect(changeTouchesIndex('/r', '/r/.git/index')).toBe(false);
    expect(changeTouchesIndex('/r', '/r/node_modules/x/y.js')).toBe(false);
    expect(changeTouchesIndex('/r', '/r/.worktree/s/a.ts')).toBe(false);
    expect(changeTouchesIndex('/r', '/rx/a.ts')).toBe(false);
  });
});
