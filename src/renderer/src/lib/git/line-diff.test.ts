import { describe, expect, it } from 'vitest';
import { diffGutter, diffGutterDetailed } from '@renderer/lib/git/line-diff';

const lines = (...l: string[]): string => l.join('\n');

describe('diffGutter', () => {
  it('returns nothing for identical content', () => {
    expect(diffGutter('a\nb', 'a\nb')).toEqual([]);
  });

  it('marks appended lines as added', () => {
    expect(diffGutter(lines('a', 'b'), lines('a', 'b', 'c', 'd'))).toEqual([
      { type: 'added', fromLine: 3, toLine: 4 },
    ]);
  });

  it('marks inserted lines in the middle as added', () => {
    expect(diffGutter(lines('a', 'b', 'c'), lines('a', 'x', 'y', 'b', 'c'))).toEqual([
      { type: 'added', fromLine: 2, toLine: 3 },
    ]);
  });

  it('marks replaced lines as modified', () => {
    expect(diffGutter(lines('a', 'b', 'c'), lines('a', 'B', 'c'))).toEqual([
      { type: 'modified', fromLine: 2, toLine: 2 },
    ]);
  });

  it('marks an uneven replace (1 line → 3) as one modified block', () => {
    expect(diffGutter(lines('a', 'b', 'c'), lines('a', 'x', 'y', 'z', 'c'))).toEqual([
      { type: 'modified', fromLine: 2, toLine: 4 },
    ]);
  });

  it('marks pure deletions between lines', () => {
    expect(diffGutter(lines('a', 'b', 'c', 'd'), lines('a', 'd'))).toEqual([
      { type: 'deleted', afterLine: 1 },
    ]);
  });

  it('marks a deletion at the very top with afterLine 0', () => {
    expect(diffGutter(lines('a', 'b', 'c'), lines('b', 'c'))).toEqual([
      { type: 'deleted', afterLine: 0 },
    ]);
  });

  it('reports multiple separate runs', () => {
    expect(diffGutter(lines('a', 'b', 'c', 'd', 'e'), lines('a', 'B', 'c', 'e', 'f'))).toEqual([
      { type: 'modified', fromLine: 2, toLine: 2 },
      { type: 'deleted', afterLine: 3 },
      { type: 'added', fromLine: 5, toLine: 5 },
    ]);
  });

  it('treats an empty base (untracked-like) as all added', () => {
    expect(diffGutter('', lines('a', 'b'))).toEqual([{ type: 'modified', fromLine: 1, toLine: 2 }]);
  });

  it('survives a giant rewrite via the coarse fallback', () => {
    const base = Array.from({ length: 4000 }, (_, i) => `base ${i}`).join('\n');
    const current = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n');
    expect(diffGutter(base, current)).toEqual([{ type: 'modified', fromLine: 1, toLine: 4000 }]);
  });
});

describe('diffGutterDetailed', () => {
  it('carries empty base range for pure additions', () => {
    expect(diffGutterDetailed(lines('a', 'b'), lines('a', 'b', 'c', 'd'))).toEqual([
      { type: 'added', fromLine: 3, toLine: 4, baseFrom: 3, baseCount: 0 },
    ]);
  });

  it('carries the replaced base range for modifications', () => {
    expect(diffGutterDetailed(lines('a', 'b', 'c'), lines('a', 'x', 'y', 'z', 'c'))).toEqual([
      { type: 'modified', fromLine: 2, toLine: 4, baseFrom: 2, baseCount: 1 },
    ]);
  });

  it('carries the deleted base range for deletions', () => {
    expect(diffGutterDetailed(lines('a', 'b', 'c', 'd'), lines('a', 'd'))).toEqual([
      { type: 'deleted', afterLine: 1, baseFrom: 2, baseCount: 2 },
    ]);
  });

  it('tracks base offsets across multiple runs', () => {
    expect(
      diffGutterDetailed(lines('a', 'b', 'c', 'd', 'e'), lines('a', 'B', 'c', 'e', 'f')),
    ).toEqual([
      { type: 'modified', fromLine: 2, toLine: 2, baseFrom: 2, baseCount: 1 },
      { type: 'deleted', afterLine: 3, baseFrom: 4, baseCount: 1 },
      { type: 'added', fromLine: 5, toLine: 5, baseFrom: 6, baseCount: 0 },
    ]);
  });
});
