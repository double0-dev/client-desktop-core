import { describe, expect, it } from 'vitest';
import { activeWorktree, worktreeFolderNames } from '@renderer/lib/git/worktree';

const PROJECT = '/Users/emmaw/code/production-pipeline';
const WORKTREE = `${PROJECT}/.worktree/fix-auth`;
const TREES = [{ path: PROJECT }, { path: WORKTREE }];

describe('activeWorktree', () => {
  it('matches the checkout the root IS', () => {
    expect(activeWorktree(TREES, PROJECT)).toBe(PROJECT);
    expect(activeWorktree(TREES, WORKTREE)).toBe(WORKTREE);
  });

  it('prefers the innermost checkout when they nest', () => {
    // `.worktree/fix-auth` lives inside the main checkout, so both contain it.
    // A first-match scan would mark the main row for every isolated worktree -
    // i.e. the marker would always point at the wrong row.
    expect(activeWorktree(TREES, WORKTREE)).toBe(WORKTREE);
    expect(activeWorktree([...TREES].reverse(), WORKTREE)).toBe(WORKTREE);
  });

  it('matches a session rooted in a subfolder of a checkout', () => {
    // A project of several independent repos roots its sessions at `<repo>/api`;
    // the checkout is still the one containing it.
    expect(activeWorktree(TREES, `${PROJECT}/api/src`)).toBe(PROJECT);
    expect(activeWorktree(TREES, `${WORKTREE}/api`)).toBe(WORKTREE);
  });

  it('ignores a sibling whose path merely shares a prefix', () => {
    // `production-pipeline-old` starts with `production-pipeline` as a string
    // but is a different folder; only a whole path segment counts.
    expect(activeWorktree(TREES, `${PROJECT}-old`)).toBeNull();
  });

  it('tolerates trailing slashes on either side', () => {
    expect(activeWorktree([{ path: `${PROJECT}/` }], PROJECT)).toBe(`${PROJECT}/`);
    expect(activeWorktree(TREES, `${WORKTREE}/`)).toBe(WORKTREE);
  });

  it('has nothing to mark without a root, or outside every checkout', () => {
    expect(activeWorktree(TREES, null)).toBeNull();
    expect(activeWorktree(TREES, '/tmp/elsewhere')).toBeNull();
    expect(activeWorktree([], PROJECT)).toBeNull();
  });

  it('marks the worktree holding a Windows session folder', () => {
    const main = 'C:\\Users\\emmaw\\acme';
    const fix = 'C:\\Users\\emmaw\\acme\\.worktree\\fix-auth';
    const trees = [{ path: main }, { path: fix }];
    expect(activeWorktree(trees, `${fix}\\src`)).toBe(fix);
    expect(activeWorktree(trees, main)).toBe(main);
    expect(activeWorktree(trees, 'C:\\Users\\emmaw\\acme-docs')).toBeNull();
  });
});

describe('worktreeFolderNames', () => {
  it('lists the folders under the repo .worktree, never the main checkout', () => {
    expect(worktreeFolderNames(TREES, PROJECT)).toEqual(['fix-auth']);
    expect(worktreeFolderNames(TREES, `${PROJECT}/`)).toEqual(['fix-auth']);
  });

  it('finds Windows worktrees, native or mixed', () => {
    // A `/`-only prefix matched none on Windows, so a folder left behind by a
    // deleted branch was offered again and `git worktree add` refused it.
    const repo = 'C:\\Users\\emmaw\\acme';
    const trees = [
      { path: repo },
      { path: `${repo}\\.worktree\\fix-auth` },
      { path: `${repo}/.worktree/old-tree` },
      { path: `${repo}\\.worktree-notes` },
    ];
    expect(worktreeFolderNames(trees, repo)).toEqual(['fix-auth', 'old-tree']);
  });
});
