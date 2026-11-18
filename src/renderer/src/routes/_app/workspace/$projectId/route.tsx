import { createFileRoute } from '@tanstack/react-router';

// The session-less workspace of a project with no sessions yet. Like
// /sessions/$sessionId, the UI is rendered by <WorkspaceHost> in the `_app`
// layout; this route only needs to exist so the URL matches - the host reads
// the project id from it and shows the workspace chrome with an empty state
// (from which the first session can be created).
export const Route = createFileRoute('/_app/workspace/$projectId')({
  component: () => null,
});
