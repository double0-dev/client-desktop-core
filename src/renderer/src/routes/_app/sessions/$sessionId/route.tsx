import { createFileRoute } from '@tanstack/react-router';

// The actual workspace UI is rendered by <WorkspaceHost> in the `_app`
// layout, which keeps every opened session (and its terminals) mounted and
// alive across navigation. This route only needs to exist so the
// /sessions/$sessionId URL matches; the host reads the id from the URL and
// shows the matching workspace as an overlay above this (empty) page.
export const Route = createFileRoute('/_app/sessions/$sessionId')({
  component: () => null,
});
