import { installDemoHooks } from './lib/demo-hooks';
import './assets/globals.css';
import {
  RouterProvider,
  createHashHistory,
  createRouter,
  type AnyRoute,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';

import { initAccentColor } from './lib/settings/accent-color';
import { applyThemeClass, resolveStoredTheme } from './lib/settings/theme';
import { initAppFont } from './lib/settings/ui-font-settings';
import { initLiveMotion } from './lib/settings/live-motion-settings';
import { getActiveWorkspaceController, getWorkspaceControllers } from './lib/workspace/bridge';
import { getSessionHost } from './lib/session/bridge';
import { setProjectScope } from './lib/workspace/project-scope';
import type { DetachedWindowPayload } from './lib/transfer';
import type { WorkspaceLayout } from './lib/workspace/layout';
import { routeTree } from './routeTree.gen';
// The one core file allowed to import it (a private plan).
import { proRenderer } from '@pro/renderer';
import { installRendererExtension } from './lib/extension/registry';
import { prepareTerminalEngine } from './lib/terminal/engine';

installDemoHooks(window, import.meta.env.DEV);
// Before anything renders: the router layout and a torn-off window (no
// router) read Pro's slots from the same registry.
installRendererExtension(proRenderer);

// Apply the persisted (dark-first) theme, app font and accent color before the
// first paint to avoid a flash; all stay live for the window's lifetime.
applyThemeClass(resolveStoredTheme());
initAppFont();
initAccentColor();
initLiveMotion();

const hashHistory = createHashHistory();
const router = createRouter({
  routeTree,
  history: hashHistory,
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Cross-window tab transfer (Phase B): main routes a torn-off tab here. Inserts
// go to whichever workspace is currently VISIBLE in this window (the in-app
// session surface or a detached terminal window) - and are acknowledged: with no
// workspace showing (e.g. this window has no project yet) we reply "rejected"
// so main leaves the tab, and its live shell, with the origin window.
window.api?.tab?.onInsertExternal((descriptor, clientX, clientY, transferId) => {
  const controller = getActiveWorkspaceController();
  const accepted = controller ? controller.insertExternalTab(descriptor, clientX, clientY) : false;
  window.api?.tab?.insertExternalResult(transferId, accepted);
});
// A removal must reach the workspace that holds the tab even if the user has
// switched sessions since the drop (hidden workspaces stay mounted and
// registered) - otherwise this window keeps a tab wired to a PTY that another
// window now owns. Search every mounted workspace; at most one holds the ptyId.
window.api?.tab?.onRemoved((termId) => {
  for (const controller of getWorkspaceControllers()) {
    if (controller.removeTabByPtyId(termId)) return;
  }
});
// A tab from another window is being dragged over this one → draw a live drop
// placeholder (where it would land) until it leaves or is released.
window.api?.tab?.onDragPreview((_descriptor, clientX, clientY) => {
  getActiveWorkspaceController()?.previewExternalDrop(clientX, clientY);
});
window.api?.tab?.onDragPreviewEnd(() => {
  getActiveWorkspaceController()?.clearExternalDropPreview();
});
// A whole session moved out of this window → let the host release it.
window.api?.session?.onRemoved((sessionId) => {
  getSessionHost()?.releaseSession(sessionId);
});
// A torn-off session's window closed → take it back, restoring its synced layout.
// The layout is opaque across the IPC boundary, so cast it back here.
window.api?.session?.onReturnToList((sessionId, layout) => {
  getSessionHost()?.returnSession(sessionId, layout as WorkspaceLayout);
});
// A whole project moved out of this window → release every session of it.
window.api?.project?.onRemoved((projectId) => {
  getSessionHost()?.releaseProject(projectId);
});
// A project's window closed → take its sessions back with their synced layouts.
window.api?.project?.onReturnToList((projectId, sessions) => {
  getSessionHost()?.returnProject(
    projectId,
    sessions as Array<{ sessionId: string; layout: WorkspaceLayout }>,
  );
});
// A project window clicked a project that lives here → show it (null = its
// New project dialog, with the host of "Add a project on <host>" picked).
window.api?.project?.onNavigate((projectId, hostId) => {
  getSessionHost()?.showProject(projectId, hostId);
});

/**
 * A window created by a tear-off carries a bootstrap payload: a single terminal
 * or a whole session renders just the detached surface; a whole project boots
 * the normal router scoped to that project (lib/workspace/project-scope.ts) -
 * the full chrome, every tool window, just one project. Every other window is
 * the full app (router). The payload is read once here (outside React) so a
 * StrictMode double render can't consume it twice; main keeps it for the
 * window's lifetime, so a reload re-boots the same surface (with the freshest
 * synced layout) instead of morphing into a second full app window. The
 * layouts inside a session / project payload are opaque across the IPC
 * boundary, so we cast them back to the renderer's types here.
 */
async function boot(): Promise<void> {
  const rootElement = document.getElementById('root')!;
  if (rootElement.innerHTML) return;

  // The Ghostty terminal engine (Settings › Terminal › Renderer) loads its
  // WebAssembly before the first terminal is made; xterm.js windows skip it.
  const terminalEngineReady = prepareTerminalEngine();
  const payload = (await window.api?.window?.getInitialPayload()) ?? null;
  const detached = payload?.kind === 'detached' || payload?.kind === 'session';
  if (payload?.kind === 'project') {
    const { projectId, projectName, sessions } = payload.project;
    setProjectScope(
      { projectId, projectName },
      sessions as Array<{ sessionId: string; layout: WorkspaceLayout | null }>,
    );
    // Land on the project (routes/index.tsx picks its last-viewed session) -
    // never on whatever hash a reload left, if it was outside the scope.
    document.title = projectName;
    hashHistory.replace('/');
  }

  // The router fetches a route's code split only after every beforeLoad has
  // run - and `_app`'s waits on the auth check, a network round trip. Start
  // the chunks of the routes this window is about to show right away, so
  // they load during that wait instead of after it.
  if (!detached) {
    // Indexed by the plain string id a match carries (router-core dropped its
    // untyped `looseRoutesById` view of this same map).
    const routesById = new Map<string, AnyRoute>(Object.entries(router.routesById));
    for (const match of router.matchRoutes(router.state.location)) {
      const route = routesById.get(match.routeId);
      if (route) void router.loadRouteChunk(route)?.catch(() => {});
    }
  }

  // The detached surface pulls in the whole workspace (terminals, editors,
  // extension views, the tool windows) - only a torn-off window loads it, so the entry
  // chunk every other window parses stays small. Awaited before the first
  // render: the window shows nothing until boot renders either way.
  const DetachedWindow = detached
    ? (await import('./routes/_app/-components/workspace/detached-window')).DetachedWindow
    : null;

  await terminalEngineReady;
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      {DetachedWindow ? (
        <DetachedWindow payload={payload as DetachedWindowPayload} />
      ) : (
        <RouterProvider router={router} />
      )}
    </StrictMode>,
  );
}

void boot();
