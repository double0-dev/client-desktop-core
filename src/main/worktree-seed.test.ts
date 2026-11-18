import { describe, expect, it } from 'vitest';
import {
  buildOutputOf,
  crossPlatform,
  lockedReason,
  partitionLocalSeedPaths,
  partitionSeedPaths,
} from './worktree-seed';

describe('lockedReason', () => {
  it('locks the worktree folder and everything under it', () => {
    expect(lockedReason('.worktree/')).toBe('never copied');
    expect(lockedReason('.worktree')).toBe('never copied');
    expect(lockedReason('.worktree/fix-auth/.env')).toBe('never copied');
  });

  it("locks the app's own folder", () => {
    expect(lockedReason('.double0/')).toBe('app folder');
    expect(lockedReason('.double0/task-images/01-shot.png')).toBe('app folder');
  });

  it('leaves ordinary ignored paths alone, including look-alikes', () => {
    expect(lockedReason('.env')).toBeNull();
    expect(lockedReason('node_modules/')).toBeNull();
    expect(lockedReason('.worktrees/')).toBeNull();
    expect(lockedReason('src/.worktree-notes.md')).toBeNull();
  });
});

describe('partitionSeedPaths', () => {
  it('keeps repo-relative files and folders in order, without duplicates', () => {
    expect(partitionSeedPaths(['.env', 'dist/', '.env', 'packages/api/.env.local'])).toEqual({
      paths: ['.env', 'dist/', 'packages/api/.env.local'],
      rejected: [],
    });
  });

  it('refuses anything that could leave the checkout', () => {
    const { paths, rejected } = partitionSeedPaths([
      '../outside',
      'a/../../b',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '.git/config',
      '.env',
    ]);
    expect(paths).toEqual(['.env']);
    expect(rejected).toEqual([
      '../outside',
      'a/../../b',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '.git/config',
    ]);
  });

  it('refuses locked folders and reports them', () => {
    expect(partitionSeedPaths(['.worktree/', '.double0/', 'coverage/'])).toEqual({
      paths: ['coverage/'],
      rejected: ['.worktree/', '.double0/'],
    });
  });

  it('drops non-strings, blanks and a non-array payload', () => {
    expect(partitionSeedPaths(['', '  ', 42, null, { path: '.env' }])).toEqual({
      paths: [],
      rejected: [],
    });
    expect(partitionSeedPaths('.env')).toEqual({ paths: [], rejected: [] });
    expect(partitionSeedPaths(undefined)).toEqual({ paths: [], rejected: [] });
  });
});

describe('seeding from this computer (plan 29 › M8)', () => {
  it('names build output by whole segments, at any depth', () => {
    expect(buildOutputOf('node_modules/')).toBe('node_modules');
    expect(buildOutputOf('packages/web/node_modules/')).toBe('node_modules');
    expect(buildOutputOf('vendor/bundle/')).toBe('vendor/bundle');
    expect(buildOutputOf('apps/api/vendor/bundle/ruby')).toBe('vendor/bundle');
    expect(buildOutputOf('target\\debug')).toBe('target');
    // Look-alikes are not build output.
    expect(buildOutputOf('distance/')).toBeNull();
    expect(buildOutputOf('rebuild.log')).toBeNull();
    expect(buildOutputOf('vendor/')).toBeNull();
    expect(buildOutputOf('.env')).toBeNull();
  });

  it('counts an unknown host platform as different - the safe side', () => {
    expect(crossPlatform('darwin-arm64', 'linux-x64')).toBe(true);
    expect(crossPlatform('linux-x64', 'linux-arm64')).toBe(true);
    expect(crossPlatform('linux-x64', 'linux-x64')).toBe(false);
    expect(crossPlatform('linux-x64', null)).toBe(true);
  });

  // The renderer greys these out, but main must refuse them on its own: a
  // Mac's node_modules on a Linux host breaks every native module there.
  it('refuses build output across platforms, keeps it on the same one', () => {
    const ticked = ['.env', 'node_modules/', 'apps/web/.next/', 'config/master.key', '.venv/'];
    expect(partitionLocalSeedPaths(ticked, { crossOs: true })).toEqual({
      paths: ['.env', 'config/master.key'],
      rejected: [
        { path: 'node_modules/', reason: "node_modules is built for this computer's OS" },
        { path: 'apps/web/.next/', reason: ".next is built for this computer's OS" },
        { path: '.venv/', reason: ".venv is built for this computer's OS" },
      ],
    });
    expect(partitionLocalSeedPaths(ticked, { crossOs: false }).paths).toEqual(ticked);
  });

  it('keeps the worktree seed rules - escapes, the git dir and locked folders', () => {
    expect(
      partitionLocalSeedPaths(
        ['../x', '/etc/passwd', '.git/config', '.worktree/a/', '.double0/x', 7],
        {
          crossOs: false,
        },
      ),
    ).toEqual({
      paths: [],
      rejected: [
        { path: '../x', reason: 'outside the checkout' },
        { path: '/etc/passwd', reason: 'outside the checkout' },
        { path: '.git/config', reason: 'outside the checkout' },
        { path: '.worktree/a/', reason: 'never copied' },
        { path: '.double0/x', reason: 'app folder' },
      ],
    });
  });
});
