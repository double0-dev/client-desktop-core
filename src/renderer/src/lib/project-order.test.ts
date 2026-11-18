import { describe, expect, it } from 'vitest';
import { projectDropSortOrder, sortProjects } from '@renderer/lib/project-order';

type Row = { id: string; pinned?: boolean; sortOrder: number; createdAt: Date };

const row = (id: string, sortOrder: number, createdAt = new Date(0)): Row => ({
  id,
  sortOrder,
  createdAt,
});

describe('sortProjects', () => {
  it('orders by ascending sortOrder alone - a stale pin no longer outranks it', () => {
    // Pinning is gone: a row still carrying pinned: true sorts by its order.
    const list = [row('a', 2), { ...row('b', 3), pinned: true }, row('c', 1)];
    expect(sortProjects(list).map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('breaks legacy sortOrder ties newest-first', () => {
    const list = [row('old', 0, new Date('2026-01-01')), row('new', 0, new Date('2026-02-01'))];
    expect(sortProjects(list).map((p) => p.id)).toEqual(['new', 'old']);
  });

  it('does not mutate its input', () => {
    const list = [row('a', 2), row('b', 1)];
    sortProjects(list);
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('projectDropSortOrder', () => {
  const sorted = [row('a', 10), row('b', 20), row('c', 30), row('d', 40)];

  it('drops between two neighbours at their midpoint', () => {
    // Move a below b: target gap between b and c.
    expect(projectDropSortOrder(sorted, 'a', 2)).toBe(25);
    // Move d above b: target gap between a and b.
    expect(projectDropSortOrder(sorted, 'd', 1)).toBe(15);
  });

  it('drops at the ends just beyond the outermost neighbour', () => {
    expect(projectDropSortOrder(sorted, 'c', 0)).toBe(9);
    expect(projectDropSortOrder(sorted, 'b', 4)).toBe(41);
  });

  it('returns null for a drop back into its own slot', () => {
    expect(projectDropSortOrder(sorted, 'b', 1)).toBeNull();
    expect(projectDropSortOrder(sorted, 'b', 2)).toBeNull();
  });

  it('returns null for an unknown id or a single-item list', () => {
    expect(projectDropSortOrder(sorted, 'nope', 0)).toBeNull();
    expect(projectDropSortOrder([row('only', 10)], 'only', 0)).toBeNull();
  });

  it('takes its neighbours from the whole list, whatever an old pin says', () => {
    const mixed = [{ ...row('P1', 1), pinned: true }, row('u1', 10), row('u2', 20)];
    // u2 dropped above P1 lands above it - no pinned group holds P1 on top.
    expect(projectDropSortOrder(mixed, 'u2', 0)).toBe(0);
    expect(projectDropSortOrder(mixed, 'P1', 3)).toBe(21);
  });
});
