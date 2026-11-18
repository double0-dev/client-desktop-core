import { describe, expect, it } from 'vitest';
import {
  combinedStatusLetter,
  splitStatusFiles,
  statusLetter,
  type GitFileStatus,
} from '@renderer/lib/git/types';

/** Build a status entry the way parseStatus would. */
const file = (
  path: string,
  index: string,
  worktree: string,
  extra: Partial<GitFileStatus> = {},
): GitFileStatus => ({
  path,
  index,
  worktree,
  untracked: false,
  conflicted: false,
  ...extra,
});

const modifiedUnstaged = file('a.ts', ' ', 'M');
const modifiedStaged = file('b.ts', 'M', ' ');
const modifiedBoth = file('c.ts', 'M', 'M');
const addedStaged = file('d.ts', 'A', ' ');
const deletedUnstaged = file('e.ts', ' ', 'D');
const untracked = file('new.ts', ' ', '?', { untracked: true });
const conflicted = file('merge.ts', 'U', 'U', { conflicted: true });
const renamedStaged = file('to.ts', 'R', ' ', { origPath: 'from.ts' });

describe('splitStatusFiles', () => {
  it('puts worktree changes in unstaged and index changes in staged', () => {
    const { unstaged, staged } = splitStatusFiles([modifiedUnstaged, modifiedStaged]);
    expect(unstaged.map((f) => f.path)).toEqual(['a.ts']);
    expect(staged.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('lists a partially-staged file on BOTH sides', () => {
    // Staging some hunks of a file leaves the rest unstaged - the commit panel
    // shows it in both lists on purpose.
    const { unstaged, staged } = splitStatusFiles([modifiedBoth]);
    expect(unstaged.map((f) => f.path)).toEqual(['c.ts']);
    expect(staged.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('treats an untracked file as unstaged only', () => {
    const { unstaged, staged } = splitStatusFiles([untracked]);
    expect(unstaged.map((f) => f.path)).toEqual(['new.ts']);
    expect(staged).toEqual([]);
  });

  it('keeps a conflicted file out of the staged list', () => {
    // A conflict is resolved through the merge view, not committed from the
    // staged list.
    const { unstaged, staged } = splitStatusFiles([conflicted]);
    expect(unstaged.map((f) => f.path)).toEqual(['merge.ts']);
    expect(staged).toEqual([]);
  });

  it('lists a staged rename as staged', () => {
    const { unstaged, staged } = splitStatusFiles([renamedStaged]);
    expect(staged.map((f) => f.path)).toEqual(['to.ts']);
    expect(unstaged).toEqual([]);
  });

  it('handles a clean tree', () => {
    expect(splitStatusFiles([])).toEqual({ unstaged: [], staged: [] });
  });

  it('splits a realistic mixed tree', () => {
    const { unstaged, staged } = splitStatusFiles([
      modifiedUnstaged,
      modifiedStaged,
      modifiedBoth,
      addedStaged,
      deletedUnstaged,
      untracked,
      conflicted,
    ]);
    expect(unstaged.map((f) => f.path)).toEqual(['a.ts', 'c.ts', 'e.ts', 'new.ts', 'merge.ts']);
    expect(staged.map((f) => f.path)).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });
});

describe('statusLetter', () => {
  it('reads the index letter on the staged side and the worktree letter on the unstaged side', () => {
    expect(statusLetter(modifiedBoth, true)).toBe('M');
    expect(statusLetter(modifiedBoth, false)).toBe('M');
    expect(statusLetter(addedStaged, true)).toBe('A');
    expect(statusLetter(deletedUnstaged, false)).toBe('D');
  });

  it('shows a dot for the side with no change', () => {
    expect(statusLetter(modifiedUnstaged, true)).toBe('·');
    expect(statusLetter(modifiedStaged, false)).toBe('·');
  });

  it('marks a conflict on both sides', () => {
    expect(statusLetter(conflicted, true)).toBe('!');
    expect(statusLetter(conflicted, false)).toBe('!');
  });

  it('shows an untracked file as an addition, not a "?"', () => {
    expect(statusLetter(untracked, false)).toBe('A');
    expect(statusLetter(untracked, true)).toBe('A');
  });

  it('shows R for a staged rename', () => {
    expect(statusLetter(renamedStaged, true)).toBe('R');
  });
});

describe('combinedStatusLetter', () => {
  it('prefers the worktree state over the index', () => {
    expect(combinedStatusLetter(file('x.ts', 'A', 'M'))).toBe('M');
    expect(combinedStatusLetter(file('y.ts', 'M', 'D'))).toBe('D');
  });

  it('falls back to the index when the worktree is clean', () => {
    expect(combinedStatusLetter(modifiedStaged)).toBe('M');
    expect(combinedStatusLetter(addedStaged)).toBe('A');
    expect(combinedStatusLetter(renamedStaged)).toBe('R');
  });

  it('marks conflicts and untracked files', () => {
    expect(combinedStatusLetter(conflicted)).toBe('!');
    expect(combinedStatusLetter(untracked)).toBe('A');
  });
});
