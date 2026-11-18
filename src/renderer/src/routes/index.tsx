import { createFileRoute, redirect } from '@tanstack/react-router';
import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { lastProject, lastProjectSession } from '@renderer/lib/last-project-session';
import { startupTarget } from '@renderer/lib/startup-target';
import { getProjectScope } from '@renderer/lib/workspace/project-scope';

/**
 * How long to wait for the first projects/sessions snapshot before deciding
 * where to open. The snapshot is a local DB read over IPC (milliseconds), so
 * this only bites when the database failed to initialise - main shows its own
 * dialog for that, and the sync never marks ready (see lib/local-collection.ts),
 * so without a bound we'd hold the window on a blank screen forever. On timeout
 * we know of no projects and land on the no-project workspace, which reads
 * "Loading projects…" until the collection is ready.
 */
const SNAPSHOT_TIMEOUT_MS = 2000;

// Local-first: there's no landing or auth screen. With at least one project we
// open straight into its workspace - the one last worked in, on the session last
// viewed there - so a restart resumes where the user left off; with none, the
// no-project workspace, whose empty state adds the first one.
export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    await Promise.race([
      Promise.all([projectsCollection.preload(), agentSessionsCollection.preload()]),
      new Promise((resolve) => setTimeout(resolve, SNAPSHOT_TIMEOUT_MS)),
    ]);
    // A project window (lib/workspace/project-scope.ts) knows only its project:
    // it opens on that project's last-viewed session, never the main window's
    // last project. A deleted scoped project leaves no project at all - the
    // no-project target then redirects back into the scope and the host closes
    // the window.
    const scope = getProjectScope();
    const projects = scope
      ? projectsCollection.toArray.filter((p) => p.id === scope.projectId)
      : projectsCollection.toArray;
    const target = startupTarget(
      projects,
      agentSessionsCollection.toArray,
      scope?.projectId ?? lastProject(),
      lastProjectSession,
    );
    if (target.to === '/sessions/$sessionId') {
      throw redirect({ to: target.to, params: target.params });
    }
    if (target.to === '/workspace/$projectId') {
      throw redirect({ to: target.to, params: target.params });
    }
    throw redirect({ to: target.to });
  },
});
