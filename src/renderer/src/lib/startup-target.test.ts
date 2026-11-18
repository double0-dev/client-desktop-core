import { describe, expect, it } from 'vitest';
import {
  afterProjectDeleted,
  noProjectTarget,
  pickProjectSession,
  projectOpenTarget,
  startupTarget,
} from '@renderer/lib/startup-target';

const project = (id: string, over: Partial<{ sortOrder: number }> = {}) => ({
  id,
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const session = (
  id: string,
  projectId: string | null,
  over: Partial<{ status: string; sortOrder: number }> = {},
) => ({ id, projectId, status: 'idle', sortOrder: 0, ...over });

const none = () => null;

describe('pickProjectSession', () => {
  it('prefers the remembered session over the top one', () => {
    const sessions = [session('a', 'p', { sortOrder: 1 }), session('b', 'p', { sortOrder: 2 })];
    expect(pickProjectSession(sessions, 'b')?.id).toBe('b');
  });

  it('falls back to the top live session when the remembered one is gone', () => {
    // A stale localStorage entry (session deleted since) must not strand the
    // caller on "no session" while the project still has some.
    const sessions = [session('a', 'p', { sortOrder: 1 }), session('b', 'p', { sortOrder: 2 })];
    expect(pickProjectSession(sessions, 'deleted')?.id).toBe('a');
  });

  it('skips archived sessions unless they are all there is', () => {
    const archivedFirst = [
      session('a', 'p', { sortOrder: 1, status: 'archived' }),
      session('b', 'p', { sortOrder: 2 }),
    ];
    expect(pickProjectSession(archivedFirst, null)?.id).toBe('b');
    expect(pickProjectSession([archivedFirst[0]], null)?.id).toBe('a');
  });

  it('orders by sortOrder, not input order', () => {
    const sessions = [session('a', 'p', { sortOrder: 2 }), session('b', 'p', { sortOrder: 1 })];
    expect(pickProjectSession(sessions, null)?.id).toBe('b');
  });

  it('returns undefined for a project with no sessions', () => {
    expect(pickProjectSession([], 'anything')).toBeUndefined();
  });
});

describe('startupTarget', () => {
  it('opens a linked host session under the local project it is listed as', () => {
    // A host project made for p1 is no project of its own (lib/projects/linked.ts).
    const projects = [
      project('p1'),
      { ...project('h1', { sortOrder: -1 }), hostId: 'build-box', linkedProjectId: 'p1' },
    ];
    const sessions = [session('sH', 'h1')];
    expect(startupTarget(projects, sessions, 'p1', (id) => (id === 'p1' ? 'sH' : null))).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 'sH' },
    });
    // Remembered as the host project (before links existed): still p1's.
    expect(startupTarget(projects, sessions, 'h1', none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 'sH' },
    });
    // Nothing remembered: the pinned host project is no candidate, p1 is.
    expect(startupTarget(projects, [], null, none)).toEqual({
      to: '/workspace/$projectId',
      params: { projectId: 'p1' },
    });
  });

  it('lands on the no-project workspace when there is no project yet', () => {
    expect(startupTarget([], [], null, none)).toEqual({ to: '/workspace' });
  });

  it('opens the last project on the session last viewed there', () => {
    const projects = [project('p1'), project('p2')];
    const sessions = [session('s1', 'p1'), session('s2', 'p2', { sortOrder: 1 })];
    expect(startupTarget(projects, sessions, 'p2', (id) => (id === 'p2' ? 's2' : null))).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's2' },
    });
  });

  it('opens the top project when none was remembered', () => {
    const projects = [project('p1', { sortOrder: 1 }), project('p2')];
    const sessions = [session('s1', 'p1'), session('s2', 'p2')];
    expect(startupTarget(projects, sessions, null, none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's2' },
    });
  });

  it('ignores a remembered project that no longer exists', () => {
    // Deleting the project the app last opened must not strand startup - it
    // falls through to the top project like a first run would.
    const projects = [project('p1')];
    const sessions = [session('s1', 'p1')];
    expect(startupTarget(projects, sessions, 'deleted', none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
  });

  it("opens a project's session-less workspace when it has no sessions", () => {
    // The workspace chrome is still the right screen: its empty state is where
    // the first session gets created.
    const projects = [project('p1')];
    expect(startupTarget(projects, [session('s2', 'p2')], null, none)).toEqual({
      to: '/workspace/$projectId',
      params: { projectId: 'p1' },
    });
  });

  it('never opens a session belonging to another project', () => {
    const projects = [project('p1')];
    const sessions = [session('s2', 'p2'), session('sNull', null)];
    expect(startupTarget(projects, sessions, 'p1', () => 's2')).toEqual({
      to: '/workspace/$projectId',
      params: { projectId: 'p1' },
    });
  });
});

describe('projectOpenTarget', () => {
  it('opens the session last viewed in the project, else its top one', () => {
    const projects = [project('p1'), project('p2')];
    const sessions = [
      session('s1', 'p1', { sortOrder: 1 }),
      session('s2', 'p1', { sortOrder: 2 }),
      session('s3', 'p2'),
    ];
    expect(projectOpenTarget('p1', projects, sessions, () => 's2')).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's2' },
    });
    expect(projectOpenTarget('p1', projects, sessions, none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
  });

  it("counts a linked host project's sessions as the project's own", () => {
    const projects = [project('p1'), { ...project('h1'), hostId: 'host-1', linkedProjectId: 'p1' }];
    expect(projectOpenTarget('p1', projects, [session('sh', 'h1')], none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 'sh' },
    });
  });

  it('opens the session-less workspace of a project with no sessions', () => {
    expect(projectOpenTarget('p1', [project('p1')], [session('s2', 'p2')], none)).toEqual({
      to: '/workspace/$projectId',
      params: { projectId: 'p1' },
    });
  });
});

describe('noProjectTarget', () => {
  it('stays on the no-project workspace while there is no project', () => {
    // Navigating to itself would loop.
    expect(noProjectTarget(null, [], [], null, none)).toBeNull();
  });

  it('heals into the first project once one exists', () => {
    // A project created (or synced in) while the empty state shows.
    expect(noProjectTarget(null, [project('p1')], [], null, none)).toEqual({
      to: '/workspace/$projectId',
      params: { projectId: 'p1' },
    });
  });

  it('leaves the session-less view of a deleted project', () => {
    // Its row is gone: another project if any, else the no-project workspace.
    expect(noProjectTarget('gone', [project('p1')], [session('s1', 'p1')], null, none)).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
    expect(noProjectTarget('gone', [], [], null, none)).toEqual({ to: '/workspace' });
  });
});

describe('afterProjectDeleted', () => {
  it('opens the next project, never the deleted row still in the list', () => {
    // The deleted project sorts first and is the remembered one: without
    // leaving it out, the window would navigate straight back to it.
    const projects = [project('gone', { sortOrder: -1 }), project('p2')];
    const sessions = [session('sGone', 'gone'), session('s2', 'p2')];
    expect(afterProjectDeleted('gone', projects, sessions, 'gone', () => 'sGone')).toEqual({
      to: '/sessions/$sessionId',
      params: { sessionId: 's2' },
    });
  });

  it('lands on the no-project workspace after the last project', () => {
    expect(afterProjectDeleted('gone', [project('gone')], [], 'gone', none)).toEqual({
      to: '/workspace',
    });
  });
});
