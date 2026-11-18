import { afterEach, describe, expect, it } from 'vitest';
import {
  getProjectScope,
  inProjectScope,
  scopedRedirect,
  scopedSessions,
  setProjectScope,
  takeSeedLayout,
  windowChromeKey,
} from '@renderer/lib/workspace/project-scope';
import { initialLayout } from '@renderer/lib/workspace/layout';

/**
 * The project-window scope (a private plan): what a window
 * scoped to one project hosts, where its stray routes go, and which persisted
 * keys it keeps to itself.
 */

const PIPELINE = 'project-production-pipeline';
const DASHBOARD = 'project-web-dashboard';
const scope = { projectId: PIPELINE, projectName: 'production-pipeline' };
const sessions = [
  { id: 's1', projectId: PIPELINE },
  { id: 's2', projectId: DASHBOARD },
  { id: 's3', projectId: null },
];

afterEach(() => setProjectScope(null));

describe('the main window (no scope)', () => {
  it('hosts everything and redirects nothing', () => {
    expect(getProjectScope()).toBeNull();
    expect(inProjectScope(DASHBOARD)).toBe(true);
    expect(inProjectScope(null)).toBe(true);
    expect(scopedSessions(sessions)).toEqual(sessions);
    expect(scopedRedirect('/workspace')).toBeNull();
    expect(scopedRedirect(`/workspace/${DASHBOARD}`)).toBeNull();
    expect(windowChromeKey('double0-workspace-dock-panels')).toBe('double0-workspace-dock-panels');
  });
});

describe('a project window', () => {
  it('hosts only its own project', () => {
    setProjectScope(scope);
    expect(getProjectScope()).toEqual(scope);
    expect(inProjectScope(PIPELINE)).toBe(true);
    expect(inProjectScope(DASHBOARD)).toBe(false);
    expect(inProjectScope(null)).toBe(false);
    expect(scopedSessions(sessions)).toEqual([sessions[0]]);
  });

  it('sends the no-project workspace and other workspaces back to its project', () => {
    setProjectScope(scope);
    const home = { to: '/workspace/$projectId', params: { projectId: PIPELINE } };
    // A project window never shows "Add your first project": with its row
    // gone, startup's bare /workspace lands back home and the host closes it.
    expect(scopedRedirect('/workspace')).toEqual(home);
    expect(scopedRedirect('/workspace/')).toEqual(home);
    expect(scopedRedirect(`/workspace/${DASHBOARD}`)).toEqual(home);
    // Its own routes stand.
    expect(scopedRedirect(`/workspace/${PIPELINE}`)).toBeNull();
    expect(scopedRedirect('/sessions/s1')).toBeNull();
    expect(scopedRedirect('/sign-in')).toBeNull();
  });

  it('keeps its chrome state under its own keys', () => {
    // A dock resized in the project window must not resize the main window's.
    setProjectScope(scope);
    expect(windowChromeKey('double0-workspace-dock-panels')).toBe('double0-project-dock-panels');
    expect(windowChromeKey('double0-workspace-dock-width')).toBe('double0-project-dock-width');
    expect(windowChromeKey('double0-session-changes-width')).toBe(
      'double0-project-session-changes-width',
    );
  });

  it('hands each moved session its layout exactly once', () => {
    const layout = initialLayout('s1');
    setProjectScope(scope, [
      { sessionId: 's1', layout },
      { sessionId: 's2', layout: null },
    ]);
    expect(takeSeedLayout('s1')).toBe(layout);
    // Consumed: a remount must not re-read a seed whose shells moved on.
    expect(takeSeedLayout('s1')).toBeUndefined();
    expect(takeSeedLayout('s2')).toBeUndefined();
  });
});

describe('a project window and the host projects listed under its project', () => {
  // A host project made for PIPELINE (lib/projects/linked.ts): its
  // sessions show in PIPELINE's sidebar, so PIPELINE's window hosts them.
  const projects = [
    { id: PIPELINE, hostId: null, linkedProjectId: null },
    { id: 'box-pipeline', hostId: 'build-box', linkedProjectId: PIPELINE },
    { id: 'box-tools', hostId: 'build-box', linkedProjectId: null },
  ];
  const all = [
    ...sessions,
    { id: 'sBox', projectId: 'box-pipeline' },
    { id: 'sTools', projectId: 'box-tools' },
  ];

  it('hosts the linked host sessions with its own - never an unlinked host project', () => {
    setProjectScope(scope);
    expect(scopedSessions(all, undefined, projects).map((s) => s.id)).toEqual(['s1', 'sBox']);
    expect(inProjectScope('box-pipeline', undefined, projects)).toBe(true);
    expect(inProjectScope('box-tools', undefined, projects)).toBe(false);
    // Without the projects a caller sees the project's own sessions only.
    expect(scopedSessions(all).map((s) => s.id)).toEqual(['s1']);
  });
});
