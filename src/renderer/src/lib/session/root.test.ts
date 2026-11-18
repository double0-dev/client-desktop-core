import { describe, expect, it } from 'vitest';
import { describeRoot, reRootInWorktree } from '@renderer/lib/session/root';

const PROJECT = '/Users/emmaw/code/production-pipeline';

describe('describeRoot', () => {
  it('reads as the project itself when nothing is picked', () => {
    expect(describeRoot(null, PROJECT)).toEqual({
      prefix: '',
      leaf: 'production-pipeline',
      isDefault: true,
    });
  });

  it('treats the project folder itself as the default, not a custom root', () => {
    // Picking the root row in the folder picker stores the project path on some
    // paths and null on others; both must render (and behave) identically.
    expect(describeRoot(PROJECT, PROJECT).isDefault).toBe(true);
  });

  it('splits a subfolder into a project prefix and the relative remainder', () => {
    expect(describeRoot(`${PROJECT}/api/src`, PROJECT)).toEqual({
      prefix: 'production-pipeline/',
      leaf: 'api/src',
      isDefault: false,
    });
  });

  it('keeps a folder outside the project identifiable instead of showing a bare leaf', () => {
    expect(describeRoot('/Users/emmaw/scratch/spike', PROJECT)).toEqual({
      prefix: '/Users/emmaw/scratch/',
      leaf: 'spike',
      isDefault: false,
    });
  });

  it('ignores trailing slashes on either side', () => {
    // Project paths arrive from a directory picker, which may or may not
    // include the trailing slash - a mismatch must not read as a custom root.
    expect(describeRoot(`${PROJECT}/`, `${PROJECT}`).isDefault).toBe(true);
    expect(describeRoot(`${PROJECT}/api/`, `${PROJECT}/`)).toEqual({
      prefix: 'production-pipeline/',
      leaf: 'api',
      isDefault: false,
    });
  });

  it('survives a project with no path at all', () => {
    expect(describeRoot(null, null)).toEqual({ prefix: '', leaf: '', isDefault: true });
  });
});

describe('reRootInWorktree', () => {
  const REPO = `${PROJECT}/api`;
  const WORKTREE = `${REPO}/.worktree/fix-auth`;

  it('drops to the worktree root when the picked folder IS the repo', () => {
    // null means "no explicit root", which the launcher resolves to the
    // worktree - storing the pre-worktree path would point at the main checkout.
    expect(reRootInWorktree(REPO, REPO, WORKTREE)).toBeNull();
  });

  it('maps a folder inside the repo to the same subpath inside the worktree', () => {
    expect(reRootInWorktree(`${REPO}/src/auth`, REPO, WORKTREE)).toBe(`${WORKTREE}/src/auth`);
  });

  it('leaves a folder outside the repo alone', () => {
    const outside = `${PROJECT}/web/src`;
    expect(reRootInWorktree(outside, REPO, WORKTREE)).toBe(outside);
  });

  it('does not map a sibling whose name merely starts with the repo path', () => {
    // `<project>/api-docs` shares a prefix with `<project>/api` but is a
    // different folder - a naive startsWith would splice it into the worktree.
    const sibling = `${PROJECT}/api-docs`;
    expect(reRootInWorktree(sibling, REPO, WORKTREE)).toBe(sibling);
  });

  it('passes through when there is no path or no repo', () => {
    expect(reRootInWorktree(null, REPO, WORKTREE)).toBeNull();
    expect(reRootInWorktree(`${REPO}/src`, null, WORKTREE)).toBe(`${REPO}/src`);
  });

  it('maps a Windows subfolder into the worktree', () => {
    // The folder picker answers `C:\…`; a `/`-only check left the session in
    // the main checkout while its worktree sat unused.
    const repo = 'C:\\Users\\emmaw\\acme\\api';
    const worktree = 'C:\\Users\\emmaw\\acme\\api\\.worktree\\fix-auth';
    expect(reRootInWorktree(`${repo}\\src\\auth`, repo, worktree)).toBe(`${worktree}\\src\\auth`);
    expect(reRootInWorktree(`${repo}\\`, repo, worktree)).toBeNull();
    expect(reRootInWorktree(`${repo}-docs`, repo, worktree)).toBe(`${repo}-docs`);
  });
});

describe('describeRoot on Windows', () => {
  it('shows a subfolder relative to a backslashed project', () => {
    expect(describeRoot('C:\\Users\\emmaw\\acme\\web', 'C:\\Users\\emmaw\\acme')).toEqual({
      prefix: 'acme/',
      leaf: 'web',
      isDefault: false,
    });
    expect(describeRoot('C:\\Users\\emmaw\\acme\\', 'C:\\Users\\emmaw\\acme').isDefault).toBe(true);
  });
});
