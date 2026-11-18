import { afterEach, describe, expect, it, vi } from 'vitest';
import { setProjectScope } from '@renderer/lib/workspace/project-scope';
import {
  openNewProjectHere,
  requestNewProject,
  takeNewProjectRequest,
} from '@renderer/lib/projects/new-project-request';

describe('requestNewProject', () => {
  afterEach(() => {
    setProjectScope(null);
    takeNewProjectRequest();
    vi.unstubAllGlobals();
  });

  it('opens this window’s dialog in the main window, once per take', () => {
    requestNewProject('host-1');
    expect(takeNewProjectRequest()).toEqual({ hostId: 'host-1' });
    expect(takeNewProjectRequest()).toBeNull();
  });

  it('sends a project window’s ask to the main window, host included', () => {
    // A project window is scoped to one project and creates none of its own.
    const openInMain = vi.fn();
    vi.stubGlobal('api', { project: { openInMain } });
    setProjectScope({ projectId: 'project-pipeline', projectName: 'production-pipeline' });
    requestNewProject('host-1');
    expect(openInMain).toHaveBeenCalledWith(null, 'host-1');
    expect(takeNewProjectRequest()).toBeNull();
    // Main's forwarded ask opens the dialog where it lands, whatever the scope.
    openNewProjectHere('host-1');
    expect(takeNewProjectRequest()).toEqual({ hostId: 'host-1' });
  });
});
