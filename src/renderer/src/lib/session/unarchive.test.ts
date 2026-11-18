import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unarchiveSession } from '@renderer/lib/session/unarchive';

const { collection } = vi.hoisted(() => {
  const rows = new Map<string, { id: string; status: string }>();
  return {
    collection: {
      rows,
      get: (id: string) => rows.get(id),
      update: vi.fn((id: string, mutate: (draft: { status: string }) => void) => {
        const row = rows.get(id);
        if (row) mutate(row);
      }),
    },
  };
});

vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: collection }));

beforeEach(() => {
  collection.rows.clear();
  collection.update.mockClear();
});

describe('unarchiveSession', () => {
  it('moves an archived session back to idle', () => {
    collection.rows.set('s1', { id: 's1', status: 'archived' });
    expect(unarchiveSession('s1')).toBe(true);
    expect(collection.rows.get('s1')?.status).toBe('idle');
  });

  it.each(['idle', 'active', 'needs-input'])('leaves a %s session untouched', (status) => {
    collection.rows.set('s1', { id: 's1', status });
    expect(unarchiveSession('s1')).toBe(false);
    expect(collection.rows.get('s1')?.status).toBe(status);
    expect(collection.update).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown session', () => {
    expect(unarchiveSession('missing')).toBe(false);
    expect(collection.update).not.toHaveBeenCalled();
  });
});
