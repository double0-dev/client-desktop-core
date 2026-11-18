import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/session/bridge', () => ({ getSessionLayout: () => null }));

import { projectWindowDescriptor } from '@renderer/lib/project-actions';

/**
 * What "Open in separate window" sends main (a private plan):
 * every session the project's sidebar lists, so main moves all their shells
 * to the new window - the linked host projects' too (lib/projects/linked.ts).
 */
describe('projectWindowDescriptor', () => {
  it("carries the project's own sessions and those of the host projects listed under it", () => {
    const projects = [
      { id: 'acme', hostId: null, linkedProjectId: null },
      { id: 'acme-box', hostId: 'build-box', linkedProjectId: 'acme' },
      { id: 'tools-box', hostId: 'build-box', linkedProjectId: null },
    ];
    const sessions = [
      { id: 's1', projectId: 'acme' },
      { id: 'sBox', projectId: 'acme-box' },
      { id: 'sTools', projectId: 'tools-box' },
      { id: 'sNone', projectId: null },
    ];
    expect(projectWindowDescriptor({ id: 'acme', name: 'acme' }, sessions, projects)).toEqual({
      kind: 'project',
      projectId: 'acme',
      projectName: 'acme',
      sessions: [
        { sessionId: 's1', layout: null },
        { sessionId: 'sBox', layout: null },
      ],
    });
  });
});
