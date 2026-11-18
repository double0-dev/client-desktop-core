import { createFileRoute } from '@tanstack/react-router';

// The no-project workspace (a private plan): where the app
// opens while no project exists. Like /workspace/$projectId, the UI is
// rendered by <WorkspaceHost> in the `_app` layout - the chrome with an empty
// Projects panel and an "Add your first project" empty state. It heals itself
// into a project's workspace as soon as one exists.
export const Route = createFileRoute('/_app/workspace/')({
  component: () => null,
});
