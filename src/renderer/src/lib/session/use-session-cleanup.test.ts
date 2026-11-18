import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@renderer/lib/collections';
import { stubApi } from '@renderer/test-support';

/**
 * The session-cleanup sweep runs in exactly one window: the one main grants
 * the lease to. The regression this guards: a project window and the main
 * window both sweeping, each deleting the same expired session's worktree.
 */

const update = vi.fn();
const deleteExpiredSession = vi.fn(async () => {});
// Project rows by id (a remote project names its host) and each host's state.
const projects = new Map<string, { hostId: string | null }>();
const hostStates = new Map<string, string>();
vi.mock('@renderer/lib/collections', () => ({
  agentSessionsCollection: { update: (...args: unknown[]) => update(...(args as [])) },
  projectsCollection: { get: (id: string) => projects.get(id) },
}));
vi.mock('@renderer/lib/hosts/host-status', () => ({
  getHostStatus: (id: string | null) =>
    id && hostStates.has(id) ? { state: hostStates.get(id) } : null,
}));
vi.mock('@renderer/lib/session/auto-delete', async (importOriginal) => ({
  mayDeleteOnHost: (await importOriginal<typeof import('./auto-delete')>()).mayDeleteOnHost,
  deleteExpiredSession: (...args: unknown[]) => deleteExpiredSession(...(args as [])),
}));
vi.mock('@renderer/lib/settings/session-cleanup-settings', () => ({
  getSessionCleanupSettings: () => ({
    autoArchive: true,
    archiveAfter: { amount: 1, unit: 'days' },
    autoDelete: true,
    deleteAfter: { amount: 1, unit: 'days' },
    removeWorktree: true,
  }),
  subscribeSessionCleanupSettings: () => () => {},
  durationMs: () => 24 * 60 * 60 * 1000,
}));

const DAY = 24 * 60 * 60 * 1000;
const old = new Date(Date.now() - 3 * DAY);
const session = (over: Partial<AgentSession>): AgentSession =>
  ({
    id: 'id',
    projectId: 'project-production-pipeline',
    status: 'idle',
    updatedAt: old,
    archivedAt: null,
    ...over,
  }) as AgentSession;
const stale = session({ id: 'stale' });
const expired = session({ id: 'expired', status: 'archived', archivedAt: old });

async function mountSweep(
  sessions: AgentSession[] = [stale, expired],
  external: string[] = [],
  active: string | null = null,
) {
  const { useSessionCleanupSweep } = await import('@renderer/lib/session/use-session-cleanup');
  const hook = renderHook(() =>
    useSessionCleanupSweep({
      ready: true,
      sessionsRef: { current: sessions },
      activeSessionIdRef: { current: active },
      externalIdsRef: { current: external },
    }),
  );
  await act(async () => {});
  return hook;
}

describe('the session-cleanup sweep lease', () => {
  beforeEach(() => {
    vi.resetModules();
    update.mockClear();
    deleteExpiredSession.mockClear();
    projects.clear();
    hostStates.clear();
  });
  afterEach(async () => {
    cleanup();
    const { setProjectScope } = await import('@renderer/lib/workspace/project-scope');
    setProjectScope(null);
  });

  it('sweeps in the window main grants the lease to', async () => {
    stubApi({ session: { sweepLease: vi.fn(async () => true) } });
    await mountSweep();
    expect(update).toHaveBeenCalledWith('stale', expect.any(Function));
    expect(deleteExpiredSession).toHaveBeenCalledWith(expired, true);
  });

  it('never sweeps in a window refused the lease', async () => {
    const sweepLease = vi.fn(async () => false);
    stubApi({ session: { sweepLease } });
    await mountSweep();
    expect(sweepLease).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deleteExpiredSession).not.toHaveBeenCalled();
  });

  it('does not even ask in a project window', async () => {
    const { setProjectScope } = await import('@renderer/lib/workspace/project-scope');
    setProjectScope({
      projectId: 'project-production-pipeline',
      projectName: 'production-pipeline',
    });
    const sweepLease = vi.fn(async () => true);
    stubApi({ session: { sweepLease } });
    await mountSweep();
    expect(sweepLease).not.toHaveBeenCalled();
    expect(deleteExpiredSession).not.toHaveBeenCalled();
  });

  it('sweeps alone when there is no bridge to ask (one window)', async () => {
    stubApi({ session: {} });
    await mountSweep();
    expect(deleteExpiredSession).toHaveBeenCalledTimes(1);
  });

  it('leaves sessions living in another window, and the one on screen, alone', async () => {
    // A session in a project window is on screen there; the archived one the
    // user is looking at here must not vanish under them either.
    stubApi({ session: { sweepLease: vi.fn(async () => true) } });
    await mountSweep(
      [stale, expired, session({ id: 'shown', status: 'archived', archivedAt: old })],
      ['stale', 'expired'],
      'shown',
    );
    expect(update).not.toHaveBeenCalled();
    expect(deleteExpiredSession).not.toHaveBeenCalled();
  });
});

// Remote sessions (spec 15): deleting a remote session removes its worktree on
// the host, so it waits for the host; archiving needs no host.
describe('the sweep and remote hosts', () => {
  beforeEach(() => {
    vi.resetModules();
    update.mockClear();
    deleteExpiredSession.mockClear();
    projects.clear();
    hostStates.clear();
    projects.set('project-acme', { hostId: 'build-box' });
  });
  afterEach(() => cleanup());

  const remoteStale = session({ id: 'stale', projectId: 'project-acme' });
  const remoteExpired = session({
    id: 'expired',
    projectId: 'project-acme',
    status: 'archived',
    archivedAt: old,
  });

  it('archives but never deletes while the host is unreachable', async () => {
    hostStates.set('build-box', 'unreachable');
    stubApi({ session: { sweepLease: vi.fn(async () => true) } });
    await mountSweep([remoteStale, remoteExpired]);
    expect(update).toHaveBeenCalledWith('stale', expect.any(Function));
    expect(deleteExpiredSession).not.toHaveBeenCalled();
  });

  it('deletes once the host is connected', async () => {
    hostStates.set('build-box', 'connected');
    stubApi({ session: { sweepLease: vi.fn(async () => true) } });
    await mountSweep([remoteStale, remoteExpired]);
    expect(deleteExpiredSession).toHaveBeenCalledWith(remoteExpired, true);
  });
});
