import { describe, expect, it } from 'vitest';
import { archivedAtOnInsert, archivedAtOnUpdate } from './archive-stamp';

describe('archivedAtOnUpdate', () => {
  it('stamps when a write puts the session into the archive', () => {
    expect(archivedAtOnUpdate({ status: 'archived' })).toBe('stamp');
  });

  it('clears when a write takes it out - a manual unarchive or a revive', () => {
    expect(archivedAtOnUpdate({ status: 'idle' })).toBe('clear');
    expect(archivedAtOnUpdate({ status: 'active' })).toBe('clear');
  });

  it('leaves the stamp alone when the status is not part of the patch', () => {
    // A rename or reorder of an archived session must not reset its clock.
    expect(archivedAtOnUpdate({ label: 'renamed' })).toBe('keep');
    expect(archivedAtOnUpdate({})).toBe('keep');
  });
});

describe('archivedAtOnInsert', () => {
  const now = new Date('2026-09-25T12:00:00Z');

  it('is null for a session that is not archived, whatever it carries', () => {
    expect(archivedAtOnInsert({ status: 'idle' }, now)).toBeNull();
    expect(archivedAtOnInsert({ status: 'idle', archivedAt: new Date(0) }, now)).toBeNull();
  });

  it('keeps an imported archive date and stamps now without one', () => {
    const then = new Date('2026-08-01T00:00:00Z');
    expect(archivedAtOnInsert({ status: 'archived', archivedAt: then }, now)).toBe(then);
    expect(archivedAtOnInsert({ status: 'archived', archivedAt: null }, now)).toBe(now);
    expect(archivedAtOnInsert({ status: 'archived' }, now)).toBe(now);
  });
});
