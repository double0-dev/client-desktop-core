import { useSyncExternalStore } from 'react';
import {
  listedProjectId,
  projectFamily,
  type LinkableProject,
} from '@renderer/lib/projects/linked';

/**
 * What lives in another window right now, as main reports it to THIS window
 * (a private plan): the torn-off sessions and the projects
 * open in a project window other than this one. Main is the authority
 * (window-ownership.ts); this store seeds from `window:listExternal` once and
 * follows `window:externalChanged`, so a reload can't forget that a session's
 * shells are owned by another window and double-open it. One store per
 * window, read by the workspace host, the Projects panel, its project menu
 * and Search Everywhere alike.
 *
 * `ready` gates the first session render in the host: a cold deep-link into a
 * torn-off session must not mount before the seed is in.
 */
export type ExternalWindows = { sessionIds: string[]; projectIds: string[] };

const EMPTY: ExternalWindows = { sessionIds: [], projectIds: [] };

let external: ExternalWindows = EMPTY;
let ready = false;
let wired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Replace the set - main's broadcast, or a test. */
export function setExternalWindows(next: ExternalWindows): void {
  external = {
    sessionIds: [...new Set(next.sessionIds)],
    projectIds: [...new Set(next.projectIds)],
  };
  ready = true;
  emit();
}

/** The host's optimistic edge: a session just released here, before main's broadcast lands. */
export function noteSessionReleased(sessionId: string): void {
  if (external.sessionIds.includes(sessionId)) return;
  external = { ...external, sessionIds: [...external.sessionIds, sessionId] };
  emit();
}

/** The host's optimistic edge: a session / project just returned here. */
export function noteSessionReturned(sessionId: string): void {
  if (!external.sessionIds.includes(sessionId)) return;
  external = { ...external, sessionIds: external.sessionIds.filter((id) => id !== sessionId) };
  emit();
}

export function noteProjectReturned(projectId: string): void {
  if (!external.projectIds.includes(projectId)) return;
  external = { ...external, projectIds: external.projectIds.filter((id) => id !== projectId) };
  emit();
}

export function getExternalWindows(): ExternalWindows {
  return external;
}

export function isExternalWindowsReady(): boolean {
  return ready;
}

/**
 * Seed from main and follow its broadcasts. Wired once per window on first
 * use; without the bridge (plain-browser dev, tests) the store is ready and
 * empty at once.
 */
export function ensureExternalWindowsWired(): void {
  if (wired) return;
  wired = true;
  const bridge = typeof window !== 'undefined' ? window.api?.window : undefined;
  if (!bridge?.listExternal) {
    ready = true;
    emit();
    return;
  }
  bridge.onExternalChanged?.((next) => setExternalWindows(next));
  void bridge
    .listExternal()
    .then((next) => {
      if (next) setExternalWindows(next);
    })
    .catch(() => {
      // Keep whatever we have - worst case is pre-seed behaviour.
    })
    .finally(() => {
      ready = true;
      emit();
    });
}

/** Test seam: forget the wiring and the set. */
export function resetExternalWindows(): void {
  external = EMPTY;
  ready = false;
  wired = false;
  emit();
}

export function subscribeExternalWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExternalWindows(): ExternalWindows {
  ensureExternalWindowsWired();
  return useSyncExternalStore(subscribeExternalWindows, getExternalWindows);
}

export function useExternalWindowsReady(): boolean {
  ensureExternalWindowsWired();
  return useSyncExternalStore(subscribeExternalWindows, isExternalWindowsReady);
}

/**
 * Every session `wcId` must treat as living elsewhere: the torn-off ones plus
 * every session of a project that is open in another window. The project
 * list is main's; the expansion to sessions is the renderer's, which has the
 * rows.
 */
export function externalSessionIds<T extends { id: string; projectId: string | null }>(
  ext: ExternalWindows,
  sessions: readonly T[],
  /** With it, a project window also takes its linked host projects' sessions. */
  projects?: readonly LinkableProject[],
): string[] {
  const ids = new Set(ext.sessionIds);
  if (ext.projectIds.length > 0) {
    const away = new Set<string>();
    for (const id of ext.projectIds) {
      if (projects) for (const member of projectFamily(id, projects)) away.add(member);
      else away.add(id);
    }
    for (const s of sessions) if (s.projectId != null && away.has(s.projectId)) ids.add(s.id);
  }
  return [...ids];
}

/**
 * Whether `projectId`'s sessions live in a project window: its own, or the
 * one of the project it is listed under (lib/projects/linked.ts).
 */
export function inExternalProjectWindow(
  ext: ExternalWindows,
  projectId: string | null | undefined,
  projects: readonly LinkableProject[],
): boolean {
  if (projectId == null) return false;
  if (ext.projectIds.includes(projectId)) return true;
  const listed = listedProjectId(
    projects.find((p) => p.id === projectId),
    projects,
  );
  return listed != null && listed !== projectId && ext.projectIds.includes(listed);
}
