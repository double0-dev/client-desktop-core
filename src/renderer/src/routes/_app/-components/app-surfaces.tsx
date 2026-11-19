import { rendererExtension } from '@renderer/lib/extension/registry';
import { WorkspaceHost } from '@renderer/routes/_app/-components/workspace/workspace';
import type { WorkspaceUser } from '@renderer/routes/_app/-components/workspace/workspace-chrome';
import { SearchEverywhere } from '@renderer/routes/_app/-components/search-everywhere/search-everywhere';
import { NewProjectHost } from '@renderer/routes/_app/-components/new-project-host';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { AppErrorScreen } from '@renderer/components/app-error-screen';

/**
 * What the app layout mounts beside its routed page: the workspaces, the
 * palette, the New project dialog, the extension's app dialogs and, last,
 * its cover. Each part fails on its own (components/slot-boundary.tsx): the
 * workspace into the window's error screen, the rest into nothing - and none
 * of them takes the cover with it, which sits outside every other boundary.
 */
export function AppSurfaces({ user }: { user: WorkspaceUser }) {
  // The extension's app-level dialogs, if any.
  const AppDialogs = rendererExtension().hosts?.AppDialogs;
  // A cover over the whole window while the app may not be used (AuthSlot.Lock).
  const Lock = rendererExtension().auth?.Lock;
  return (
    <>
      {/* Session workspaces live here (above the routed pages) so their terminals
          stay alive while navigating between sessions and projects. */}
      <SlotBoundary name="workspace" fallback={(error) => <AppErrorScreen error={error} />}>
        <WorkspaceHost user={user} />
      </SlotBoundary>
      {/* Global "Search Everywhere" palette (double-Shift), mounted app-level so
          it opens from anywhere - a session or a project's session-less view. */}
      <SlotBoundary name="search">
        <SearchEverywhere userId={user.id} />
      </SlotBoundary>
      {/* The window's one New project dialog (lib/projects/new-project-request.ts):
          it must open with no project at all, so it belongs to no workspace. */}
      <SlotBoundary name="new-project">
        <NewProjectHost ownerId={user.id} />
      </SlotBoundary>
      {AppDialogs && (
        <SlotBoundary name="app-dialogs">
          <AppDialogs />
        </SlotBoundary>
      )}
      {/* Last, over everything, the workspace still mounted under it. A cover
          that fails to render fails closed: the error screen covers too. */}
      {Lock && (
        <SlotBoundary name="lock" fallback={(error) => <AppErrorScreen cover error={error} />}>
          <Lock />
        </SlotBoundary>
      )}
    </>
  );
}
