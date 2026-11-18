import { useNavigate } from '@tanstack/react-router';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Monitor,
  Plus,
  Search,
} from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Logo } from '@renderer/components/logo';
import { DevBadge, TitleBar } from '@renderer/components/title-bar';
import { StatusDot } from '@renderer/components/status-dot';
import { HoverScrollText } from '@renderer/components/hover-scroll-text';
import { TopBarActions } from '@renderer/routes/_app/-components/top-bar-actions';
import { WorkspaceLayoutProvider } from '@renderer/routes/_app/-components/workspace/workspace-context';
import { ReviewScopeProvider } from '@renderer/lib/review/review-scope-provider';
import {
  WorkspaceStatusBar,
  WorkspaceSurface,
} from '@renderer/routes/_app/-components/workspace/workspace-surface';
import { WorkspaceShortcuts } from '@renderer/routes/_app/-components/workspace/workspace-shortcuts';
import {
  SessionContextMenu,
  SessionMenu,
} from '@renderer/routes/_app/-components/workspace/session-menu';
import { GitStatusProvider } from '@renderer/routes/_app/-components/workspace/git-status-provider';
import { onOpenToolRequest } from '@renderer/lib/workspace/open-tool';
import { VerticalTabsPanel } from '@renderer/routes/_app/-components/workspace/vertical-tabs-panel';
import { SessionRowDetail } from '@renderer/routes/_app/-components/workspace/session-row-detail';
import {
  NewSessionDialog,
  type NewSessionLaunch,
  type SessionEdits,
} from '@renderer/routes/_app/-components/new-session-dialog';
import { useSortableList } from '@renderer/lib/use-sortable-list';
import { useSharedScroll } from '@renderer/lib/workspace/shared-scroll';
import { Sortable } from '@renderer/components/ui/sortable';
import { RailNav } from '@renderer/routes/_app/-components/workspace/rail-nav';
import { ProjectCountPill } from '@renderer/routes/_app/-components/workspace/project-count-pill';
import { ProjectContextMenu } from '@renderer/components/project-menu';
import { EditProjectDialog } from '@renderer/routes/_app/-components/edit-project-dialog';
import { confirmProjectDeletion } from '@renderer/lib/project-delete';
import {
  bringProjectToWindow,
  deleteProject,
  editProject,
  openProjectInWindow,
  reorderProject,
} from '@renderer/lib/project-actions';
import { useExternalWindows } from '@renderer/lib/workspace/external-windows';
import { getProjectScope, scopedSessions } from '@renderer/lib/workspace/project-scope';
import { rendererExtension } from '@renderer/lib/extension/registry';
import type { RailTool, RailToolContext } from '@renderer/lib/extension/types';
import { sortProjects } from '@renderer/lib/project-order';
import { isListedProject, listedProjectId, projectFamily } from '@renderer/lib/projects/linked';
import { isLiveSessionStatus, projectSessionMeta } from '@renderer/lib/session/counts';
import { liveBandClass, projectLiveBand, sessionLiveBand } from '@renderer/lib/session/live-band';
import { useEdgeResize } from '@renderer/lib/use-edge-resize';
import { usePersistedState } from '@renderer/lib/use-persisted-state';
import { getCommandDockState, getSessionLayout } from '@renderer/lib/session/bridge';
import {
  agentSessionsCollection,
  projectsCollection,
  type AgentSession,
  type Project,
} from '@renderer/lib/collections';
import {
  runsInView,
  sessionAgentLabel,
  sessionTerminalCommand,
} from '@renderer/lib/session/templates';
import { launchSession } from '@renderer/lib/session/launch-session';
import { confirmSessionDeletion } from '@renderer/lib/session/worktree-delete';
import { lastProject, lastProjectSession } from '@renderer/lib/last-project-session';
import {
  afterProjectDeleted,
  noProjectTarget,
  pickProjectSession,
  projectOpenTarget,
  startupTarget,
} from '@renderer/lib/startup-target';
import { goToTarget } from '@renderer/lib/workspace/open-target';
import { requestNewProject } from '@renderer/lib/projects/new-project-request';
import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  PANEL_ORDER,
  dockDefaultSizes,
  type DockStackPanelId,
  type RailTabId,
} from '@renderer/lib/workspace/dock-state';
import { useVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import {
  focusPendingRegion,
  plainArrowStep,
  requestRegionFocus,
  stepFocusItem,
} from '@renderer/lib/workspace/focus-regions';
import { openSearchEverywhere } from '@renderer/lib/search/open-search';
import { requestWorktreeReveal } from '@renderer/lib/worktree-reveal';
import { useSessionDiffStats } from '@renderer/lib/session/use-session-diff-stats';
import { cn, joinPath } from '@renderer/lib/utils';
import { isWithin, relativeTo } from '@renderer/lib/path-within';
import { GIT_REPO_TOOL, RepoChoiceContext, useRepoChoice } from '@renderer/lib/git/repo-choice';
import { HostBadgeSlot } from '@renderer/components/host-badge-slot';
import { sessionViewBridge } from '@renderer/lib/session/view-bridge';

export type WorkspaceUser = { id: string; email: string; name?: string | null };

type SessionStatus = AgentSession['status'];

const IDLE_PILL = {
  label: 'Idle',
  className: 'border-border-strong bg-transparent text-foreground-muted',
  dot: 'bg-foreground-subtle',
};
const STATUS_PILL: Record<SessionStatus, { label: string; className: string; dot: string }> = {
  active: {
    label: 'Running',
    className: 'border-success/30 bg-success/[0.15] text-success',
    dot: 'bg-success',
  },
  'needs-input': {
    label: 'Needs input',
    className: 'border-warning/40 bg-warning/[0.12] text-warning',
    dot: 'bg-warning',
  },
  // Stopped while the user was away, not looked at yet (session/attention).
  finished: {
    label: 'Finished',
    className: 'border-info/40 bg-info/[0.12] text-info',
    dot: 'bg-info',
  },
  idle: IDLE_PILL,
  // Legacy: a session whose agent had exited used to be 'done'; it's idle now.
  done: IDLE_PILL,
  archived: {
    label: 'Archived',
    className: 'border-border bg-muted text-foreground-muted',
    dot: 'bg-foreground-subtle',
  },
};

const SIDEBAR_DOT: Record<SessionStatus, string> = {
  active: 'bg-success',
  'needs-input': 'bg-warning',
  finished: 'bg-info',
  idle: 'bg-foreground-subtle',
  done: 'bg-foreground-subtle',
  archived: 'bg-foreground-subtle',
};

/** Sidebar "Archived" group open/closed - persisted, shared across sessions. */
const ARCHIVED_OPEN_KEY = 'double0-sidebar-archived-open';

/** Shared header for a dock panel: an uppercase mono label + an optional action.
 * The label tints primary while the panel (a `group/region`) holds KEYBOARD
 * focus - the "you are here" of the focus-direction shortcuts. Keyed on the
 * keyboard focus mode (`region-kbd-focus`, see globals.css), not on
 * `:focus-within`: a mouse click also focuses the row it lands on for the
 * instant before the terminal takes over, which read as the title blinking on
 * every click. */
function PanelHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-surface pb-2 pl-3 pr-2.5 pt-2.5">
      <span className="font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold tracking-[1px] text-foreground-subtle region-kbd-focus:text-primary">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Shown in a session's content column (in place of its tabs/terminals) when the
 * session is open in a separate window. The surrounding chrome - top bar, project
 * rail, session sidebar - stays mounted, so the user can still switch sessions.
 */
function SessionElsewhere({
  onShowWindow,
  onBringBack,
}: {
  onShowWindow: () => void;
  onBringBack: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 bg-background text-foreground">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border-strong bg-surface">
        <Monitor className="size-6 text-primary" />
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium">This session is open in a separate window.</p>
        <p className="max-w-sm text-xs text-foreground-muted">
          Its terminals are running there. Pick another session from the sidebar, or bring this one
          back here - closing its window also returns it, with everything intact.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onShowWindow}
          className="rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Show its window
        </button>
        <button
          type="button"
          onClick={onBringBack}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Bring it back here
        </button>
      </div>
    </div>
  );
}

/**
 * The project twin of `SessionElsewhere` (design: `Screen/Workspace - Project
 * in Window`): the project - every session of it - lives in a window of its
 * own. The chrome stays, so the user can switch projects; the buttons act on
 * the project's window.
 */
function ProjectElsewhere({
  onShowWindow,
  onBringBack,
}: {
  onShowWindow: () => void;
  onBringBack: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 bg-background text-foreground">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border-strong bg-surface">
        <Monitor className="size-6 text-primary" />
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium">This project is open in a separate window.</p>
        <p className="max-w-sm text-xs text-foreground-muted">
          Its sessions and terminals are running there. Pick another project, or bring this one back
          here - closing its window also returns it, with everything intact.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onShowWindow}
          className="rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Show its window
        </button>
        <button
          type="button"
          onClick={onBringBack}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Bring it back here
        </button>
      </div>
    </div>
  );
}

/**
 * One session's full-window view: the top bar, icon rail, tool dock and session
 * sidebar around the workspace surface. Pure chrome - session lifecycle (which
 * views are mounted, released, evicted) lives in `WorkspaceHost`.
 */
/**
 * Memoized: the host keeps up to six sessions mounted and re-renders on every
 * navigation, so without it a session switch re-rendered every hidden view's
 * whole chrome. The host's props are stable (memoized lists, callbacks).
 */
/**
 * The open dock panels stacked in a vertical group. Their sizes are
 * remembered per set of open panels (`useDefaultLayout`, the same storage the
 * library's `autoSaveId` used before v4).
 */
function DockStack({
  openPanels,
  defaults,
  renderPanel,
}: {
  openPanels: DockStackPanelId[];
  defaults: number[];
  renderPanel: (id: DockStackPanelId) => ReactNode;
}) {
  const layout = useDefaultLayout({ id: 'workspace-dock-v', panelIds: openPanels });
  return (
    <Group
      orientation="vertical"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="min-h-0 flex-1"
    >
      {openPanels.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && (
            <Separator
              className={cn(
                'relative h-1 cursor-row-resize bg-border transition-colors',
                'data-[separator=hover]:bg-primary/60 data-[separator=active]:bg-primary',
              )}
            />
          )}
          <Panel
            id={id}
            defaultSize={`${defaults[i]}%`}
            minSize="12%"
            className="flex min-h-0 flex-col"
          >
            {renderPanel(id)}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

export const WorkspaceView = memo(function WorkspaceView({
  sessionId,
  projectId = null,
  user,
  isActiveSession,
  released = false,
  releasedIds,
  seedLayout,
  onSeedConsumed,
  projects,
  allSessions,
  dockPanels,
  openOverlay,
  onToggleDock,
  bottomPanelOpen,
  onToggleBottomPanel,
  dockWidth,
  onDockWidthChange,
  explorerOpen,
  projectsReady = true,
}: {
  /** The session shown - or null for the session-less workspace of `projectId`. */
  sessionId: string | null;
  /** Scopes the view when `sessionId` is null: a project with no sessions yet
   * (the /workspace/$projectId route) keeps the chrome + an empty state. */
  projectId?: string | null;
  user: WorkspaceUser;
  isActiveSession: boolean;
  /** This session is open in another window: show the placeholder, not its terminals. */
  released?: boolean;
  /** All sessions open in other windows, to flag (and lock dragging on) in the sidebar. */
  releasedIds: string[];
  /** Layout to restore when a torn-off session returns; default fresh otherwise. */
  seedLayout?: WorkspaceLayout;
  /** Tells the host the seed was consumed (the provider mounted) - see WorkspaceHost. */
  onSeedConsumed: (sessionId: string) => void;
  /** Hoisted to WorkspaceHost (queried once) and passed down - avoids N duplicate subscriptions. */
  projects: Project[];
  allSessions: AgentSession[];
  /** Open stacked dock panels, lifted to the host so the choice is shared across sessions. */
  dockPanels: DockStackPanelId[];
  /** The extension tool whose exclusive overlay is up, if any - host-lifted + persisted. */
  openOverlay: string | null;
  /** One toggler for every rail tab; the open/combine rules live in the host. */
  onToggleDock: (id: RailTabId) => void;
  /** The bottom panel (the extension's) - host-lifted + persisted. */
  bottomPanelOpen: boolean;
  /** Toggle the bottom panel (the rail's play button, a key). */
  onToggleBottomPanel: () => void;
  /** Dock width (px) + setter, lifted to the host so it's shared/persisted across sessions. */
  dockWidth: number;
  onDockWidthChange: (width: number) => void;
  /** File-explorer sidebar open state, lifted to the host (toggled via `files`). */
  explorerOpen: boolean;
  /** The projects collection has loaded - until then no project is not "none yet". */
  projectsReady?: boolean;
}) {
  const navigate = useNavigate();
  // This view's root: focus moves (⇧⌘Arrow, the ↑/↓ hand-off below) are scoped
  // to it, since the host keeps other sessions' views mounted-hidden with the
  // same panel markup.
  const viewRef = useRef<HTMLDivElement>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // The edit dialog (opened from the kebab menu). Open flag and target are
  // separate so the form keeps its session through the close animation, and
  // state-driven so opening from a Radix onSelect is safe (see
  // radix-menu-confirmdialog-freeze).
  const [editSessionOpen, setEditSessionOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<AgentSession | null>(null);
  // Pre-selected session root for the New Session dialog ("New session here" on
  // an explorer folder); null when opened normally (project root).
  const [newSessionRoot, setNewSessionRoot] = useState<string | null>(null);
  // Right-clicking a session row opens the same menu as its kebab, anchored at
  // the pointer. Only the id is stored - the session is looked up live at
  // render so the menu never acts on a stale row.
  const [sessionCtxMenu, setSessionCtxMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  // Right-clicking a project row opens `Menu/Project` the same way; its Edit
  // item opens the shared project dialog (state-driven, see the session one).
  const [projectCtxMenu, setProjectCtxMenu] = useState<{
    projectId: string;
    x: number;
    y: number;
  } | null>(null);
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  // Projects living in a window of their own (main's view of it for THIS
  // window): their rows wear the monitor glyph, a click raises that window,
  // and navigating to one shows the project placeholder. A project window
  // itself is scoped to one project (lib/workspace/project-scope.ts).
  const externalProjectIds = useExternalWindows().projectIds;
  const scope = getProjectScope();
  const [archivedOpen, setArchivedOpen] = usePersistedState<boolean>(
    ARCHIVED_OPEN_KEY,
    (raw) => raw !== '0',
    (open) => (open ? '1' : '0'),
  );
  // Vertical tabs (Settings → General): gates the rail's Tabs tool + its dock
  // panel here; the tab strips hide inside WorkspaceSurface.
  const verticalTabs = useVerticalTabs();
  // At most one exclusive overlay is open (the host's toggler guarantees it).
  const overlayOpen = openOverlay !== null;
  // Rail tools the extension registered: none in the core build. `openTool` is
  // the one whose overlay is up, if any.
  const railTools = rendererExtension().railTools;
  // The git provider: the extension's full client, else the status-only one.
  // Both fill the status context the explorer, the editor gutter and the repo
  // picker read.
  const GitProviderImpl = rendererExtension().git?.Provider ?? GitStatusProvider;
  // The tool that shows a worktree's branch (a session row's worktree icon).
  const worktreeTool = railTools.find((t) => t.showsWorktrees);
  // The extension's bottom dock - none in the core build.
  const BottomPanel = rendererExtension().bottomPanel?.Dock;
  const toolOpen = (id: string): boolean => id === openOverlay;
  const openTool = railTools.find((t) => toolOpen(t.id));
  // A tool opened from another one's panel (and any other opener without the
  // dock): only the visible session acts, and only when the tool is shut -
  // onToggleDock toggles.
  const openOverlayRef = useRef(openOverlay);
  openOverlayRef.current = openOverlay;
  useEffect(() => {
    if (!isActiveSession) return;
    return onOpenToolRequest((id) => {
      if (openOverlayRef.current !== id) onToggleDock(id);
    });
  }, [isActiveSession, onToggleDock]);
  // Consume-on-commit: once this view's layout provider has actually mounted
  // (it reads `seedLayout` in its first render; a released session doesn't mount
  // it), tell the host so the seed can't be re-read by any later mount. Runs
  // after commit - a render React discards (transition/suspense) consumes
  // nothing - and is idempotent under StrictMode's double effects.
  useEffect(() => {
    if (!released && sessionId) onSeedConsumed(sessionId);
  }, [released, sessionId, onSeedConsumed]);

  // Hand-rolled horizontal resize of the whole dock (pixel width - the convention
  // for a sidebar). The shared width (held + persisted in the host) updates live.
  const { resizing: dockResizing, startResize: startDockResize } = useEdgeResize({
    min: DOCK_MIN_WIDTH,
    max: DOCK_MAX_WIDTH,
    onResize: onDockWidthChange,
  });

  const session = useMemo(
    () => allSessions.find((s) => s.id === sessionId),
    [allSessions, sessionId],
  );
  // The project this view is scoped to: the session's - or, with no session
  // (the session-less /workspace route), the one passed in directly.
  const viewProjectId = session ? session.projectId : projectId;
  const project = useMemo(
    () => projects.find((p) => p.id === viewProjectId),
    [projects, viewProjectId],
  );
  // The project the sidebar LISTS: a host project made for a project of
  // this machine is listed under that one (lib/projects/linked.ts) - with
  // every linked host project's sessions. `project` stays the session's own:
  // cwd, git and the explorer read it.
  const listProjectId = listedProjectId(project, projects) ?? viewProjectId;
  const listProject = useMemo(
    () => projects.find((p) => p.id === listProjectId) ?? project,
    [projects, listProjectId, project],
  );
  // No project to show: the no-project workspace (/workspace - none exists
  // yet) or a session-less view whose project was deleted. A session needs a
  // project, so this view offers New project, never New session
  // (a private plan). A project just created is in the
  // collection (optimistic insert) before this view's list has it: that is
  // not "no project" - read as one, the view would redirect away from it.
  const noProject =
    sessionId == null && !project && !(projectId != null && projectsCollection.has(projectId));
  // A project window hosts its linked host projects' sessions too
  // (project-scope.ts), so it lists them like the main window does.
  const family = useMemo(() => projectFamily(listProjectId, projects), [listProjectId, projects]);
  const projectOf = useCallback(
    (s: AgentSession) => projects.find((p) => p.id === s.projectId),
    [projects],
  );
  // What a torn-off session's window tells main its project is: the LISTED
  // one, so closing it returns the session to that project's window and that
  // window may settle it (main's window-ownership.ts knows no links).
  const tornOffProjectId = (s: AgentSession): string | null =>
    listedProjectId(projectOf(s), projects) ?? s.projectId;
  // "+" starts a session in the listed project (its placement offers the host
  // again) - unless a folder of the viewed session's own project was picked
  // ("New session here" in the explorer), which only that project holds.
  const newSessionProject = newSessionRoot ? project : listProject;

  // A session/project picked with ↑/↓ in a dock panel swaps the visible view
  // (each session has its own WorkspaceView), taking the focused row with it.
  // The panel filed a re-focus request before navigating; the view that just
  // became active honours it here (see lib/workspace/focus-regions.ts).
  useEffect(() => {
    if (!isActiveSession) return;
    return focusPendingRegion(viewRef.current);
  }, [isActiveSession, sessionId, viewProjectId]);

  // All sessions in this project, in manual order (ascending sortOrder) - never
  // status, so a status change (active / needs-input / idle) leaves the list in
  // place. Only an explicit drag reorders it. Archived is split out below by filter.
  const projectSessions = useMemo(
    () =>
      allSessions
        .filter((s) => s.projectId != null && family.has(s.projectId))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allSessions, family],
  );

  // Sidebar diff stats: +added/-removed lines per live session (its uncommitted
  // work vs HEAD). One window-wide store; only the active view with its
  // Sessions panel open keeps the folders watched, every view reads the result.
  const statsFolders = useMemo(
    () => [
      ...new Set(
        projectSessions
          .filter((s) => s.status !== 'archived')
          .map((s) => s.rootPath ?? s.worktreePath ?? projectOf(s)?.path ?? null)
          .filter((f): f is string => f != null),
      ),
    ],
    [projectSessions, projectOf],
  );
  // Every mounted session view renders its own Projects / Sessions lists:
  // share their scroll offsets so a switch never jumps the list.
  const projectsScrollRef = useSharedScroll('projects', isActiveSession);
  const sessionsScrollRef = useSharedScroll(`sessions:${listProjectId ?? ''}`, isActiveSession);
  const sessionStats = useSessionDiffStats(
    statsFolders,
    isActiveSession && !released && !overlayOpen && dockPanels.includes('sessions'),
  );

  // Persist a drag-reorder: drop `draggedId` at `targetIndex` in the active list
  // (0 = top, length = bottom; the index counts the dragged row itself). We slot
  // it at the midpoint sortOrder between its new neighbours - a local write, no
  // renumbering of the rest.
  const reorderSession = useCallback(
    (draggedId: string, targetIndex: number) => {
      const active = allSessions
        .filter((s) => s.projectId != null && family.has(s.projectId))
        .filter((s) => s.status !== 'archived')
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const from = active.findIndex((s) => s.id === draggedId);
      if (from === -1) return;
      // Dropped back into its own slot (just above or below itself) - nothing to do.
      if (targetIndex === from || targetIndex === from + 1) return;
      const rest = active.filter((s) => s.id !== draggedId);
      // targetIndex counts the dragged row; discount it once the drop is below it.
      const gap = targetIndex > from ? targetIndex - 1 : targetIndex;
      const above = rest[gap - 1];
      const below = rest[gap];
      let order: number;
      if (!above && !below) return;
      else if (!above) order = below.sortOrder - 1;
      else if (!below) order = above.sortOrder + 1;
      else order = (above.sortOrder + below.sortOrder) / 2;
      agentSessionsCollection.update(draggedId, (d) => {
        d.sortOrder = order;
      });
    },
    [allSessions, family],
  );

  // Sessions sidebar drag (dnd-kit): reorder within the active list, or release
  // beyond the window to tear the session into its own window (its shells stay
  // alive for the new window to adopt). Released sessions still reorder - an
  // outside drop just does nothing for them (they already have a window).
  const activeSessionIds = useMemo(
    () => projectSessions.filter((s) => s.status !== 'archived').map((s) => s.id),
    [projectSessions],
  );
  const sessionSort = useSortableList({
    items: activeSessionIds,
    onReorder: reorderSession,
    onDropOutside: (id) => {
      if (releasedIds.includes(id)) return;
      const s = projectSessions.find((x) => x.id === id);
      if (!s) return;
      window.api?.session?.dropExternal({
        kind: 'session',
        sessionId: s.id,
        projectId: tornOffProjectId(s),
        label: s.label,
        projectName: projectOf(s)?.name ?? null,
        layout: getSessionLayout(s.id),
        cwd: s.rootPath ?? s.worktreePath ?? projectOf(s)?.path ?? null,
        commandDock: getCommandDockState(s.id),
      });
    },
  });

  // Pinned first, then manual order - drag a row in the Projects panel to change it.
  // Host projects listed under a project of this machine are not rows of their own.
  const railProjects = useMemo(
    () => sortProjects(projects.filter((p) => isListedProject(p, projects))),
    [projects],
  );
  const projectSort = useSortableList({
    items: railProjects.map((p) => p.id),
    onReorder: (id, index) => reorderProject(railProjects, id, index),
  });

  // Per-project session rollup for the Projects panel: a count badge (live
  // sessions only - archived ones don't count), plus whether it has a running /
  // needs-input session (drives the status dot).
  // A linked host project's sessions count for the project they are listed under.
  const projectMeta = useMemo(
    () =>
      projectSessionMeta(
        allSessions.map((s) => {
          const owner = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined;
          const listed = listedProjectId(owner, projects);
          return listed && listed !== s.projectId ? { ...s, projectId: listed } : s;
        }),
      ),
    [allSessions, projects],
  );

  // Agents working right now in this project - the rail's Sessions count
  // bubble. Scoped to the project the rail's Sessions panel actually lists, so
  // the bubble and the list below it always agree.
  const runningSessions = useMemo(
    () => projectSessions.filter((s) => s.status === 'active').length,
    [projectSessions],
  );

  // The sessions a rail tool lists (every session of every project). A project window lists the sessions it hosts only: the others
  // live in the main window, which has its own tools.
  const toolSessions = useMemo(
    () => scopedSessions(allSessions, scope, projects),
    [allSessions, scope, projects],
  );

  // On the session-less view of a project that does have sessions (e.g. history
  // back after creating the first one) - swap to its last-viewed session (else
  // its top one) instead.
  useEffect(() => {
    if (sessionId != null || projectSessions.length === 0) return;
    const lastId = viewProjectId ? lastProjectSession(viewProjectId) : null;
    const target = pickProjectSession(projectSessions, lastId);
    if (!target) return;
    void navigate({ to: '/sessions/$sessionId', params: { sessionId: target.id }, replace: true });
  }, [sessionId, projectSessions, viewProjectId, navigate]);

  // The no-project view only ever shows with no project at all: once one
  // exists (created, synced in, or the deleted one had siblings) open it like
  // startup does. A project window's project going away closes the window
  // (WorkspaceHost) - it never looks for another.
  useEffect(() => {
    if (!noProject || !projectsReady || !isActiveSession || scope) return;
    const target = noProjectTarget(
      projectId,
      projects,
      allSessions,
      lastProject(),
      lastProjectSession,
    );
    if (target) goToTarget(navigate, target, { replace: true });
  }, [
    noProject,
    projectsReady,
    isActiveSession,
    scope,
    projects,
    allSessions,
    projectId,
    navigate,
  ]);

  // cwd: home when the session has no project (null); otherwise wait for the
  // project to resolve (undefined) so the shell/git don't race the project load.
  // A subfolder root (already worktree-mapped at launch) beats the worktree path.
  // The session-less view runs on the project dir (its git surfaces still work).
  const cwd = !session
    ? project
      ? (project.path ?? null)
      : undefined
    : session.rootPath
      ? session.rootPath
      : session.worktreePath
        ? session.worktreePath
        : session.projectId == null
          ? null
          : project
            ? (project.path ?? null)
            : undefined;
  // A folder-of-repos view (a private plan): the git
  // surfaces read the child repo picked in the git repo picker, from the repos
  // the integrations allow (an extension's tool keeps a pick of its own).
  // Terminals, files and the explorer tree keep `cwd`. Selecting a session
  // goes back to its own repo (the pick lasts one visit).
  const gitRepo = useRepoChoice(cwd, GIT_REPO_TOOL, project?.path, sessionId ?? viewProjectId);
  const repoChoices = useMemo(() => ({ [GIT_REPO_TOOL]: gitRepo }), [gitRepo]);

  if (sessionId != null && !session) {
    return (
      <div className="relative flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
        <TitleBar className="absolute inset-x-0 top-0" />
        <p className="text-sm text-foreground-muted">Session not found.</p>
        <button
          type="button"
          onClick={() =>
            goToTarget(
              navigate,
              startupTarget(projects, allSessions, lastProject(), lastProjectSession),
            )
          }
          className="rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Back to workspace
        </button>
      </div>
    );
  }

  // The folder a session runs in (subfolder root > worktree > project dir) - for
  // any row in the list, not just the one being viewed (tear-off payloads,
  // "Open in editor"). The current session's `cwd` below adds load-state handling.
  const sessionFolder = (s: AgentSession): string | null =>
    s.rootPath ?? s.worktreePath ?? projectOf(s)?.path ?? null;

  // Sidebar chip label for a subfolder-rooted session: the root relative to its
  // worktree/project dir; a root outside both (shouldn't happen) shows its basename.
  const sessionRootLabel = (s: AgentSession): string | null => {
    if (!s.rootPath) return null;
    const base = s.worktreePath ?? projectOf(s)?.path;
    const rel = base && isWithin(s.rootPath, base) ? relativeTo(s.rootPath, base) : '';
    return rel || (s.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? s.rootPath);
  };

  // Tear a session into its own window from the menu - same payload as a drag
  // tear-off: main opens a window and tells us to release it here (its shells
  // stay alive for the new window to adopt). A never-opened session has no live
  // layout (null); main routes its eagerly-spawned shells by id instead.
  function openInSeparateWindow(s: AgentSession) {
    window.api?.session?.dropExternal({
      kind: 'session',
      sessionId: s.id,
      projectId: tornOffProjectId(s),
      label: s.label,
      projectName: projectOf(s)?.name ?? null,
      layout: getSessionLayout(s.id),
      cwd: sessionFolder(s),
      commandDock: getCommandDockState(s.id),
    });
  }

  // A session lives in another window either on its own (a torn-off session)
  // or with its whole project (a project window): raising / bringing back acts
  // on whichever window that is.
  // The project window a project's sessions live in: its own, or the one of
  // the project it is listed under (lib/projects/linked.ts) - null = none.
  const externalWindowOf = (projectId: string | null | undefined): string | null => {
    if (projectId == null) return null;
    if (externalProjectIds.includes(projectId)) return projectId;
    const listed = listedProjectId(
      projects.find((p) => p.id === projectId),
      projects,
    );
    return listed && externalProjectIds.includes(listed) ? listed : null;
  };
  function raiseSessionWindow(s: AgentSession) {
    const win = externalWindowOf(s.projectId);
    if (win) window.api?.project?.focusWindow(win);
    else window.api?.session?.focusWindow(s.id);
  }
  function bringToWindow(s: AgentSession) {
    const win = externalWindowOf(s.projectId);
    if (win) bringProjectToWindow(win);
    else window.api?.session?.bringBack(s.id);
  }

  // The row's worktree icon: open the tool that shows worktrees on that
  // session, at its worktree branch. The reveal request survives the
  // navigation to another row's session - its git provider consumes it once
  // it's the active one with the overlay up (see lib/worktree-reveal.ts).
  // A released session's workspace lives in another window; just raise it.
  function openWorktreeTool(s: AgentSession) {
    if (releasedIds.includes(s.id)) {
      raiseSessionWindow(s);
      return;
    }
    const folder = sessionFolder(s);
    if (folder) requestWorktreeReveal(folder);
    if (worktreeTool && !toolOpen(worktreeTool.id)) onToggleDock(worktreeTool.id);
    if (s.id !== sessionId) {
      navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
    }
  }

  // Removing it from the collection is the source of truth; WorkspaceHost reacts
  // to drop its view and kill its shells (or destroy its window). If we're deleting
  // the session we're viewing, switch to the next one in this project - when it was
  // the last, stay in the workspace on the project's session-less view.
  async function deleteSession(s: AgentSession) {
    if (!(await confirmSessionDeletion(s))) return;
    agentSessionsCollection.delete(s.id);
    if (s.id !== session?.id) return;
    const next = projectSessions.find((x) => x.id !== s.id);
    if (next) navigate({ to: '/sessions/$sessionId', params: { sessionId: next.id } });
    else if (listProject)
      navigate({ to: '/workspace/$projectId', params: { projectId: listProject.id } });
    else
      goToTarget(
        navigate,
        startupTarget(
          projects,
          allSessions.filter((x) => x.id !== s.id),
          lastProject(),
          lastProjectSession,
        ),
      );
  }

  // Apply the edit dialog's changes. The worktree/root are fixed at creation, so
  // only the rename + terminal-startup fields are written; live queries propagate
  // them everywhere (sidebar label, new terminals' start command, agent chip).
  function saveSessionEdits(edits: SessionEdits) {
    if (!editingSession) return;
    agentSessionsCollection.update(editingSession.id, (draft) => {
      // Choosing a name pins it: the auto-namer stops following the terminal
      // title (see session/auto-name.ts) the moment the user renames.
      if (edits.name !== draft.label) draft.autoNamed = false;
      draft.label = edits.name;
      draft.agent = edits.agentLabel;
      draft.startCommand = edits.startCommand || null;
      draft.runOnNewTerminal = edits.runOnNewTerminal;
    });
    // A runtime session's agent was launched with the old command: stop it, so
    // the next open / prompt starts the new one (its log stays).
    if (
      runsInView(editingSession) &&
      (edits.startCommand || null) !== (editingSession.startCommand ?? null)
    ) {
      void sessionViewBridge()?.stop(editingSession.id);
    }
  }

  // Flip a session in/out of the archive (manual). Unarchiving resets it to a
  // neutral 'idle'; its live status re-derives from terminal activity when viewed.
  function toggleArchive(s: AgentSession) {
    agentSessionsCollection.update(s.id, (draft) => {
      draft.status = s.status === 'archived' ? 'idle' : 'archived';
    });
  }

  function toggleArchivedOpen() {
    setArchivedOpen((open) => !open);
  }

  // The "+" launches a session in the current project (like the project screen),
  // then opens its workspace.
  async function createSession(launch: NewSessionLaunch) {
    // Placed under another project (lib/session/placement.ts): the session
    // starts there - that project's own worktree setup runs. A project open
    // in a window of its own starts its sessions there.
    const under = launch.underProject;
    const underWindow = under ? externalWindowOf(under.projectId) : null;
    if (underWindow) {
      window.api?.project?.focusWindow(underWindow);
      return;
    }
    const id = await launchSession({
      name: launch.name,
      startCommand: launch.startCommand,
      agentLabel: launch.agentLabel,
      runOnNewTerminal: launch.runOnNewTerminal,
      runtime: launch.runtime,
      openInView: launch.openInView,
      projectId: under ? under.projectId : (newSessionProject?.id ?? viewProjectId),
      projectPath: under ? under.projectPath : (newSessionProject?.path ?? null),
      ownerId: user.id,
      worktree: launch.worktree,
      ...(under ? {} : { setupCommand: launch.setupCommand }),
      rootPath: under ? under.rootPath : launch.rootPath,
      ...(launch.localSeed ? { localSeed: launch.localSeed } : {}),
    });
    if (id) void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } });
  }

  // Switching projects in the rail always stays in the workspace: open the
  // session the user last viewed there - else its top session (live first, else
  // archived, sorted like the sidebar) - or, with no sessions at all, its
  // session-less view (create one from there). A project living in a window
  // of its own gets that window raised instead; in a project window, any
  // other project opens in the MAIN window (user decision 2026-10-03) - the
  // window's own project stays put.
  function openProject(p: Project) {
    if (p.id === listProjectId) return;
    if (externalProjectIds.includes(p.id)) {
      window.api?.project?.focusWindow(p.id);
      return;
    }
    if (scope) {
      if (p.id !== scope.projectId) window.api?.project?.openInMain(p.id);
      return;
    }
    goToTarget(navigate, projectOpenTarget(p.id, projects, allSessions, lastProjectSession));
  }

  // `Menu/Project` on a Projects-panel row. Opening a project in its own
  // window carries every session of it this window holds (lib/project-actions);
  // main releases them here once the window is up. Deleting the project on
  // screen (the session's own, or the one it is listed under) opens the next
  // one like startup does - the list still holds the deleted row this render -
  // or the no-project workspace. A project window closes itself instead (its
  // host sees its scope vanish).
  async function removeProject(p: Project) {
    if (!(await confirmProjectDeletion(p, allSessions))) return;
    deleteProject(p.id);
    if (scope || (p.id !== project?.id && p.id !== listProjectId)) return;
    goToTarget(
      navigate,
      afterProjectDeleted(p.id, projects, allSessions, lastProject(), lastProjectSession),
    );
  }

  const pill = session ? STATUS_PILL[session.status] : null;

  // Panels open in the dock, in stacking order, with their default vertical share
  // (resizable afterwards via the dividers). The Tabs panel needs its setting on -
  // its persisted open state survives underneath while the setting is off.
  const openPanels = PANEL_ORDER.filter(
    (id) => dockPanels.includes(id) && (id !== 'tabs' || verticalTabs),
  );
  const dockDefaults = dockDefaultSizes(openPanels);

  // The header + scrollable body for one stacked dock panel (the Changes panel
  // renders separately - it owns the whole dock while its overlay is open).
  function renderDockPanel(id: DockStackPanelId): ReactNode {
    // The vertical open-tabs list. It reads the layout context itself (present
    // only in the live-session branch below) and shows an empty state without it.
    if (id === 'tabs') return <VerticalTabsPanel cwd={cwd ?? null} />;
    if (id === 'projects') {
      // ↑/↓ on a project row opens the previous/next project right away (like
      // clicking it) and keeps the caret on its row in the view that appears.
      // Plain arrows only: ⇧⌘↑/↓ leaves for the panel above/below and must not
      // also switch the project.
      const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        const delta = plainArrowStep(e);
        if (!delta) return;
        const target = e.target as HTMLElement;
        if (target.closest('[role="menu"]')) return;
        const next = stepFocusItem(e.currentTarget, target, delta);
        if (!next) return;
        e.preventDefault();
        next.focus();
        const p = railProjects.find((x) => x.id === next.dataset.focusKey);
        if (!p || p.id === listProjectId) return;
        requestRegionFocus('projects', p.id);
        openProject(p);
      };
      // The right-clicked row, resolved live - the menu simply doesn't render
      // if the project vanished while it was open.
      const ctxProject = projectCtxMenu
        ? railProjects.find((p) => p.id === projectCtxMenu.projectId)
        : undefined;
      return (
        <div
          data-focus-region="projects"
          className="group/region flex min-h-0 flex-1 flex-col focus-frame"
        >
          <PanelHead label="PROJECTS">
            <button
              type="button"
              aria-label="New project"
              title="New project"
              // A project window creates none of its own: the main window's dialog.
              onClick={() => requestNewProject()}
              className="flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </PanelHead>
          {/* Drag a row to reorder the list (a press that doesn't move stays a
            click → open the project); neighbours slide apart, the ghost rides
            in the DragOverlay. */}
          <DndContext
            sensors={projectSort.sensors}
            collisionDetection={closestCenter}
            {...projectSort.handlers}
          >
            <div
              ref={projectsScrollRef}
              onKeyDown={onKeyDown}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1.5"
            >
              <SortableContext
                items={railProjects.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                {railProjects.map((p) => {
                  // The listed project lights up while one of its linked host sessions shows.
                  const active = p.id === listProjectId;
                  const meta = projectMeta.get(p.id);
                  // In a window of its own: the monitor glyph (the same one a
                  // session row wears), a click raises that window.
                  const isExternal = externalProjectIds.includes(p.id);
                  return (
                    <Sortable key={p.id} id={p.id}>
                      {(item) => (
                        <button
                          ref={item.ref as Ref<HTMLButtonElement>}
                          {...item.handleProps}
                          type="button"
                          title={p.name}
                          data-project-row={p.id}
                          data-focus-item
                          data-focus-key={p.id}
                          data-focus-current={active || undefined}
                          style={item.style}
                          onClick={() => {
                            if (projectSort.consumeDragClick()) return;
                            openProject(p);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setProjectCtxMenu({ projectId: p.id, x: e.clientX, y: e.clientY });
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none transition-colors kbd-focus:ring-1 kbd-focus:ring-inset kbd-focus:ring-primary',
                            // The open project wears the keyboard-focus ring too,
                            // so the selection reads at a glance (softer on dark).
                            active
                              ? 'bg-accent ring-1 ring-inset ring-primary dark:ring-primary/50'
                              : 'hover:bg-muted/50',
                            // Rolled up like the dot below: washed while anything
                            // in the project runs or waits on you.
                            liveBandClass(projectLiveBand(meta)),
                            item.isDragging && 'opacity-30',
                          )}
                        >
                          {active ? (
                            <FolderOpen className="size-[13px] shrink-0 text-primary" />
                          ) : (
                            // A project's own color tints its folder; the open
                            // one stays on the accent like every selection.
                            <Folder
                              className="size-[13px] shrink-0 text-foreground-muted"
                              style={p.color ? { color: p.color } : undefined}
                            />
                          )}
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate font-mono text-xs text-foreground',
                              active ? 'font-semibold' : 'font-medium',
                            )}
                          >
                            {p.name}
                          </span>
                          <HostBadgeSlot hostId={p.hostId} />
                          {/* Rolled up from the project's sessions, so it breathes
                            for the same reason a session row does: something in
                            there is waiting on you or running - or, still, a
                            session finished in there that you haven't seen.
                            Waiting wins: it is the one you have to act on. */}
                          {meta?.needsInput ? (
                            <StatusDot live className="size-1.5 shrink-0 bg-warning" />
                          ) : meta?.active ? (
                            <StatusDot live className="size-1.5 shrink-0 bg-success" />
                          ) : meta?.finished ? (
                            <StatusDot className="size-1.5 shrink-0 bg-info" />
                          ) : null}
                          {isExternal && (
                            <Monitor
                              className="size-3 shrink-0 text-primary"
                              aria-label="Open in a window"
                            />
                          )}
                          <ProjectCountPill count={meta?.count ?? 0} />
                        </button>
                      )}
                    </Sortable>
                  );
                })}
              </SortableContext>
            </div>
            {ctxProject && (
              <ProjectContextMenu
                anchor={projectCtxMenu}
                onClose={() => setProjectCtxMenu(null)}
                external={externalProjectIds.includes(ctxProject.id)}
                onOpenInWindow={() => openProjectInWindow(ctxProject, allSessions)}
                onBringToWindow={() => bringProjectToWindow(ctxProject.id)}
                onEdit={() => {
                  setEditingProject(ctxProject);
                  setEditProjectOpen(true);
                }}
                onDelete={() => void removeProject(ctxProject)}
              />
            )}
            {createPortal(
              <DragOverlay>
                {projectSort.activeId &&
                  (() => {
                    const p = railProjects.find((x) => x.id === projectSort.activeId);
                    return p ? (
                      <div className="flex items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 py-1.5 shadow-lg">
                        <Folder
                          className="size-[13px] shrink-0 text-primary"
                          style={p.color ? { color: p.color } : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
                          {p.name}
                        </span>
                      </div>
                    ) : null;
                  })()}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        </div>
      );
    }

    // One session row, reused for the active list and the (dimmed) archived group.
    const renderSessionRow = (s: AgentSession): ReactNode => {
      const isCurrent = s.id === sessionId;
      // Open in another window: reorders like any row, but can't be torn out
      // again (the outside drop no-ops) - a monitor glyph marks it. Clicking
      // raises that window (possibly on another Space/monitor) instead of
      // opening the session here.
      const isReleased = releasedIds.includes(s.id);
      const isArchived = s.status === 'archived';
      // Diff stats for row 2 - hidden when unknown, all-zero, or archived.
      const folderStats = !isArchived ? sessionStats.get(sessionFolder(s) ?? '') : undefined;
      const rowStats = folderStats && folderStats.add + folderStats.del > 0 ? folderStats : null;
      // Drag a row within the list to reorder it (dnd-kit slides its neighbours
      // apart), or past the window edge to tear the session into its own window
      // (a press that doesn't move stays a click → navigate). The kebab stops
      // its own pointerdown, so pressing it never starts a drag. Archived rows
      // aren't sortable.
      return (
        <Sortable key={s.id} id={s.id} disabled={isArchived}>
          {(item) => (
            <div
              ref={item.ref as Ref<HTMLDivElement>}
              {...item.handleProps}
              role="button"
              tabIndex={0}
              data-session-id={s.id}
              data-hover-scroll-root
              data-focus-item
              data-focus-key={s.id}
              data-focus-current={isCurrent || undefined}
              style={item.style}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                // Ignore the kebab trigger and its portaled menu items (they bubble here
                // through React's tree but live outside this row in the DOM).
                if (target.closest('[data-row-action]') || !e.currentTarget.contains(target))
                  return;
                if (sessionSort.consumeDragClick()) return;
                if (isReleased) raiseSessionWindow(s);
                else if (!isCurrent) {
                  navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
                }
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isReleased) raiseSessionWindow(s);
                  else if (!isCurrent) {
                    navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
                  }
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSessionCtxMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
              }}
              className={cn(
                // Keyboard focus = the row's own border turns primary (the design's
                // 1px stroke) - the other lists, which have no border, use a ring.
                // The current session keeps that primary border for good (softer on dark).
                'flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left outline-none transition-colors kbd-focus:border-primary',
                isCurrent
                  ? 'border border-primary bg-accent dark:border-primary/50'
                  : 'border border-transparent hover:bg-muted/50',
                // Washed with the status colour while the session works or waits
                // on you - the row-sized twin of its dot (live-band.ts).
                liveBandClass(sessionLiveBand(s.status)),
                isArchived && 'opacity-60',
                item.isDragging && 'opacity-30',
              )}
            >
              {/* Row 1: status dot, label, worktree icon, window indicator, kebab menu */}
              <div className="flex items-center gap-1.5">
                <StatusDot
                  live={isLiveSessionStatus(s.status)}
                  className={cn('size-1.5 shrink-0', SIDEBAR_DOT[s.status])}
                />
                <HoverScrollText
                  // Long names truncate in the row - hovering the row slides the
                  // rest into view, and the full name is the tooltip.
                  title={s.label}
                  className={cn(
                    'min-w-0 flex-1 font-mono text-xs text-foreground',
                    isCurrent ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {s.label}
                </HoverScrollText>
                {s.worktreePath != null &&
                  (worktreeTool ? (
                    <button
                      type="button"
                      // Like the kebab: no drag from the icon, and the row's onClick
                      // skips it via the data-row-action check.
                      data-row-action
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => openWorktreeTool(s)}
                      title={`Show worktree branch in ${worktreeTool.label}`}
                      aria-label={`Show worktree branch in ${worktreeTool.label}`}
                      className="flex size-[18px] shrink-0 items-center justify-center rounded-sm text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted"
                    >
                      <GitBranch className="size-3" />
                    </button>
                  ) : (
                    // No tool shows worktrees in the core build: the icon only
                    // marks a worktree session.
                    <span
                      title="Runs in a worktree"
                      aria-label="Runs in a worktree"
                      className="flex size-[18px] shrink-0 items-center justify-center text-foreground-muted"
                    >
                      <GitBranch className="size-3" />
                    </span>
                  ))}
                {isReleased && (
                  <Monitor className="size-3 shrink-0 text-primary" aria-label="Open in a window" />
                )}
                <SessionMenu
                  sessionId={s.id}
                  released={isReleased}
                  archived={isArchived}
                  folderPath={sessionFolder(s)}
                  isWorktree={s.worktreePath != null}
                  onOpenInWindow={() => openInSeparateWindow(s)}
                  onBringToWindow={() => bringToWindow(s)}
                  onEdit={() => {
                    setEditingSession(s);
                    setEditSessionOpen(true);
                  }}
                  onToggleArchive={() => toggleArchive(s)}
                  onDelete={() => deleteSession(s)}
                />
              </div>
              {/* Row 2: diff stats (+added/-removed uncommitted lines vs HEAD),
              subfolder chip (sessions rooted below the project dir),
              latest detail + last activity */}
              <SessionRowDetail
                sessionId={s.id}
                status={s.status}
                detail={s.detail}
                updatedAtMs={s.updatedAt.getTime()}
                added={rowStats?.add ?? null}
                removed={rowStats?.del ?? null}
                rootLabel={sessionRootLabel(s)}
                rootPath={s.rootPath ?? null}
                // Each row's own machine: the list mixes this project's
                // sessions with its linked host projects'.
                hostId={projectOf(s)?.hostId ?? null}
              />
            </div>
          )}
        </Sortable>
      );
    };

    // Archived sessions live in their own collapsible group below the active ones,
    // each group in manual order (projectSessions is already sortOrder-ascending).
    const activeList = projectSessions.filter((s) => s.status !== 'archived');
    const archivedList = projectSessions.filter((s) => s.status === 'archived');
    // The DragOverlay ghost: a compact copy of the row while sorting; past the
    // window edge it flips to the tear-off look (accent + monitor + hint) -
    // unless the session already lives in a window and can't tear again.
    const draggedSession = sessionSort.activeId
      ? projectSessions.find((s) => s.id === sessionSort.activeId)
      : null;
    const tearing =
      sessionSort.outside && draggedSession != null && !releasedIds.includes(draggedSession.id);
    // The right-clicked row, resolved live from the list - the menu simply
    // doesn't render if the session vanished while it was open.
    const ctxSession = sessionCtxMenu
      ? projectSessions.find((s) => s.id === sessionCtxMenu.sessionId)
      : undefined;

    // ↑/↓ on a session row switches to the previous/next session right away
    // (like clicking it) and keeps the caret on its row in the view that
    // appears - a session open in another window only takes the focus (Enter
    // raises its window, as a click would). Plain arrows only: ⇧⌘↑/↓ leaves
    // for the panel above/below and must not also switch the session.
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const delta = plainArrowStep(e);
      if (!delta) return;
      const target = e.target as HTMLElement;
      // The kebab menu (portaled, but React bubbles through) keeps its own arrows.
      if (target.closest('[data-row-action], [role="menu"]')) return;
      const next = stepFocusItem(e.currentTarget, target, delta);
      if (!next) return;
      e.preventDefault();
      next.focus();
      const s = projectSessions.find((x) => x.id === next.dataset.focusKey);
      if (!s || s.id === sessionId || releasedIds.includes(s.id)) return;
      requestRegionFocus('sessions', s.id);
      navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
    };

    return (
      <div
        data-focus-region="sessions"
        className="group/region flex min-h-0 flex-1 flex-col focus-frame"
      >
        <PanelHead label="SESSIONS">
          {!noProject && (
            <button
              type="button"
              aria-label="New session"
              onClick={() => setNewSessionOpen(true)}
              className="flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </PanelHead>
        <DndContext
          sensors={sessionSort.sensors}
          collisionDetection={closestCenter}
          {...sessionSort.handlers}
        >
          <div
            ref={sessionsScrollRef}
            onKeyDown={onKeyDown}
            className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 py-3"
          >
            <SortableContext items={activeSessionIds} strategy={verticalListSortingStrategy}>
              {activeList.map(renderSessionRow)}
            </SortableContext>
            {archivedList.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleArchivedOpen}
                  className="mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-foreground-subtle outline-none transition-colors hover:bg-muted/50"
                >
                  {archivedOpen ? (
                    <ChevronDown className="size-3 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0" />
                  )}
                  <span className="font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold uppercase tracking-wide">
                    Archived
                  </span>
                  <span className="font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold">
                    {archivedList.length}
                  </span>
                </button>
                {archivedOpen && archivedList.map(renderSessionRow)}
              </>
            )}
          </div>
          {createPortal(
            <DragOverlay>
              {draggedSession && (
                <div
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border bg-surface px-2.5 py-2 shadow-lg',
                    tearing ? 'border-primary' : 'border-border-strong',
                  )}
                >
                  {tearing ? (
                    <Monitor className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <StatusDot
                      live={isLiveSessionStatus(draggedSession.status)}
                      className={cn('size-1.5 shrink-0', SIDEBAR_DOT[draggedSession.status])}
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate font-mono text-xs font-medium',
                      tearing ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {draggedSession.label}
                  </span>
                  {tearing && (
                    <span className="shrink-0 text-xs text-muted-foreground">- new window</span>
                  )}
                </div>
              )}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
        {ctxSession && (
          <SessionContextMenu
            anchor={sessionCtxMenu}
            onClose={() => setSessionCtxMenu(null)}
            sessionId={ctxSession.id}
            released={releasedIds.includes(ctxSession.id)}
            archived={ctxSession.status === 'archived'}
            folderPath={sessionFolder(ctxSession)}
            isWorktree={ctxSession.worktreePath != null}
            onOpenInWindow={() => openInSeparateWindow(ctxSession)}
            onBringToWindow={() => bringToWindow(ctxSession)}
            onEdit={() => {
              setEditingSession(ctxSession);
              setEditSessionOpen(true);
            }}
            onToggleArchive={() => toggleArchive(ctxSession)}
            onDelete={() => deleteSession(ctxSession)}
          />
        )}
      </div>
    );
  }

  // The left tool dock - the open overlay's panel while one is up, otherwise
  // the open rail tabs as vertically-resizable panels - plus its right-edge
  // width handle. Rendered inside the right-of-rail column so the bottom panel
  // can span the full
  // content width beneath it.
  const toolDock =
    overlayOpen || openPanels.length > 0 ? (
      <>
        <div
          style={{ width: dockWidth }}
          className="flex shrink-0 flex-col overflow-hidden bg-surface"
        >
          {openTool ? (
            <openTool.DockPanel />
          ) : (
            <DockStack
              key={openPanels.join('|')}
              openPanels={openPanels}
              defaults={dockDefaults}
              renderPanel={renderDockPanel}
            />
          )}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={(e) => startDockResize(e, dockWidth)}
          className={cn(
            'w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60',
            dockResizing && 'bg-primary',
          )}
        />
      </>
    ) : null;

  // A registered rail tool's content (the extension's).
  const toolView = openTool ? <openTool.View /> : null;

  // The icon rail (see rail-nav.tsx - dnd-kit sortable clusters). A const so
  // the released/live branches below can mount the same rail in their
  // different wrappers.
  const railNav = (
    <RailNav
      dockPanels={dockPanels}
      openOverlay={openOverlay}
      explorerOpen={explorerOpen}
      bottomPanelOpen={bottomPanelOpen}
      runningSessions={runningSessions}
      projectId={viewProjectId}
      onToggleDock={onToggleDock}
      onToggleBottomPanel={onToggleBottomPanel}
    />
  );

  // What a rail tool may read and do (lib/extension/types.ts). Its Provider
  // wraps the whole workspace, so its rail badge, dock panel and view share
  // one model.
  const toolContext = (tool: RailTool): RailToolContext => ({
    currentSessionId: sessionId,
    projectId: viewProjectId ?? null,
    projectPath: project?.path ?? null,
    openOverlay,
    cwd: cwd ?? null,
    sessions: toolSessions,
    projects,
    projectOf,
    sessionFolder,
    sessionRootLabel,
    releasedIds,
    live: isActiveSession && !released,
    open: toolOpen(tool.id),
    close: () => {
      if (toolOpen(tool.id)) onToggleDock(tool.id);
    },
    openSession: (s) => {
      if (releasedIds.includes(s.id)) {
        raiseSessionWindow(s);
        return;
      }
      if (s.id !== sessionId) {
        navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
      }
    },
  });
  const withRailTools = (tree: ReactNode): ReactNode =>
    railTools.reduceRight(
      (child, tool) => (
        <tool.Provider key={tool.id} ctx={toolContext(tool)}>
          {child}
        </tool.Provider>
      ),
      tree,
    );

  // The repo choices sit outside the tools: a tool's provider adds its own
  // pick beneath (its repo picker reads it), the git pick stays everyone's.
  return (
    <RepoChoiceContext.Provider value={repoChoices}>
      {withRailTools(
        <GitProviderImpl
          cwd={gitRepo.cwd}
          projectId={viewProjectId ?? null}
          active={isActiveSession && !released}
          openOverlay={openOverlay}
        >
          <div
            ref={viewRef}
            className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
          >
            {/* Top bar */}
            <TitleBar className="flex items-center gap-3 px-3.5">
              <Logo />
              <DevBadge />
              {(listProject || scope) && <div className="h-[18px] w-px bg-border" />}

              {/* Breadcrumb: project › session (design: `Window/Project
                        (Detached)`). Neither is a page to leave for - the
                        workspace is the only screen (a private plan). */}
              <nav aria-label="Breadcrumb" className="flex items-center gap-2">
                {(listProject || scope) && (
                  <span className="flex items-center gap-1.5 font-mono text-xs font-medium text-foreground-muted">
                    <FolderGit2 className="size-3.5" />
                    {listProject?.name ?? scope?.projectName}
                  </span>
                )}
                {session && pill && (
                  <>
                    <ChevronRight className="size-3 text-foreground-subtle" />
                    <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-foreground">
                      <GitBranch className="size-3.5 text-primary" />
                      {session.label}
                    </span>
                    <span
                      className={cn(
                        'ml-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold',
                        pill.className,
                      )}
                    >
                      <StatusDot
                        live={isLiveSessionStatus(session.status)}
                        className={cn('size-1.5', pill.dot)}
                      />
                      {pill.label}
                    </span>
                  </>
                )}
              </nav>

              <div className="flex-1" />

              {/* Opens the global Search Everywhere palette - same as double-Shift. */}
              <button
                type="button"
                aria-label="Search everywhere"
                onClick={openSearchEverywhere}
                className="flex w-[260px] items-center gap-2 rounded-md border border-border bg-input px-2.5 py-1.5 text-left transition-colors hover:border-border-strong"
              >
                <Search className="size-3.5 shrink-0 text-foreground-muted" />
                <span className="flex-1 truncate text-xs text-foreground-muted">
                  Jump to file or command…
                </span>
              </button>

              <TopBarActions />
            </TitleBar>

            {/* Body: a rail + tool dock + session surface row, the bottom panel
          under the content (right of the rail), and the status bar at the very
          bottom spanning the full window width - beneath the rail too, like the
          design. A released session has no surface to mount - just the rail and
          tool dock (so the user can keep switching sessions), a placeholder, and
          no status bar (it reports on a layout this window doesn't own). */}
            {released ? (
              <div className="flex flex-1 overflow-hidden">
                {railNav}
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  {toolDock}
                  {/* A whole project in its own window reads as the project
                            placeholder (its sessions are all there); a lone
                            torn-off session as the session one. */}
                  {externalWindowOf(viewProjectId) != null ? (
                    <ProjectElsewhere
                      onShowWindow={() =>
                        window.api?.project?.focusWindow(externalWindowOf(viewProjectId)!)
                      }
                      onBringBack={() => bringProjectToWindow(externalWindowOf(viewProjectId)!)}
                    />
                  ) : (
                    <SessionElsewhere
                      onShowWindow={() => {
                        if (sessionId) window.api?.session?.focusWindow(sessionId);
                      }}
                      onBringBack={() => {
                        if (sessionId) window.api?.session?.bringBack(sessionId);
                      }}
                    />
                  )}
                </div>
              </div>
            ) : session ? (
              <WorkspaceLayoutProvider
                sessionId={session.id}
                initial={seedLayout}
                primaryTitle={sessionAgentLabel(session)}
                // The session's free-text start command; pre-column sessions (no
                // startCommand) fall back to deriving it from the agent label. A
                // runtime session's terminals run nothing (sessionTerminalCommand).
                startupCommand={sessionTerminalCommand(session)}
                runOnNewTerminal={session.runOnNewTerminal ?? true}
                inView={runsInView(session)}
              >
                <ReviewScopeProvider sessionId={session.id} agentCwd={cwd ?? null}>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="flex min-h-0 flex-1 overflow-hidden">
                      {railNav}
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div className="flex min-h-0 flex-1 overflow-hidden">
                          {toolDock}
                          {/* While an overlay is up, the surface
                      stays mounted (shells keep running) but hidden under it. */}
                          <div className={overlayOpen ? 'hidden' : 'contents'}>
                            <WorkspaceSurface
                              sessionId={session.id}
                              cwd={cwd}
                              isWorktree={session.worktreePath != null}
                              isActiveSession={isActiveSession && !overlayOpen}
                              explorerOpen={explorerOpen}
                              onOpenTool={() => openWorktreeTool(session)}
                              onNewSessionAt={(path) => {
                                // A folder inside this session's worktree maps back to
                                // the same folder in the project dir - the new session
                                // stands alone (it shouldn't nest inside this session's
                                // worktree; a worktree launch re-maps from the project).
                                const wt = session.worktreePath;
                                const dir = project?.path;
                                setNewSessionRoot(
                                  wt && dir && isWithin(path, wt) && relativeTo(path, wt)
                                    ? joinPath(dir, relativeTo(path, wt))
                                    : path,
                                );
                                setNewSessionOpen(true);
                              }}
                            />
                          </div>
                          {toolView}
                        </div>
                        {/* Kept MOUNTED (hidden when closed) so toggling the dock
                    preserves its terminals + selection exactly - a running
                    command is never torn down, re-run, or replayed. Same
                    contents/hidden trick as the surface behind the Changes
                    overlay above. */}
                        {BottomPanel && (
                          <div className={bottomPanelOpen ? 'contents' : 'hidden'}>
                            <BottomPanel
                              sessionId={session.id}
                              projectId={session.projectId}
                              cwd={cwd}
                              open={bottomPanelOpen}
                              visible={bottomPanelOpen && isActiveSession}
                              onClose={onToggleBottomPanel}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    <WorkspaceStatusBar sessionPath={cwd ?? null} />
                  </div>
                  <WorkspaceShortcuts
                    isActiveSession={isActiveSession}
                    sessionId={session.id}
                    projectId={session.projectId}
                    openOverlay={openOverlay}
                    bottomPanelOpen={bottomPanelOpen}
                    cwd={cwd ?? null}
                    onToggleDock={onToggleDock}
                    onToggleBottomPanel={onToggleBottomPanel}
                    onNewSession={() => setNewSessionOpen(true)}
                    openPanels={openPanels}
                    explorerOpen={explorerOpen}
                    viewRef={viewRef}
                  />
                </ReviewScopeProvider>
              </WorkspaceLayoutProvider>
            ) : (
              // Session-less: this project has no sessions yet. Keep the full chrome
              // (rail, dock, Changes on the project dir) around an empty state, so
              // the first session can be created without leaving the workspace.
              <div className="flex flex-1 overflow-hidden">
                {railNav}
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  {toolDock}
                  {/* No project: the empty state, whatever tool was left open. */}
                  {noProject ? (
                    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-12 py-10">
                      {projectsReady ? (
                        <EmptyState
                          className="flex-1 justify-center"
                          icon={FolderPlus}
                          title="Add your first project"
                          description="A project is a folder on this computer or a server. Its sessions put agents to work in it."
                          action={
                            <Button className="font-medium" onClick={() => requestNewProject()}>
                              <Plus className="size-4" />
                              New project
                            </Button>
                          }
                        />
                      ) : (
                        <p className="flex-1 py-16 text-center text-sm text-foreground-muted">
                          Loading projects…
                        </p>
                      )}
                    </div>
                  ) : openTool ? (
                    toolView
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-12 py-10">
                      <EmptyState
                        className="flex-1 justify-center"
                        icon={GitBranch}
                        title="No sessions yet"
                        description="Sessions are agent runs scoped to a task. Start your first one to put an agent to work in this project."
                        action={
                          <Button className="font-medium" onClick={() => setNewSessionOpen(true)}>
                            <Plus className="size-4" />
                            New session
                          </Button>
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            <NewSessionDialog
              open={newSessionOpen}
              onOpenChange={(open) => {
                setNewSessionOpen(open);
                if (!open) setNewSessionRoot(null);
              }}
              onLaunch={createSession}
              rootPath={newSessionRoot}
              projectPath={newSessionProject?.path ?? null}
              worktreeSetup={
                newSessionProject
                  ? { projectName: newSessionProject.name, setup: newSessionProject }
                  : null
              }
              hostId={newSessionProject?.hostId ?? null}
              projectId={newSessionProject?.id ?? null}
            />

            <NewSessionDialog
              open={editSessionOpen}
              onOpenChange={setEditSessionOpen}
              editSession={editingSession}
              onSave={saveSessionEdits}
              projectPath={project?.path ?? null}
            />

            {editingProject && (
              <EditProjectDialog
                open={editProjectOpen}
                onOpenChange={setEditProjectOpen}
                project={editingProject}
                onSave={editProject}
              />
            )}
          </div>
        </GitProviderImpl>,
      )}
    </RepoChoiceContext.Provider>
  );
});
