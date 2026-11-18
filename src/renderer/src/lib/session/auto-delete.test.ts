import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@renderer/lib/collections';
import { stubApi } from '@renderer/test-support';

const { collection } = vi.hoisted(() => ({
  collection: { get: vi.fn(), delete: vi.fn() },
}));
vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: collection }));

import { deleteExpiredSession, mayDeleteOnHost } from './auto-delete';

const WORKTREE = '/repo/production-pipeline/.worktree/fix-auth-tokens';
const session = (worktreePath: string | null) =>
  ({ id: 's1', label: 'fix-auth-tokens', status: 'archived', worktreePath }) as AgentSession;

let worktreeRemove: ReturnType<typeof vi.fn>;

beforeEach(() => {
  collection.get.mockReset().mockReturnValue({ id: 's1' });
  collection.delete.mockReset();
  worktreeRemove = vi.fn(async () => ({ ok: true }));
  stubApi({ git: { worktreeRemove } });
});

describe('deleteExpiredSession', () => {
  it('removes a clean worktree without forcing, then the record', async () => {
    await deleteExpiredSession(session(WORKTREE), true);
    // Never `force`: nobody is there to confirm losing uncommitted work.
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/production-pipeline', WORKTREE, false);
    expect(collection.delete).toHaveBeenCalledWith('s1');
  });

  it('keeps a dirty worktree on disk and still drops the record', async () => {
    worktreeRemove.mockResolvedValueOnce({
      ok: false,
      error: 'contains modified or untracked files',
    });
    await deleteExpiredSession(session(WORKTREE), true);
    expect(worktreeRemove).toHaveBeenCalledTimes(1);
    expect(collection.delete).toHaveBeenCalledWith('s1');
  });

  it('leaves the worktree alone when the setting is off', async () => {
    await deleteExpiredSession(session(WORKTREE), false);
    expect(worktreeRemove).not.toHaveBeenCalled();
    expect(collection.delete).toHaveBeenCalledWith('s1');
  });

  it('does not delete a record that is already gone', async () => {
    collection.get.mockReturnValue(undefined);
    await deleteExpiredSession(session(null), true);
    expect(worktreeRemove).not.toHaveBeenCalled();
    expect(collection.delete).not.toHaveBeenCalled();
  });
});

describe('mayDeleteOnHost', () => {
  it('always allows a local session', () => {
    expect(mayDeleteOnHost(null, null)).toBe(true);
    expect(mayDeleteOnHost(undefined, 'unreachable')).toBe(true);
  });

  it('allows a remote one only while its host is connected', () => {
    expect(mayDeleteOnHost('build-box', 'connected')).toBe(true);
    for (const state of ['idle', 'connecting', 'installing', 'unreachable', 'needs-login', 'error'])
      expect(mayDeleteOnHost('build-box', state)).toBe(false);
    // A host this machine does not have (an imported database) has no status.
    expect(mayDeleteOnHost('build-box', null)).toBe(false);
  });
});
