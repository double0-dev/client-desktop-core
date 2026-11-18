import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChildRepos } from './child-repos';
import {
  localRuntime,
  setLocalPathForTest,
  setRuntimeResolver,
  type HostRuntime,
} from './host-runtime';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'double0-child-repos-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A symlink to a file; on Windows without the symlink privilege, none. */
function linkFileIfAllowed(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'file');
  } catch (err) {
    if (process.platform !== 'win32' || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  }
}

const checkout = (name: string): void => {
  mkdirSync(join(dir, name, '.git'), { recursive: true });
};

describe('findChildRepos - the stacks of a folder-of-repos project', () => {
  it('lists the checkouts directly under the folder, sorted by name', async () => {
    checkout('web');
    checkout('api');
    mkdirSync(join(dir, 'notes')); // a plain folder is no repo
    expect(await findChildRepos(dir)).toEqual([
      { name: 'api', path: join(dir, 'api') },
      { name: 'web', path: join(dir, 'web') },
    ]);
  });

  it('counts a `.git` FILE too - a linked worktree or submodule checkout', async () => {
    mkdirSync(join(dir, 'mobile'));
    writeFileSync(join(dir, 'mobile', '.git'), 'gitdir: /elsewhere/.git/worktrees/mobile\n');
    expect(await findChildRepos(dir)).toEqual([{ name: 'mobile', path: join(dir, 'mobile') }]);
  });

  it('follows a symlinked stack, and ignores links to files or nowhere', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'double0-linked-'));
    try {
      mkdirSync(join(elsewhere, 'api', '.git'), { recursive: true });
      writeFileSync(join(elsewhere, 'notes.md'), '# notes\n');
      // Folder links as junctions: Windows makes those without the symlink
      // privilege. A link to a FILE needs it, so there it is left out unless
      // the machine allows it (Developer Mode).
      symlinkSync(join(elsewhere, 'api'), join(dir, 'api'), 'junction');
      linkFileIfAllowed(join(elsewhere, 'notes.md'), join(dir, 'notes'));
      symlinkSync(join(elsewhere, 'gone'), join(dir, 'dangling'), 'junction');
      expect(await findChildRepos(dir)).toEqual([{ name: 'api', path: join(dir, 'api') }]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('skips dot-folders and dependency trees', async () => {
    // `.worktree/<branch>` checkouts are sessions, not stacks of the project.
    checkout('.worktree');
    checkout('node_modules');
    checkout('api');
    expect((await findChildRepos(dir)).map((r) => r.name)).toEqual(['api']);
  });

  it('looks one level deep only', async () => {
    checkout(join('services', 'billing'));
    expect(await findChildRepos(dir)).toEqual([]);
  });

  it('answers empty for a folder that does not exist', async () => {
    expect(await findChildRepos(join(dir, 'missing'))).toEqual([]);
  });
});

describe('findChildRepos - a host folder on a Windows client', () => {
  it("joins the host's POSIX paths with POSIX rules, never this machine's", async () => {
    // The host's files, as its runtime would see them, under `/srv/acme`.
    const seen: string[] = [];
    const onHost = (p: string): string => {
      seen.push(p);
      if (!p.startsWith('/srv/acme')) throw new Error(`not a host path: ${p}`);
      return join(dir, p.slice('/srv/acme'.length));
    };
    const host: HostRuntime = {
      ...localRuntime,
      remote: { hostId: 'build-box' },
      fs: {
        ...localRuntime.fs,
        readdir: ((p: string, o: never) => localRuntime.fs.readdir(onHost(p), o)) as never,
        stat: ((p: string) => localRuntime.fs.stat(onHost(p))) as HostRuntime['fs']['stat'],
      },
    };
    checkout('api');
    const restoreResolver = setRuntimeResolver((p) =>
      p?.startsWith('/srv/') ? host : localRuntime,
    );
    const restoreLocal = setLocalPathForTest(nodePath.win32);
    try {
      expect(await findChildRepos('/srv/acme')).toEqual([{ name: 'api', path: '/srv/acme/api' }]);
      expect(seen).toContain('/srv/acme/api/.git');
    } finally {
      restoreLocal();
      restoreResolver();
    }
  });
});
