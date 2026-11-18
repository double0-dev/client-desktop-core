import { describe, expect, it, vi } from 'vitest';

import {
  compileQuery,
  findMatches,
  GhosttySearch,
  MAX_SEARCH_MATCHES,
  nextMatchIndex,
  type SearchHost,
} from '@renderer/lib/terminal/ghostty/search';

const ROWS = ['npm run build', 'Build failed: run again', 'rerun? RUN!'];

describe('compileQuery + findMatches', () => {
  it('matches literally and case-insensitively by default', () => {
    const p = compileQuery('run', {})!;
    expect(findMatches(ROWS, p)).toEqual([
      { row: 0, col: 4, length: 3 },
      { row: 1, col: 14, length: 3 },
      { row: 2, col: 2, length: 3 },
      { row: 2, col: 7, length: 3 },
    ]);
  });

  it('escapes regex characters unless regex is on', () => {
    expect(findMatches(ROWS, compileQuery('run?', {})!)).toEqual([{ row: 2, col: 2, length: 4 }]);
    expect(findMatches(ROWS, compileQuery('b[a-z]+d', { regex: true })!)).toHaveLength(2);
  });

  it('honours case and whole words', () => {
    expect(findMatches(ROWS, compileQuery('RUN', { caseSensitive: true })!)).toEqual([
      { row: 2, col: 7, length: 3 },
    ]);
    // "rerun" is not the word "run".
    expect(findMatches(ROWS, compileQuery('run', { wholeWord: true })!)).toHaveLength(3);
  });

  it('has no query for an empty or broken pattern', () => {
    expect(compileQuery('', {})).toBeNull();
    expect(compileQuery('(', { regex: true })).toBeNull();
  });

  it('skips empty matches instead of looping on them', () => {
    expect(findMatches(['aaa'], compileQuery('x*', { regex: true })!)).toEqual([]);
  });

  it('stops at the cap', () => {
    const rows = Array.from({ length: 2000 }, () => 'a');
    expect(findMatches(rows, compileQuery('a', {})!)).toHaveLength(MAX_SEARCH_MATCHES);
  });
});

describe('nextMatchIndex', () => {
  const m = [
    { row: 0, col: 4, length: 3 },
    { row: 1, col: 14, length: 3 },
    { row: 2, col: 2, length: 3 },
  ];

  it('starts at the first (forward) or last (backward) match', () => {
    expect(nextMatchIndex(m, null, 'next')).toBe(0);
    expect(nextMatchIndex(m, null, 'previous')).toBe(2);
  });

  it('steps past the current match and wraps around', () => {
    expect(nextMatchIndex(m, { row: 1, col: 14 }, 'next')).toBe(2);
    expect(nextMatchIndex(m, { row: 2, col: 2 }, 'next')).toBe(0);
    expect(nextMatchIndex(m, { row: 0, col: 4 }, 'previous')).toBe(2);
  });

  it('keeps the match a growing query still finds in place', () => {
    expect(nextMatchIndex(m, { row: 1, col: 14 }, 'next', true)).toBe(1);
  });

  it('has none without matches', () => {
    expect(nextMatchIndex([], null, 'next')).toBe(-1);
  });
});

const host = (over: Partial<SearchHost> = {}): SearchHost => ({
  rows: () => ROWS,
  reveal: vi.fn(),
  clearSelection: vi.fn(),
  highlight: vi.fn(),
  clearHighlights: vi.fn(),
  ...over,
});

const DECORATIONS = { matchBackground: '#203010', activeMatchBorder: '#7da82f' };

describe('GhosttySearch', () => {
  it('reveals each match in turn and reports index and count', () => {
    const reveal = vi.fn();
    const search = new GhosttySearch(host({ reveal }));
    const results = vi.fn();
    search.onDidChangeResults(results);
    expect(search.findNext('build')).toBe(true);
    expect(search.findNext('build')).toBe(true);
    expect(reveal.mock.calls.map(([match]) => match.row)).toEqual([0, 1]);
    expect(results).toHaveBeenLastCalledWith({ resultIndex: 1, resultCount: 2 });
  });

  it('clears the selection when nothing matches', () => {
    const clearSelection = vi.fn();
    const search = new GhosttySearch(host({ clearSelection }));
    const results = vi.fn();
    search.onDidChangeResults(results);
    expect(search.findNext('zzz')).toBe(false);
    expect(clearSelection).toHaveBeenCalled();
    expect(results).toHaveBeenCalledWith({ resultIndex: -1, resultCount: 0 });
  });

  it('hands every match to the host to highlight, the current one marked', () => {
    const h = host();
    const search = new GhosttySearch(h);
    search.findNext('run', { decorations: DECORATIONS });
    search.findNext('run', { decorations: DECORATIONS });
    expect(h.highlight).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ row: 2, col: 7, length: 3 }]),
      1,
      DECORATIONS,
    );
    expect(vi.mocked(h.highlight).mock.lastCall?.[0]).toHaveLength(4);
  });

  it('highlights nothing without decorations, as the addon does', () => {
    const h = host();
    new GhosttySearch(h).findNext('run');
    expect(h.highlight).not.toHaveBeenCalled();
    expect(h.clearHighlights).toHaveBeenCalled();
  });

  it('counts again after new output without moving to another match', () => {
    let rows = ROWS;
    const h = host({ rows: () => rows });
    const search = new GhosttySearch(h);
    const results = vi.fn();
    search.onDidChangeResults(results);
    search.findNext('build', { decorations: DECORATIONS });
    search.findNext('build', { decorations: DECORATIONS }); // row 1
    rows = [...ROWS, 'build ok'];
    search.refresh();
    expect(results).toHaveBeenLastCalledWith({ resultIndex: 1, resultCount: 3 });
    // Revealing scrolls the view: a refresh must not.
    expect(h.reveal).toHaveBeenCalledTimes(2);
  });

  it('stops counting once the highlights are cleared', () => {
    const h = host();
    const search = new GhosttySearch(h);
    const results = vi.fn();
    search.onDidChangeResults(results);
    search.findNext('build', { decorations: DECORATIONS });
    search.clearDecorations();
    expect(search.active).toBe(false);
    results.mockClear();
    search.refresh();
    expect(results).not.toHaveBeenCalled();
    expect(h.clearHighlights).toHaveBeenCalled();
  });
});
