import { describe, expect, it } from 'vitest';
import {
  sessionWindowsInOrder,
  externalFor,
  holdsSweepLease,
  mainWindowId,
  maySettleProject,
  maySettleSession,
  projectReturnTarget,
  projectWindowId,
  sessionReturnTarget,
  sessionWindowId,
  type WindowRecord,
  type WindowTable,
} from './window-ownership';

/**
 * The ownership model behind project windows (a private plan):
 * what each window must treat as living elsewhere, where a closing window hands
 * its shells, who may close whose window, and which window sweeps.
 */

const MAIN = 1;
const PROJECT_WIN = 2;
const SESSION_WIN = 3;
const TAB_WIN = 4;
const PIPELINE = 'project-production-pipeline';
const DASHBOARD = 'project-web-dashboard';

function table(entries: Array<[number, WindowRecord]>): WindowTable {
  return new Map(entries);
}

const typical = table([
  [MAIN, { kind: 'main' }],
  [PROJECT_WIN, { kind: 'project', projectId: PIPELINE }],
  [SESSION_WIN, { kind: 'session', sessionId: 's-torn', projectId: DASHBOARD }],
  [TAB_WIN, { kind: 'tab' }],
]);

describe('lookups', () => {
  it('finds each window by what it hosts', () => {
    expect(mainWindowId(typical)).toBe(MAIN);
    expect(projectWindowId(typical, PIPELINE)).toBe(PROJECT_WIN);
    expect(projectWindowId(typical, DASHBOARD)).toBeNull();
    expect(sessionWindowId(typical, 's-torn')).toBe(SESSION_WIN);
    expect(sessionWindowId(typical, 's-other')).toBeNull();
  });

  it('has no main window once it closed', () => {
    expect(
      mainWindowId(table([[PROJECT_WIN, { kind: 'project', projectId: PIPELINE }]])),
    ).toBeNull();
  });
});

describe('what is external to a window', () => {
  it('tells the main window about every torn-off session and every project window', () => {
    expect(externalFor(typical, MAIN)).toEqual({
      sessionIds: ['s-torn'],
      projectIds: [PIPELINE],
    });
  });

  it('tells a project window about session windows but never about itself', () => {
    // Its own project is not external to it: it must mount its own sessions.
    expect(externalFor(typical, PROJECT_WIN)).toEqual({
      sessionIds: ['s-torn'],
      projectIds: [],
    });
  });

  it('keeps a session window from reading its own session as external', () => {
    expect(externalFor(typical, SESSION_WIN).sessionIds).toEqual([]);
  });

  it('lists the other project windows for a project window', () => {
    const two = new Map(typical);
    two.set(5, { kind: 'project', projectId: DASHBOARD });
    expect(externalFor(two, PROJECT_WIN).projectIds).toEqual([DASHBOARD]);
    expect(externalFor(two, MAIN).projectIds).toEqual([PIPELINE, DASHBOARD]);
  });
});

describe('where a closing window hands its shells', () => {
  it('returns a session to the window hosting its project when there is one', () => {
    // User decision 2026-10-03 (#7): a session torn off from a project window
    // goes back to that window, not past it to the main window.
    expect(sessionReturnTarget(typical, PIPELINE)).toBe(PROJECT_WIN);
  });

  it('returns a session to the main window otherwise', () => {
    expect(sessionReturnTarget(typical, DASHBOARD)).toBe(MAIN);
    expect(sessionReturnTarget(typical, null)).toBe(MAIN);
  });

  it('returns a session nowhere when no window can take it', () => {
    const only = table([[SESSION_WIN, { kind: 'session', sessionId: 's', projectId: PIPELINE }]]);
    expect(sessionReturnTarget(only, PIPELINE)).toBeNull();
  });

  it('always returns a project to the main window', () => {
    expect(projectReturnTarget(typical)).toBe(MAIN);
    expect(
      projectReturnTarget(table([[PROJECT_WIN, { kind: 'project', projectId: PIPELINE }]])),
    ).toBeNull();
  });
});

describe('who may bring back or destroy a window', () => {
  const t = table([
    [MAIN, { kind: 'main' }],
    [PROJECT_WIN, { kind: 'project', projectId: PIPELINE }],
    [SESSION_WIN, { kind: 'session', sessionId: 's-mine', projectId: PIPELINE }],
    [5, { kind: 'session', sessionId: 's-foreign', projectId: DASHBOARD }],
    [6, { kind: 'project', projectId: DASHBOARD }],
    [TAB_WIN, { kind: 'tab' }],
  ]);

  it('lets a session window, the main window and its project window settle a session', () => {
    expect(maySettleSession(t, SESSION_WIN, 's-mine')).toBe(true);
    expect(maySettleSession(t, MAIN, 's-mine')).toBe(true);
    expect(maySettleSession(t, PROJECT_WIN, 's-mine')).toBe(true);
  });

  it("refuses a project window that does not host the session's project", () => {
    expect(maySettleSession(t, PROJECT_WIN, 's-foreign')).toBe(false);
    expect(maySettleSession(t, 6, 's-mine')).toBe(false);
  });

  it('refuses tab windows, other session windows and unknown senders', () => {
    expect(maySettleSession(t, TAB_WIN, 's-mine')).toBe(false);
    expect(maySettleSession(t, 5, 's-mine')).toBe(false);
    expect(maySettleSession(t, 99, 's-mine')).toBe(false);
    expect(maySettleSession(t, MAIN, 's-not-torn-off')).toBe(false);
  });

  it('lets only the project window itself or the main window settle a project', () => {
    expect(maySettleProject(t, PROJECT_WIN, PIPELINE)).toBe(true);
    expect(maySettleProject(t, MAIN, PIPELINE)).toBe(true);
    expect(maySettleProject(t, 6, PIPELINE)).toBe(false);
    expect(maySettleProject(t, SESSION_WIN, PIPELINE)).toBe(false);
    expect(maySettleProject(t, MAIN, 'project-not-in-a-window')).toBe(false);
  });
});

describe('the session-cleanup sweep lease', () => {
  it('belongs to the main window and nobody else', () => {
    // Two full-chrome windows sweeping at once would both delete the same
    // worktree - the project window must never be granted the lease.
    expect(holdsSweepLease(typical, MAIN)).toBe(true);
    expect(holdsSweepLease(typical, PROJECT_WIN)).toBe(false);
    expect(holdsSweepLease(typical, SESSION_WIN)).toBe(false);
    expect(holdsSweepLease(typical, 99)).toBe(false);
  });
});

describe('sessionWindowsInOrder', () => {
  it("asks the session's own window, then project windows, then main", () => {
    const table = new Map<number, WindowRecord>([
      [1, { kind: 'main' }],
      [2, { kind: 'project', projectId: 'p' }],
      [3, { kind: 'session', sessionId: 's1', projectId: 'p' }],
      [4, { kind: 'tab' }],
    ]);
    expect(sessionWindowsInOrder(table, 's1')).toEqual([3, 2, 1]);
    expect(sessionWindowsInOrder(table, 'other')).toEqual([2, 1]);
  });
});
