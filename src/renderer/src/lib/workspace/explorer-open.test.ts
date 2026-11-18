import { describe, expect, it } from 'vitest';
import {
  MAX_EXPLORER_ENTRIES,
  decodeExplorerOpen,
  explorerKey,
  pruneExplorerOpen,
  setExplorerOpenFor,
} from './explorer-open';

describe('explorerKey', () => {
  it('keys a session by its id and the session-less view by its project', () => {
    expect(explorerKey('s1', null)).toBe('s1');
    expect(explorerKey(null, 'p1')).toBe('project:p1');
    expect(explorerKey(null, null)).toBeNull();
  });
});

describe('decodeExplorerOpen', () => {
  it('opens nothing for a fresh install or a corrupt entry', () => {
    expect(decodeExplorerOpen(null)).toEqual([]);
    expect(decodeExplorerOpen('{oops')).toEqual([]);
    expect(decodeExplorerOpen('"s1"')).toEqual([]);
  });

  it('keeps only non-empty string keys', () => {
    expect(decodeExplorerOpen('["s1", 3, "", null, "project:p1"]')).toEqual(['s1', 'project:p1']);
  });
});

describe('setExplorerOpenFor', () => {
  it('opens the explorer for one session without touching the others', () => {
    const open = setExplorerOpenFor(['s1'], 's2', true);
    expect(open).toEqual(['s1', 's2']);
    expect(setExplorerOpenFor(open, 's1', false)).toEqual(['s2']);
  });

  it('returns the same array when nothing changes, so no write happens', () => {
    const open = ['s1'];
    expect(setExplorerOpenFor(open, 's1', true)).toBe(open);
    expect(setExplorerOpenFor(open, 's2', false)).toBe(open);
  });

  it('drops the oldest entries past the cap', () => {
    const full = Array.from({ length: MAX_EXPLORER_ENTRIES }, (_, i) => `s${i}`);
    const next = setExplorerOpenFor(full, 'new', true);
    expect(next).toHaveLength(MAX_EXPLORER_ENTRIES);
    expect(next[0]).toBe('s1');
    expect(next[next.length - 1]).toBe('new');
  });
});

describe('pruneExplorerOpen', () => {
  it('forgets deleted sessions but keeps project keys', () => {
    expect(pruneExplorerOpen(['s1', 'gone', 'project:p1'], new Set(['s1']))).toEqual([
      's1',
      'project:p1',
    ]);
  });

  it('returns the same array when every session is still alive', () => {
    const open = ['s1', 'project:p1'];
    expect(pruneExplorerOpen(open, new Set(['s1']))).toBe(open);
  });
});
