import { useMatchRoute, useNavigate } from '@tanstack/react-router';
import { eq, useLiveQuery } from '@tanstack/react-db';
import { railTool, rendererExtension } from '@renderer/lib/extension/registry';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  WorkspaceView,
  type WorkspaceUser,
} from '@renderer/routes/_app/-components/workspace/workspace-chrome';
import {
  decodeDockPanels,
  decodeDockWidth,
  dockToolStorageKey,
  railTabAvailable,
  railToolAvailabilityHook,
  toggleDockPanel,
  type DockStackPanelId,
  type RailTabId,
} from '@renderer/lib/workspace/dock-state';
import {
  allTabs,
  conversationPtyId,
  normalizeRestoredLayout,
  unmountedSessionPtyIds,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import {
  getSessionLayout,
  registerRestoredLayouts,
  registerSessionLayout,
  setSessionHost,
} from '@renderer/lib/session/bridge';
import { registerExplorerOpener } from '@renderer/lib/explorer-reveal';
import {
  EXPLORER_SESSIONS_KEY,
  decodeExplorerOpen,
  explorerKey,
  pruneExplorerOpen,
  setExplorerOpenFor,
} from '@renderer/lib/workspace/explorer-open';
import { setupPtyId } from '@renderer/lib/session/setup';
import { disposePooledTerminal } from '@renderer/lib/terminal/pool';
import { usePersistedFlags, usePersistedState } from '@renderer/lib/use-persisted-state';
import { useVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { listedProjectId, projectFamily } from '@renderer/lib/projects/linked';
import { setFocusedSession } from '@renderer/lib/session/attention';
import { useSessionCleanupSweep } from '@renderer/lib/session/use-session-cleanup';
import { observeSessionStatus } from '@renderer/lib/session/status';
import {
  lastProjectSession,
  rememberLastProject,
  rememberProjectSession,
} from '@renderer/lib/last-project-session';
import { projectOpenTarget } from '@renderer/lib/startup-target';
import { goToTarget } from '@renderer/lib/workspace/open-target';
import { openNewProjectHere } from '@renderer/lib/projects/new-project-request';
import {
  externalSessionIds,
  noteProjectReturned,
  noteSessionReleased,
  noteSessionReturned,
  useExternalWindows,
  useExternalWindowsReady,
} from '@renderer/lib/workspace/external-windows';
import {
  getProjectScope,
  scopedSessions,
  takeSeedLayout,
  windowChromeKey,
} from '@renderer/lib/workspace/project-scope';

// The shared chrome state (dock + explorer), persisted across app restarts.
// A project window keeps its own copy of each (windowChromeKey): opening a
// tool or resizing the dock there never moves the main window's chrome.
const DOCK_PANELS_KEY = windowChromeKey('double0-workspace-dock-panels');
const DOCK_WIDTH_KEY = windowChromeKey('double0-workspace-dock-width');
/** Each extension rail tool's open flag (one exclusive overlay at a time). */
const dockToolKey = (id: string): string => windowChromeKey(dockToolStorageKey(id));
const BOTTOM_PANEL_OPEN_KEY = windowChromeKey('double0-workspace-commands-open');

/**
 * How many sessions may stay fully mounted (xterms + scrollback, observers,
 * subscriptions) while hidden, beyond the one being viewed. Visiting more than
 * this evicts the least-recently-active hidden session: its layout is kept (in
 * memory and on disk), its pooled xterms are released, but its PTYs keep running
 * - revisiting re-mounts the view and re-adopts the live shells with a replay.
 */
const MAX_HIDDEN_SESSIONS = 5;

/** A hidden session evicted from the mounted set: its last layout (the revisit
 * seed, PTY ids intact) + the disposer for its stand-in session-bridge getter. */
type EvictedSession = { layout: WorkspaceLayout; unregister: () => void };

/**
 * App-level host for session workspaces. Mounted once in the `_app` layout
 * (which stays mounted across every navigation), so every
 * opened session - its tabs and live PTYs - survives leaving the workspace and
 * coming back. The host shows the workspace whose id is in the URL; when the URL
 * is elsewhere (the instant `/` redirect, sign-in) all workspaces stay mounted but hidden.
 */
export function WorkspaceHost({ user }: { user: WorkspaceUser }) {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const match = matchRoute({ to: '/sessions/$sessionId' });
  const activeSessionId = match ? match.sessionId : null;
  // The session-less workspace of a project with no sessions yet: full chrome +
  // an empty state to create the first one (the /workspace/$projectId route).
  const emptyMatch = matchRoute({ to: '/workspace/$projectId' });
  const emptyProjectId = emptyMatch ? emptyMatch.projectId : null;
  // The no-project workspace (/workspace): the same chrome with no project at
  // all - where the app opens before the first one exists.
  const projectless = !emptyProjectId && !!matchRoute({ to: '/workspace' });

  // A project window (lib/workspace/project-scope.ts) hosts one project only.
  const scope = getProjectScope();

  // Sessions currently mounted, ordered least→most recently active (the LRU
  // order the eviction below consumes). Capped: hidden sessions beyond
  // MAX_HIDDEN_SESSIONS are evicted rather than kept mounted forever.
  const [openIds, setOpenIds] = useState<string[]>([]);
  // What lives in another window, as main reports it to this one (torn-off
  // sessions + projects in their own windows). Main is the authority
  // (window-ownership.ts): renderer-local state alone doesn't survive a reload
  // - this window would forget a session's shells live elsewhere and mount a
  // dead workspace over them (blank terminals). `externalReady` gates the
  // first session render (like `layoutsReady` below) so a cold deep-link into
  // a torn-off session can't mount before the seed.
  const external = useExternalWindows();
  const externalReady = useExternalWindowsReady();

  // Which tool panels are open in the dock. Lifted here (not per-view) so the
  // choice is shared across every mounted session and survives switching between
  // them; persisted to localStorage so it survives an app restart too.
  const [dockPanels, setDockPanels] = usePersistedState<DockStackPanelId[]>(
    DOCK_PANELS_KEY,
    decodeDockPanels,
    (panels) => JSON.stringify(panels),
  );

  // Turning the vertical-tabs setting ON opens its dock panel, so the feature
  // is immediately visible (the tab strips just disappeared). Only on the
  // false→true transition - not on mount - so a user who closed the panel keeps
  // it closed across restarts. Turning it off leaves `tabs` in the persisted
  // set; the chrome filters it out while the setting is off.
  const verticalTabs = useVerticalTabs();
  const prevVerticalTabs = useRef(verticalTabs);
  useEffect(() => {
    if (verticalTabs && !prevVerticalTabs.current) {
      setDockPanels((prev) => (prev.includes('tabs') ? prev : [...prev, 'tabs']));
    }
    prevVerticalTabs.current = verticalTabs;
  }, [verticalTabs, setDockPanels]);

  // The extension's rail tools are exclusive overlays: while one is open the
  // dock shows only its panel and the content area swaps to its views. The
  // stacked set + explorer keep their state underneath (shown as "suppressed"
  // in the rail) and come back when it closes. A stored "open" from a build
  // that had a tool must not open an empty overlay in one that does not, so a
  // flag counts only while its tool is registered.
  const overlayIds = useMemo(() => rendererExtension().railTools.map((t) => t.id), []);
  const overlayKeys = useMemo(
    () => Object.fromEntries(overlayIds.map((id) => [id, dockToolKey(id)])),
    [overlayIds],
  );
  const [overlayStored, setOverlayOpen] = usePersistedFlags(overlayKeys);
  const openOverlay = overlayIds.find((id) => overlayStored[id] && railTool(id)) ?? null;

  // Dock width (px) - shared across sessions and persisted, like the open panels.
  const [dockWidth, setDockWidth] = usePersistedState<number>(
    DOCK_WIDTH_KEY,
    decodeDockWidth,
    String,
  );

  // File-explorer sidebar open/closed - remembered PER SESSION (and per
  // project for the session-less view), unlike the dock: opening it in one
  // session leaves the others as they were. Closed until the user opens it.
  // `setExplorerOpen` acts on the workspace on screen, read through a ref so
  // the rail/shortcut handlers below keep stable identities.
  const [explorerOpenKeys, setExplorerOpenKeys] = usePersistedState<string[]>(
    EXPLORER_SESSIONS_KEY,
    decodeExplorerOpen,
    (keys) => JSON.stringify(keys),
  );
  const activeExplorerKey = explorerKey(activeSessionId, emptyProjectId);
  const activeExplorerKeyRef = useRef(activeExplorerKey);
  activeExplorerKeyRef.current = activeExplorerKey;
  const setExplorerOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (action) => {
      const key = activeExplorerKeyRef.current;
      if (!key) return;
      setExplorerOpenKeys((prev) => {
        const value = typeof action === 'function' ? action(prev.includes(key)) : action;
        return setExplorerOpenFor(prev, key, value);
      });
    },
    [setExplorerOpenKeys],
  );

  // The bottom panel - a full-width panel (the extension's) docked at the
  // bottom (below the content, status bar underneath). Shared across sessions +
  // persisted, toggled from the rail's play button and ⌘8. Independent of the
  // left dock/Changes overlay, so it can sit under either.
  const [bottomPanelStored, setCommandsOpen] = usePersistedState<boolean>(
    BOTTOM_PANEL_OPEN_KEY,
    (raw) => raw === '1',
    (open) => (open ? '1' : '0'),
  );
  // The dock is Pro (a private plan › M1): a stored "open" counts only where it exists.
  const bottomPanelOpen = bottomPanelStored && rendererExtension().bottomPanel !== undefined;
  const toggleBottomPanel = useCallback(() => setCommandsOpen((v) => !v), [setCommandsOpen]);

  // Which of the extension's tools exist for the project on screen. Computed
  // further down (it needs the visible project, which needs the live session
  // list) and mirrored into a ref so `toggleDock` - declared here with the rest
  // of the dock state - can read it at call time.
  const availabilityRef = useRef<Readonly<Record<string, boolean | null>>>({});

  // One handler for every rail tab. An extension's tools flip their overlays
  // (mutually exclusive); while one is up, picking any other tool closes it
  // and makes sure the picked tool is visible (rather than toggling it off
  // underneath).
  const anyOverlayOpen = openOverlay !== null;
  const closeOverlays = useCallback(() => {
    for (const id of overlayIds) setOverlayOpen(id, false);
  }, [overlayIds, setOverlayOpen]);
  const toggleDock = useCallback(
    (id: RailTabId) => {
      // A tool the rail isn't showing (one the project on screen does not
      // have, Tabs without the vertical-tabs setting) can't be toggled - same
      // rule the rail filters its icons by, so its ⌘-digit stays inert exactly
      // while its tab is gone.
      if (!railTabAvailable(id, { verticalTabs, availability: availabilityRef.current })) return;
      if (overlayIds.includes(id)) {
        for (const other of overlayIds) if (other !== id) setOverlayOpen(other, false);
        setOverlayOpen(id, (v) => !v);
        return;
      }
      if (id === 'files') {
        if (anyOverlayOpen) {
          closeOverlays();
          setExplorerOpen(true);
        } else {
          setExplorerOpen((v) => !v);
        }
        return;
      }
      const panel = id as DockStackPanelId;
      if (anyOverlayOpen) {
        closeOverlays();
        setDockPanels((prev) => (prev.includes(panel) ? prev : [...prev, panel]));
      } else {
        setDockPanels((prev) => toggleDockPanel(prev, panel));
      }
    },
    [
      anyOverlayOpen,
      verticalTabs,
      closeOverlays,
      overlayIds,
      setOverlayOpen,
      setDockPanels,
      setExplorerOpen,
    ],
  );

  // "Show in file explorer" (tab context menu): make the sidebar visible so the
  // explorer can mount and take the reveal - same overlay handling as picking
  // Files on the rail.
  useEffect(
    () =>
      registerExplorerOpener(() => {
        closeOverlays();
        setExplorerOpen(true);
      }),
    [closeOverlays, setExplorerOpen],
  );

  // Layouts handed back when a session's window closes, used to seed its view so it
  // returns with the exact tabs/splits it had. Read at mount; never needs a render.
  // Consumed (deleted) by `consumeSeedLayout` once the view's provider has mounted.
  const returnedLayouts = useRef(new Map<string, WorkspaceLayout>());
  // Sessions evicted from the mounted set (LRU cap). Their last layout seeds the
  // remount when revisited - PTY ids intact, so the live shells are re-adopted.
  const evictedLayouts = useRef(new Map<string, EvictedSession>());

  // Layouts persisted by previous app runs, loaded once at startup. Each seeds a
  // session's view the first time it's opened this run, so its tabs and split
  // placement come back (with fresh shells). A ref, not state: it's only ever read
  // as a one-time seed during render, never drives one. `layoutsReady` gates the
  // first session render so that seed is in hand before any provider initialises.
  const persistedLayouts = useRef(new Map<string, WorkspaceLayout>());
  const [layoutsReady, setLayoutsReady] = useState(false);
  // The delete warnings read them too: a session not opened yet this run can
  // still run an agent in any of those tabs (session/worktree-delete).
  useEffect(() => registerRestoredLayouts((id) => persistedLayouts.current.get(id)), []);
  useEffect(() => {
    const list = window.api?.layout?.list;
    if (!list) {
      setLayoutsReady(true);
      return;
    }
    let cancelled = false;
    void list()
      .then((rows) => {
        if (cancelled) return;
        for (const { sessionId, layout } of rows ?? []) {
          // Repair a slightly-off blob (older schema, crash mid-write) instead of
          // discarding the user's whole arrangement; only one beyond repair is
          // dropped - that session just opens fresh.
          const normalized = normalizeRestoredLayout(layout);
          if (normalized) persistedLayouts.current.set(sessionId, normalized);
        }
      })
      .catch(() => {
        // Don't strand the workspace if the read fails - open sessions fresh.
      })
      .finally(() => {
        if (!cancelled) setLayoutsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live set of the user's sessions and projects. Queried once here and passed
  // down to every mounted WorkspaceView, so N hidden sessions don't each re-run
  // identical subscriptions on every sync tick. `isReady` gates the deletion
  // cleanup below so a pre-sync empty result isn't read as "all deleted".
  const { data: liveSessions, isReady: sessionsReady } = useLiveQuery((q) =>
    q
      .from({ session: agentSessionsCollection })
      .where(({ session }) => eq(session.ownerId, user.id)),
  );
  const { data: liveProjects, isReady: projectsReady } = useLiveQuery((q) =>
    q.from({ project: projectsCollection }).where(({ project }) => eq(project.ownerId, user.id)),
  );
  // The sessions THIS window hosts: all of them in the main window, its
  // project's in a project window. Every lifecycle set below (observers,
  // deletion cleanup) walks this, never the full list.
  // A project window hosts its linked host projects' sessions too (lib/projects/linked.ts).
  const hostedSessions = useMemo(
    () => scopedSessions(liveSessions, scope, liveProjects),
    [liveSessions, scope, liveProjects],
  );

  // Sessions living in a separate window - torn off, or in a project that is
  // open in another window (main lists the projects; the sessions are ours to
  // expand). They're NOT auto-reopened here (which would steal their shells)
  // and show a placeholder if navigated to.
  // In a project window every other project's session counts as released
  // too: a stray navigation there (a link, a future caller) must show the
  // placeholder, never mount it and take its shells (review, 2026-10-06).
  const releasedIds = useMemo(() => {
    const ids = externalSessionIds(external, liveSessions, liveProjects);
    if (!scope) return ids;
    const hosted = new Set(hostedSessions.map((x) => x.id));
    return [...ids, ...liveSessions.filter((x) => !hosted.has(x.id)).map((x) => x.id)];
  }, [external, liveSessions, liveProjects, scope, hostedSessions]);
  const releasedRef = useRef(releasedIds);
  releasedRef.current = releasedIds;

  useEffect(() => {
    // Don't (re)adopt a session that's open in another window - it would steal the
    // shells. Navigating to it shows the placeholder instead. Visiting moves the
    // session to the end of `openIds` (most recently active) for the LRU below;
    // children are keyed by id, so the reorder never remounts a view.
    if (activeSessionId && !releasedRef.current.includes(activeSessionId)) {
      setOpenIds((prev) => {
        if (prev[prev.length - 1] === activeSessionId) return prev;
        return [...prev.filter((id) => id !== activeSessionId), activeSessionId];
      });
    }
  }, [activeSessionId]);

  /** Forget a session's evicted-state (it remounted, left, or was deleted). */
  const dropEvicted = useCallback((sessionId: string) => {
    const evicted = evictedLayouts.current.get(sessionId);
    if (!evicted) return;
    evicted.unregister();
    evictedLayouts.current.delete(sessionId);
  }, []);

  // A session was torn off into its own window: let it go without navigating away
  // (the user stays put). Capture its shells, unmount the view, then drop the
  // orphaned xterms - keeping the PTYs, which the new window re-owned via adopt.
  // Works for evicted sessions too (their layout is still published via the
  // stand-in getter registered on eviction; their xterms are already gone).
  const letSessionGo = useCallback(
    (sessionId: string) => {
      const layout = getSessionLayout(sessionId);
      // Only terminal-family tabs own a shell; editor tabs have no ptyId.
      const ptyIds = layout
        ? allTabs(layout)
            .map((t) => t.ptyId)
            .filter((id): id is string => !!id)
        : [];
      dropEvicted(sessionId);
      setOpenIds((prev) => prev.filter((id) => id !== sessionId));
      requestAnimationFrame(() => ptyIds.forEach((id) => disposePooledTerminal(id, false)));
    },
    [dropEvicted],
  );
  const releaseSession = useCallback(
    (sessionId: string) => {
      letSessionGo(sessionId);
      // Optimistic: main's broadcast carries the same fact a beat later.
      noteSessionReleased(sessionId);
    },
    [letSessionGo],
  );

  // A session's window closed: take it back, seeding its view with the synced
  // layout so its terminals (adopted by ptyId) come back exactly as left. The
  // seed is consumed (consumeSeedLayout) once the view's provider has mounted.
  const returnSession = useCallback((sessionId: string, layout: WorkspaceLayout) => {
    returnedLayouts.current.set(sessionId, layout);
    noteSessionReturned(sessionId);
    setOpenIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
  }, []);

  // A whole project moved into its own window (a private plan):
  // let every session of it this window holds go - open or evicted, the same
  // way a single torn-off session is released. Main already lists the project
  // as external to this window (its broadcast precedes `project:removed`), so
  // the rows read as living elsewhere and nothing remounts them.
  const liveSessionsRef = useRef(liveSessions);
  liveSessionsRef.current = liveSessions;
  // Its linked host projects' sessions go with it (lib/projects/linked.ts).
  const releaseProject = useCallback(
    (projectId: string) => {
      const family = projectFamily(projectId, projectsCollection.toArray);
      for (const s of liveSessionsRef.current) {
        if (s.projectId != null && family.has(s.projectId)) letSessionGo(s.id);
      }
    },
    [letSessionGo],
  );

  // A project's window closed: take it back. The sessions that window opened
  // come with their synced layout and remount (their shells, routed back by
  // main, are adopted with a replay); the rest just stop reading as external -
  // their shells never left this window.
  const returnProject = useCallback(
    (projectId: string, sessions: Array<{ sessionId: string; layout: WorkspaceLayout }>) => {
      for (const { sessionId, layout } of sessions) returnedLayouts.current.set(sessionId, layout);
      noteProjectReturned(projectId);
      const returning = sessions.map((s) => s.sessionId);
      setOpenIds((prev) => [...prev, ...returning.filter((id) => !prev.includes(id))]);
    },
    [],
  );

  // A project window pointed this (main) window at a project it does not
  // host: show it - its last-viewed session, else its top one, else its
  // session-less view; null = the New project dialog (the Projects panel's
  // "+", or "Add a project on <host>" with that host picked).
  const showProject = useCallback(
    (projectId: string | null, hostId: string | null = null) => {
      if (!projectId) {
        openNewProjectHere(hostId);
        return;
      }
      goToTarget(
        navigate,
        projectOpenTarget(
          projectId,
          projectsCollection.toArray,
          liveSessionsRef.current,
          lastProjectSession,
        ),
      );
    },
    [navigate],
  );

  // A view's provider mounted and seeded itself: drop the host-side seed so this
  // map doesn't retain stale layouts (each pinning tab/pty refs) for the app's
  // lifetime - and so no later mount (a transition, a remount) can ever re-read
  // a seed that's already been consumed. Called from a commit effect, never
  // during render, so a discarded render can't consume anything.
  const consumeSeedLayout = useCallback(
    (sessionId: string) => {
      returnedLayouts.current.delete(sessionId);
      dropEvicted(sessionId);
    },
    [dropEvicted],
  );

  // Evict a hidden session that fell off the LRU: persist its layout, keep it
  // readable for tear-offs, then unmount the view and release the pooled xterms
  // WITHOUT killing the PTYs - the same decoupling the tear-off path relies on.
  // `requestReplay` marks each live shell so the fresh xterms created on revisit
  // re-adopt with a scrollback replay (a same-window re-create otherwise skips it).
  const evictSession = useCallback((sessionId: string) => {
    const layout = getSessionLayout(sessionId);
    if (layout) {
      // The surface saves structural changes immediately but debounces pure
      // resizes - flush explicitly so the on-disk copy can't be a beat behind.
      window.api?.layout?.save(sessionId, layout);
      // Keep the layout readable after the surface unmounts (it unregisters its
      // own getter), so tearing an evicted session off into a window still
      // carries its tabs/splits and pre-assigns its live shells.
      const unregister = registerSessionLayout(sessionId, () => layout);
      evictedLayouts.current.set(sessionId, { layout, unregister });
      const ptyIds = allTabs(layout)
        .map((t) => t.ptyId)
        .filter((id): id is string => !!id);
      // After the unmount commits (same convention as releaseSession), drop the
      // orphaned xterms and flag their shells for replay-on-readopt.
      requestAnimationFrame(() =>
        ptyIds.forEach((id) => {
          disposePooledTerminal(id, false);
          window.api?.terminal?.requestReplay(id);
        }),
      );
    }
    setOpenIds((prev) => prev.filter((id) => id !== sessionId));
  }, []);

  // Enforce the cap whenever the mounted set or the active session changes.
  // `openIds` is LRU-ordered, so the front holds the least-recently-active.
  // The active session is never evicted; neither is a session mid-tear-off - a
  // sidebar/tab drag captures the pointer, so no navigation (the only eviction
  // trigger) can happen before its `session:removed`/`tab:removed` resolves.
  useEffect(() => {
    const hidden = openIds.filter((id) => id !== activeSessionId);
    const excess = hidden.length - MAX_HIDDEN_SESSIONS;
    if (excess <= 0) return;
    hidden.slice(0, excess).forEach(evictSession);
  }, [openIds, activeSessionId, evictSession]);

  useEffect(() => {
    setSessionHost({ releaseSession, returnSession, releaseProject, returnProject, showProject });
    return () => setSessionHost(null);
  }, [releaseSession, returnSession, releaseProject, returnProject, showProject]);

  // The project on screen - the active session's, or the session-less view's.
  // It decides which of the extension's tools exist here.
  const viewProjectId =
    emptyProjectId ?? liveSessions.find((s) => s.id === activeSessionId)?.projectId ?? null;
  const useRailToolAvailability = railToolAvailabilityHook();
  const availability = useRailToolAvailability(viewProjectId);
  // What `toggleDock` (declared above) consults before honouring a tool's
  // toggle - the rail already hides the tab, this keeps its ⌘-digit in step.
  availabilityRef.current = availability;
  // A tool the project no longer has closes - only on a KNOWN "no": the
  // answer is null for a beat at startup, and closing then would clobber the
  // persisted open state on every launch.
  useEffect(() => {
    for (const [id, known] of Object.entries(availability)) {
      if (known === false) setOverlayOpen(id, false);
    }
  }, [availability, setOverlayOpen]);

  // Session cleanup (Settings → Sessions): the hourly auto-archive /
  // auto-delete sweep - in the ONE window main leases it to (the main window;
  // a project window never sweeps), skipping the session on screen here and
  // every session living in another window (lib/session/use-session-cleanup.ts).
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  useSessionCleanupSweep({
    ready: sessionsReady,
    sessionsRef: liveSessionsRef,
    activeSessionIdRef,
    externalIdsRef: releasedRef,
  });

  // Tell the alert layer which session is on screen in this window, so it can hush
  // alerts for the one the user is already watching. (Status derivation itself lives in each
  // session's surface / the detached window, where the live tab set is known.)
  useEffect(() => {
    setFocusedSession(activeSessionId);
  }, [activeSessionId]);
  // Record the session on screen as its project's last-viewed one, and that
  // project as the last one worked in - so switching projects in the rail comes
  // back to it, and the next app start reopens this workspace (routes/index.tsx).
  // `liveSessions` is a dependency for the freshly-launched case (the navigate
  // can land before the row syncs in); the writes themselves no-op when nothing
  // changed, so sync ticks are free.
  // A project window records its project's last-viewed session (so the project
  // lands on it when it returns to the main window) but never the LAST PROJECT
  // - that is the main window's startup target, and the project window must
  // not overwrite it.
  useEffect(() => {
    if (!activeSessionId) return;
    const projectId = liveSessions.find((s) => s.id === activeSessionId)?.projectId;
    if (projectId) {
      rememberProjectSession(projectId, activeSessionId);
      // A linked host session is remembered under the project it is listed as
      // too - clicking that project, or the next start, returns to it.
      const all = projectsCollection.toArray;
      const listed = listedProjectId(
        all.find((p) => p.id === projectId),
        all,
      );
      if (!scope && listed && listed !== projectId) rememberProjectSession(listed, activeSessionId);
      if (!scope) rememberLastProject(listed ?? projectId);
    }
  }, [activeSessionId, liveSessions, scope]);
  // The session-less workspace view counts too: a project whose sessions were
  // all deleted is still where the user was, and reopens there next start.
  useEffect(() => {
    if (emptyProjectId && !scope) rememberLastProject(emptyProjectId);
  }, [emptyProjectId, scope]);
  // A project window is titled after its project (main adds the environment
  // suffix in the OS chrome); the main window keeps index.html's title.
  const scopedProjectName = scope
    ? (liveProjects.find((p) => p.id === scope.projectId)?.name ?? scope.projectName)
    : null;
  useEffect(() => {
    if (scopedProjectName != null) document.title = scopedProjectName;
  }, [scopedProjectName]);
  // What runtime agents did while the app was closed - finished turns, agents
  // now waiting on you. Main answers the main window only, once.
  useEffect(() => rendererExtension().sessionView?.raiseAwayAlerts(), []);
  // A clicked alert (the extension's) opens its session in this window.
  useEffect(
    () =>
      rendererExtension().alerts?.attach((sessionId) =>
        navigate({ to: '/sessions/$sessionId', params: { sessionId } }),
      ),
    [navigate],
  );

  // Sessions this window owns but no longer keeps mounted (evicted from the LRU
  // cache) still have live shells streaming here - observe their agent (conversation)
  // terminal so even a long-backgrounded session keeps updating and alerting,
  // lifting the "only the mounted set" coverage cap. Mounted sessions are covered by
  // their own surface (across all tabs); released ones by their own window - both
  // are excluded here, and so is every session outside a project window's scope
  // (observing a shell another window owns gets no output, and the fallback
  // quiet timer would settle it idle and post a stray notification). Every
  // shell of the session's last layout is watched (`unmountedSessionPtyIds`),
  // not just the conversation tab - an agent in a second tab went unseen and
  // its working session settled idle. Keyed on the session and pty id SETS so
  // status writes don't re-arm the timers.
  const evictedObservedKey = hostedSessions
    .map((s) => s.id)
    .filter((id) => !openIds.includes(id) && !releasedIds.includes(id))
    .sort()
    .map((id) => {
      const layout = evictedLayouts.current.get(id)?.layout ?? persistedLayouts.current.get(id);
      return `${id}=${unmountedSessionPtyIds(id, layout).sort().join(',')}`;
    })
    .join(';');
  useEffect(() => {
    if (!evictedObservedKey) return;
    const cleanups = evictedObservedKey.split(';').map((entry) => {
      const [id, ptys] = entry.split('=');
      return observeSessionStatus(id, ptys ? ptys.split(',') : []);
    });
    return () => cleanups.forEach((off) => off());
  }, [evictedObservedKey]);

  // A session was deleted (from this menu, the project screen, or another device):
  // tear down whatever we still hold for it. A local open gets its shells killed and
  // its view dropped; an evicted one (view already unmounted, PTYs still running)
  // gets those shells killed; one living in its own window gets that window
  // destroyed (which kills its shells there); one launched but never opened has no
  // layout to walk, so its eagerly-spawned conversation/setup shells are killed by
  // their deterministic ids. Guarded to run only when something's actually gone,
  // so the resulting state update can't loop.
  const prevSessionIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    // Wait for the first real sync: an empty result before then means "not
    // loaded yet", not "everything was deleted" - acting on it would tear down
    // live shells for sessions that are about to arrive.
    if (!sessionsReady) return;
    const valid = new Set(hostedSessions.map((s) => s.id));
    // Never-opened deleted sessions first: they're in no tracked set, so the
    // teardown below can't see them. Diffed against the previous synced id set;
    // ids the tracked paths handle are skipped. Dispose is owner-guarded in
    // main, so a shell that actually lives elsewhere is never touched.
    const prevIds = prevSessionIdsRef.current;
    prevSessionIdsRef.current = valid;
    // A deleted runtime session's view state goes from this window (main has
    // already dropped its agent and log). Checked against every row, so a
    // project window's scope never reads as a deletion.
    if (prevIds) {
      const rows = new Set(liveSessions.map((s) => s.id));
      for (const id of prevIds) if (!rows.has(id)) rendererExtension().sessionView?.forget(id);
    }
    if (prevIds) {
      for (const id of prevIds) {
        if (valid.has(id) || openIds.includes(id) || releasedIds.includes(id)) continue;
        if (evictedLayouts.current.has(id)) continue;
        disposePooledTerminal(conversationPtyId(id));
        disposePooledTerminal(setupPtyId(id));
      }
    }
    const goneOpen = openIds.filter((id) => !valid.has(id));
    // Torn-off sessions come from main's list, which keeps a deleted one until
    // its window is gone - checked against EVERY row, not just the hosted ones,
    // so a project window never asks main to destroy another project's session.
    const allValid = new Set(liveSessions.map((s) => s.id));
    const goneReleased = external.sessionIds.filter((id) => !allValid.has(id));
    const goneEvicted = [...evictedLayouts.current.keys()].filter((id) => !valid.has(id));
    if (goneOpen.length === 0 && goneReleased.length === 0 && goneEvicted.length === 0) return;
    for (const id of goneOpen) {
      const layout = getSessionLayout(id);
      if (layout) allTabs(layout).forEach((t) => t.ptyId && disposePooledTerminal(t.ptyId));
    }
    for (const id of goneEvicted) {
      // The pooled xterms went at eviction; this kills the still-running PTYs.
      const { layout } = evictedLayouts.current.get(id)!;
      allTabs(layout).forEach((t) => t.ptyId && disposePooledTerminal(t.ptyId));
      dropEvicted(id);
    }
    // A torn-off session: destroy its window. (A session released because its
    // PROJECT is in a window is handled with the project below - main ignores
    // a destroy for a session without a window of its own.)
    for (const id of goneReleased) window.api?.session?.destroy(id);
    if (goneOpen.length) setOpenIds((prev) => prev.filter((id) => valid.has(id)));
  }, [
    hostedSessions,
    liveSessions,
    external.sessionIds,
    openIds,
    releasedIds,
    sessionsReady,
    dropEvicted,
  ]);

  // A project was deleted while open in its own window - from this window, or
  // from the project window itself (its own project is never external to it,
  // so it watches its scope instead): close that window destructively. Its
  // sessions went with the project, so nothing comes back.
  const prevProjectIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!sessionsReady) return;
    const valid = new Set(liveProjects.map((p) => p.id));
    const prev = prevProjectIdsRef.current;
    prevProjectIdsRef.current = valid;
    if (!prev) return;
    for (const id of external.projectIds) {
      if (prev.has(id) && !valid.has(id)) window.api?.project?.destroy(id);
    }
    if (scope && prev.has(scope.projectId) && !valid.has(scope.projectId)) {
      window.api?.project?.destroy(scope.projectId);
    }
  }, [liveProjects, sessionsReady, external.projectIds, scope]);

  // Forget the explorer state of deleted sessions, once the first sync is in
  // (an empty pre-sync list would read as "all deleted").
  useEffect(() => {
    if (!sessionsReady) return;
    const valid = new Set(liveSessions.map((s) => s.id));
    setExplorerOpenKeys((prev) => pruneExplorerOpen(prev, valid));
  }, [liveSessions, sessionsReady, setExplorerOpenKeys]);

  // Keep the active session's chrome (rail + session sidebar) mounted even while
  // it's released into another window - so the user can still switch sessions -
  // by rendering it here even though it's no longer in `openIds`. Its content area
  // shows the "open elsewhere" message instead of mounting its terminals.
  // Rendered in a STABLE order (sorted by id), decoupled from `openIds`' LRU
  // order: rendering in LRU order made React MOVE the just-activated view's DOM
  // subtree (the activation effect pushes its id to the end), and an insertBefore
  // of the visible subtree restarts animations, blanks canvases and visibly
  // flashes the explorer/tab strips on every session switch.
  const idsToRender = (
    activeSessionId && !openIds.includes(activeSessionId)
      ? [...openIds, activeSessionId]
      : [...openIds]
  ).sort();
  if (idsToRender.length === 0 && !emptyProjectId && !projectless) return null;
  // Hold off mounting any session until persisted layouts have loaded, so a
  // session's first mount seeds from disk rather than a fresh (empty) layout -
  // and until main has said which sessions live in other windows, so a reload
  // can't mount a session whose shells another window owns. Both reads are
  // local and fast (milliseconds after launch).
  if (!layoutsReady || !externalReady) return null;

  return (
    <div
      className={activeSessionId || emptyProjectId || projectless ? 'fixed inset-0 z-20' : 'hidden'}
    >
      {idsToRender.map((id) => (
        <div key={id} className={id === activeSessionId ? 'contents' : 'hidden'}>
          <WorkspaceView
            sessionId={id}
            user={user}
            isActiveSession={id === activeSessionId}
            released={releasedIds.includes(id)}
            releasedIds={releasedIds}
            dockPanels={dockPanels}
            openOverlay={openOverlay}
            onToggleDock={toggleDock}
            bottomPanelOpen={bottomPanelOpen}
            onToggleBottomPanel={toggleBottomPanel}
            dockWidth={dockWidth}
            onDockWidthChange={setDockWidth}
            explorerOpen={explorerOpenKeys.includes(id)}
            // Seed priority: a session returning from its own window brings the
            // most current layout; an evicted one re-seeds its pre-eviction
            // layout (live PTY ids intact); in a project window, the layout the
            // session was moved here with (its shells adopted with a replay);
            // otherwise what was persisted last run. Only read at the
            // provider's first mount, then consumed.
            seedLayout={
              returnedLayouts.current.get(id) ??
              evictedLayouts.current.get(id)?.layout ??
              takeSeedLayout(id) ??
              persistedLayouts.current.get(id)
            }
            onSeedConsumed={consumeSeedLayout}
            projects={liveProjects}
            allSessions={liveSessions}
          />
        </div>
      ))}
      {/* The session-less view isn't tied to any mounted session - rendered on
        top only while its route is active, torn down on navigation (it holds no
        terminals, so unmounting loses nothing). */}
      {emptyProjectId && (
        <WorkspaceView
          key={`project:${emptyProjectId}`}
          sessionId={null}
          projectId={emptyProjectId}
          user={user}
          isActiveSession
          // The session-less view of a project open in another window shows
          // the placeholder too, not a workspace on its folder.
          released={external.projectIds.includes(emptyProjectId)}
          releasedIds={releasedIds}
          dockPanels={dockPanels}
          openOverlay={openOverlay}
          onToggleDock={toggleDock}
          bottomPanelOpen={bottomPanelOpen}
          onToggleBottomPanel={toggleBottomPanel}
          dockWidth={dockWidth}
          onDockWidthChange={setDockWidth}
          explorerOpen={explorerOpenKeys.includes(explorerKey(null, emptyProjectId)!)}
          onSeedConsumed={consumeSeedLayout}
          projects={liveProjects}
          projectsReady={projectsReady}
          allSessions={liveSessions}
        />
      )}
      {/* The no-project workspace: no session, no project - its empty state
        adds the first project and the view heals into it (workspace-chrome). */}
      {projectless && (
        <WorkspaceView
          key="project:none"
          sessionId={null}
          projectId={null}
          user={user}
          isActiveSession
          releasedIds={releasedIds}
          dockPanels={dockPanels}
          openOverlay={openOverlay}
          onToggleDock={toggleDock}
          bottomPanelOpen={bottomPanelOpen}
          onToggleBottomPanel={toggleBottomPanel}
          dockWidth={dockWidth}
          onDockWidthChange={setDockWidth}
          explorerOpen={false}
          onSeedConsumed={consumeSeedLayout}
          projects={liveProjects}
          projectsReady={projectsReady}
          allSessions={liveSessions}
        />
      )}
    </div>
  );
}
