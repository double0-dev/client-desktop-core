import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { createProject, type ProjectEdits } from '@renderer/lib/project-actions';
import {
  takeNewProjectRequest,
  useNewProjectRequest,
} from '@renderer/lib/projects/new-project-request';
import { NewProjectDialog } from '@renderer/routes/_app/-components/new-project-dialog';

/**
 * The window's one New project dialog (a private plan),
 * mounted in the `_app` layout so it opens whatever the workspace shows -
 * a session, a project's session-less view or the no-project state. Opened
 * through `requestNewProject`; a created project opens its session-less
 * workspace, where its first session is started.
 */
export function NewProjectHost({ ownerId }: { ownerId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const request = useNewProjectRequest();

  useEffect(() => {
    if (!request) return;
    const taken = takeNewProjectRequest();
    if (!taken) return;
    setHostId(taken.hostId);
    setOpen(true);
  }, [request]);

  function create(edits: ProjectEdits) {
    const projectId = createProject({ ...edits, ownerId });
    if (!projectId) return;
    void navigate({ to: '/workspace/$projectId', params: { projectId } });
  }

  return (
    <NewProjectDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setHostId(null);
      }}
      onCreate={create}
      initialHostId={hostId}
    />
  );
}
