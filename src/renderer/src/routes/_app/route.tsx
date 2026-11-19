import { useEffect } from 'react';
import { Outlet, createFileRoute, redirect, useParams } from '@tanstack/react-router';
import { LOCAL_USER } from '@renderer/lib/local-user';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { observeAutoNaming } from '@renderer/lib/session/auto-name';
import { useProjectAccent } from '@renderer/lib/settings/use-project-accent';
import { getProjectScope, scopedRedirect } from '@renderer/lib/workspace/project-scope';
import { AppSurfaces } from '@renderer/routes/_app/-components/app-surfaces';

export const Route = createFileRoute('/_app')({
  // The sign-in gate is the extension's (a private plan ›
  // decision 15): no account → the sign-in screen; an account mounts the app,
  // under the extension's cover (`AuthSlot.Lock`) while it may not be used.
  // The core build has no account and no gate. Data stays local-first and locally owned - every
  // row keeps the LOCAL_OWNER id, so `user` (data identity) remains the local
  // stub while the signed-in account only gates access and fills the
  // Settings → Account UI (via useAuthUser). Real ownership migration is a
  // later, sync-era change.
  //
  // A project window (lib/workspace/project-scope.ts) never leaves its
  // project: the no-project workspace and other projects' workspaces both
  // land back on its own.
  beforeLoad: async ({ location }) => {
    const auth = rendererExtension().auth;
    if (auth && (await auth.status()) === 'signed-out') throw redirect({ to: '/sign-in' });
    const scoped = scopedRedirect(location.pathname);
    if (scoped) throw redirect(scoped);
    return { user: LOCAL_USER };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext();
  // Auto-named sessions (launched without a name) follow their conversation
  // terminal's title reports; each window watches the shells it owns.
  useEffect(() => observeAutoNaming(), []);
  // The open project's color is the accent; a project window always shows its own.
  const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
  useProjectAccent({
    projectId: getProjectScope()?.projectId ?? params.projectId,
    sessionId: params.sessionId,
  });
  return (
    <>
      <Outlet />
      <AppSurfaces user={user} />
    </>
  );
}
