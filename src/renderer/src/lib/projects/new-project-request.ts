import { useSyncExternalStore } from 'react';
import { getProjectScope } from '@renderer/lib/workspace/project-scope';

/**
 * Asks this window's New project dialog (`NewProjectHost`, mounted once in the
 * `_app` layout - a private plan) to open. Every way in goes
 * through here: the Projects panel's "+", the no-project workspace's empty
 * state, the `new-project` action, the main window's `showProject(null)` and
 * an extension's "add a project on <machine>" (that machine preselected).
 *
 * A project window creates no projects of its own: the request goes to the
 * MAIN window (main forwards it as `project:navigate { projectId: null }`).
 *
 * A request made before the host mounts waits; each request is a new object,
 * so asking twice for the same host still reopens a dismissed dialog.
 */
export type NewProjectRequest = { hostId: string | null };

let pending: NewProjectRequest | null = null;
const listeners = new Set<() => void>();

export function requestNewProject(hostId: string | null = null): void {
  if (getProjectScope()) {
    window.api?.project?.openInMain(null, hostId);
    return;
  }
  openNewProjectHere(hostId);
}

/** Opens THIS window's dialog, whatever its scope (main's forwarded ask). */
export function openNewProjectHere(hostId: string | null = null): void {
  pending = { hostId };
  for (const l of listeners) l();
}

/** The waiting request, cleared - the host takes it once it opens the dialog. */
export function takeNewProjectRequest(): NewProjectRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function useNewProjectRequest(): NewProjectRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}
