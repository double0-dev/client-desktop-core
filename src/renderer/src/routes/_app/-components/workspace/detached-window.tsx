import { useEffect, useMemo, useState } from 'react';
import { unwatchFolder, watchFolder } from '@renderer/lib/workspace/watch-mode';
import { useLiveQuery } from '@tanstack/react-db';
import { useProjectAccent } from '@renderer/lib/settings/use-project-accent';
import {
  ChevronRight,
  FolderGit2,
  FolderTree,
  GitBranch,
  Play,
  SquareTerminal,
} from 'lucide-react';
import { WorkspaceBody } from '@renderer/routes/_app/-components/workspace/workspace-body';
import { WorkspaceLayoutProvider } from '@renderer/routes/_app/-components/workspace/workspace-context';
import { ReviewScopeProvider } from '@renderer/lib/review/review-scope-provider';
import { GitStatusProvider } from '@renderer/routes/_app/-components/workspace/git-status-provider';
import { GIT_REPO_TOOL, RepoChoiceContext, useRepoChoice } from '@renderer/lib/git/repo-choice';
import { integrationHooks } from '@renderer/lib/integrations';
import { railTool, rendererExtension } from '@renderer/lib/extension/registry';
import type { RailTool } from '@renderer/lib/extension/types';
import { FileExplorer } from '@renderer/routes/_app/-components/workspace/file-explorer';
import { WorkspaceShortcuts } from '@renderer/routes/_app/-components/workspace/workspace-shortcuts';
import { RailCountBadge } from '@renderer/routes/_app/-components/workspace/rail-nav';
import { useGit } from '@renderer/lib/git/context';
import { registerExplorerOpener } from '@renderer/lib/explorer-reveal';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import {
  allTabs,
  initialDetachedLayout,
  initialLayout,
  shellPtyIds,
} from '@renderer/lib/workspace/layout';
import { observeSessionStatus } from '@renderer/lib/session/status';
import { setFocusedSession } from '@renderer/lib/session/attention';
import { requestWorktreeReveal } from '@renderer/lib/worktree-reveal';
import { agentSessionsCollection, type AgentSession } from '@renderer/lib/collections';
import {
  runsInView,
  sessionAgentLabel,
  sessionTerminalCommand,
} from '@renderer/lib/session/templates';
import { usePersistedState } from '@renderer/lib/use-persisted-state';
import { useEdgeResize } from '@renderer/lib/use-edge-resize';
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  decodeDockWidth,
  type RailTabId,
} from '@renderer/lib/workspace/dock-state';
import { DevBadge, TitleBar } from '@renderer/components/title-bar';
import { cn } from '@renderer/lib/utils';
import type { CommandDockState, DetachedWindowPayload } from '@renderer/lib/transfer';

/** Project + session names shown in a torn-off session window's header. */
type SessionHeader = { projectName: string | null; sessionLabel: string };

// The torn-off session window carries its own copy of the tool rail's sidebar
// widths (separate keys from the app window's host-lifted ones), so resizing a
// dock here doesn't shove the main window's around.
const DOCK_WIDTH_KEY = 'double0-detached-dock-width';
const EXPLORER_WIDTH_KEY = 'double0-detached-explorer-width';
const EXPLORER_DEFAULT_WIDTH = 240;
const EXPLORER_MIN_WIDTH = 180;
const EXPLORER_MAX_WIDTH = 480;

function decodeExplorerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return EXPLORER_DEFAULT_WIDTH;
  return Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, width));
}

// The session-changes drawer (pane tab-strip toggle) - same bounds as the app
// window's, under this window's own key like the other sidebar widths.
const CHANGES_DRAWER_WIDTH_KEY = 'double0-detached-session-changes-width';
const CHANGES_DRAWER_DEFAULT_WIDTH = 360;
const CHANGES_DRAWER_MIN_WIDTH = 280;
const CHANGES_DRAWER_MAX_WIDTH = 640;

function decodeChangesDrawerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return CHANGES_DRAWER_DEFAULT_WIDTH;
  return Math.min(CHANGES_DRAWER_MAX_WIDTH, Math.max(CHANGES_DRAWER_MIN_WIDTH, width));
}

/**
 * Root of a torn-off window - either a single terminal tab or a whole session.
 *
 * It seeds its layout from the payload, keeping each tab's `ptyId` intact so the
 * shared `WorkspaceBody` adopts the live shells (replaying their scrollback)
 * instead of spawning fresh ones. A session arrives with its full layout (tabs +
 * splits); a single terminal becomes a one-tab layout. From there it behaves like
 * the in-app surface: tabs can be split, torn off, or merged back across windows.
 */
export function DetachedWindow({ payload }: { payload: DetachedWindowPayload }) {
  const seed = useMemo(
    () => {
      if (payload.kind === 'session') {
        const s = payload.session;
        // Re-use the transferred layout verbatim; fall back to a fresh session
        // layout when it was never opened (no live layout to carry over).
        return {
          sessionId: s.sessionId,
          initial: s.layout ?? initialLayout(s.sessionId),
          cwd: s.cwd,
          header: { projectName: s.projectName, sessionLabel: s.label } as
            SessionHeader | undefined,
          title: s.projectName ? `${s.projectName} › ${s.label}` : s.label,
          commandDock: s.commandDock,
        };
      }
      return {
        sessionId: 'detached',
        // Fresh tab id for this window's model; the ptyId carries the live shell.
        initial: initialDetachedLayout({
          id: crypto.randomUUID(),
          kind: 'terminal',
          title: payload.tab.title,
          ptyId: payload.tab.termId,
        }),
        cwd: payload.tab.cwd,
        header: undefined as SessionHeader | undefined,
        title: payload.tab.title,
        commandDock: null as CommandDockState | null,
      };
    },
    // Seed once on mount; later inserts/removals flow through the reducer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Name the OS window so it's identifiable in the switcher / taskbar and when it
  // sits on a different screen from the main app.
  useEffect(() => {
    document.title = seed.title;
  }, [seed.title]);

  // The session's live row (the payload only carries its name): the same
  // session context the app window hands its provider - agent label, start
  // command, "run on new terminals" - so "+" here opens the same kind of
  // terminal it does there, and an edit made while the session is torn off
  // (Edit session) reaches this window's tabs too. A never-opened session's
  // fallback layout (no live layout to carry over) gets its conversation tab
  // titled and commanded by the same sync. Lone terminal windows have no
  // session and pass nothing, keeping their traveled layout authoritative.
  const { data: allSessions } = useLiveQuery((q) => q.from({ session: agentSessionsCollection }));
  const session: AgentSession | undefined =
    payload.kind === 'session'
      ? allSessions.find((s) => s.id === payload.session.sessionId)
      : undefined;
  useProjectAccent({ projectId: session?.projectId });
  // A torn-off window is covered too: it has no router, so its own mount.
  const Lock = rendererExtension().auth?.Lock;

  return (
    <>
      <WorkspaceLayoutProvider
        sessionId={seed.sessionId}
        initial={seed.initial}
        primaryTitle={session ? sessionAgentLabel(session) : undefined}
        // The session's free-text start command; pre-column sessions (no
        // startCommand) fall back to deriving it from the agent label.
        startupCommand={session ? sessionTerminalCommand(session) : undefined}
        runOnNewTerminal={session?.runOnNewTerminal ?? true}
        inView={session ? runsInView(session) : false}
      >
        {/* Both kinds stream their live layout home: a session window so the whole
          session returns on close, a tab window so its terminals hop back into
          the app window on close. */}
        {payload.kind === 'session' ? (
          // A torn-off session keeps its diff comments (this window's own review).
          <ReviewScopeProvider sessionId={seed.sessionId} agentCwd={seed.cwd}>
            <DetachedSurface
              cwd={seed.cwd}
              header={seed.header}
              title={seed.title}
              syncSessionId={seed.sessionId}
              session={session}
              initialCommandDock={seed.commandDock}
            />
          </ReviewScopeProvider>
        ) : (
          <DetachedSurface
            cwd={seed.cwd}
            header={seed.header}
            title={seed.title}
            syncSessionId={null}
            session={session}
            initialCommandDock={seed.commandDock}
          />
        )}
      </WorkspaceLayoutProvider>
      {Lock && <Lock />}
    </>
  );
}

/** Changed-file count bubble on the rail's git tool tab (hidden when clean) -
 * the same bubble the app window's rail uses, so the two windows can't drift. */
function ChangedFilesBadge() {
  const { status } = useGit();
  const count = status?.files.length ?? 0;
  return <RailCountBadge count={count} label={`${count} changed file${count === 1 ? '' : 's'}`} />;
}

/**
 * The torn-off session window's icon rail: Files (explorer) and Changes (git
 * overlay) at the top, the Commands (run-commands dock) toggle pinned to the
 * bottom. A single-session window, so no project/session switching - matching the
 * design's slim 48px rail. Same three-look logic as the app window: accent = the
 * open tool, background tile = a tool sitting behind the Changes overlay, plain =
 * closed.
 */
function DetachedRail({
  explorerOpen,
  gitTool,
  toolOpen,
  bottomPanelOpen,
  onToggleFiles,
  onToggleTool,
  onToggleBottomPanel,
}: {
  explorerOpen: boolean;
  /** The git client's tool window, when the extension has one. */
  gitTool: RailTool | undefined;
  toolOpen: boolean;
  bottomPanelOpen: boolean;
  onToggleFiles: () => void;
  onToggleTool: () => void;
  onToggleBottomPanel: () => void;
}) {
  const tabs = [
    { id: 'files', icon: FolderTree, label: 'Files', on: explorerOpen, onClick: onToggleFiles },
    // No git tool tab without an extension's git client.
    ...(gitTool
      ? [
          {
            id: gitTool.id,
            icon: gitTool.icon,
            label: gitTool.label,
            on: toolOpen,
            onClick: onToggleTool,
          },
        ]
      : []),
  ];
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
      {tabs.map((tab) => {
        const suppressed = tab.on && toolOpen && tab.id !== gitTool?.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            title={tab.label}
            aria-label={tab.label}
            aria-pressed={tab.on}
            onClick={tab.onClick}
            className={cn(
              'relative flex size-9 items-center justify-center rounded-md transition-colors',
              suppressed
                ? 'bg-background text-foreground-muted hover:text-foreground'
                : tab.on
                  ? 'bg-accent text-primary'
                  : 'text-foreground-muted hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-5" />
            {tab.id === gitTool?.id && <ChangedFilesBadge />}
          </button>
        );
      })}
      <div className="flex-1" />
      {/* The bottom panel's toggle. Below the spacer so it sits apart from the
        tool tabs, bottom-left. */}
      {rendererExtension().bottomPanel && (
        <button
          type="button"
          title="Commands"
          aria-label="Commands"
          aria-pressed={bottomPanelOpen}
          onClick={onToggleBottomPanel}
          className={cn(
            'flex size-9 items-center justify-center rounded-md transition-colors',
            bottomPanelOpen
              ? 'bg-accent text-primary'
              : 'text-foreground-muted hover:bg-muted hover:text-foreground',
          )}
        >
          <Play className="size-5" />
        </button>
      )}
    </nav>
  );
}

/**
 * The detached window's chrome: an optional session header (project › session, so
 * the window is identifiable at a glance), the shared terminal body, and a minimal
 * status bar. When its last terminal is torn back out, the window has nothing left
 * to show, so it closes itself (browser-style) - but a user CLOSING the last tab
 * keeps the window open on its "No tabs open" state. Both kinds stream their live
 * layout to main: a session window under its session id (`syncSessionId`), so
 * closing returns the session - with whatever tabs/splits it now has - to the
 * app; a tab window per-window, so closing hands its terminal tabs back to the
 * app window instead of killing them.
 *
 * A session window additionally carries the same tool rail as the app window -
 * Files, Changes and Commands - plus the pane strip's session-changes drawer,
 * wrapped in its own `GitProvider` (it's a separate OS window, so it doesn't
 * share the app window's git/dock state). A lone terminal window has no
 * project/session context, so it keeps the bare terminal chrome.
 */
function DetachedSurface({
  cwd,
  header,
  title,
  syncSessionId,
  session,
  initialCommandDock,
}: {
  cwd: string | null;
  header?: SessionHeader;
  /** The window's title (a lone terminal window shows it in its title bar). */
  title?: string;
  syncSessionId: string | null;
  /** The torn-off session's live row (undefined for a lone terminal window). */
  session: AgentSession | undefined;
  /** The origin dock's view state, restored verbatim on tear-off (null if none). */
  initialCommandDock: CommandDockState | null;
}) {
  const { layout } = useWorkspaceLayout();
  // The same git repo picker as the app window: every session of a
  // folder-of-repos project lists the project's repos. This window has no
  // project row, so the folder comes off the scopes (the repos' parent).
  const repoParent = integrationHooks().useProjectRepoFolder(session?.projectId ?? null);
  const gitRepo = useRepoChoice(cwd, GIT_REPO_TOOL, repoParent, syncSessionId);
  const repoChoices = useMemo(() => ({ [GIT_REPO_TOOL]: gitRepo }), [gitRepo]);
  // Only tabs with a shell count for the status bar (no editor, no extension view).
  const terminalCount = allTabs(layout).filter((t) => !!t.ptyId).length;

  useEffect(() => {
    if (syncSessionId) window.api?.session?.syncLayout(syncSessionId, layout);
    else window.api?.tab?.syncLayout(layout);
  }, [syncSessionId, layout]);

  // A torn-off session window owns its session's shells, so derive that session's
  // status here (the in-app host doesn't track released sessions) - aggregated
  // across all its terminal tabs, re-subscribing when the tab set changes. This
  // window only ever shows its one session, so it's the "focused" session for
  // alert-suppression. Tab windows (no session) have nothing to derive.
  const shellPtyKey = shellPtyIds(layout).sort().join(',');
  useEffect(() => {
    setFocusedSession(syncSessionId);
    return () => setFocusedSession(null);
  }, [syncSessionId]);
  useEffect(() => {
    if (!syncSessionId) return;
    return observeSessionStatus(syncSessionId, shellPtyKey ? shellPtyKey.split(',') : []);
  }, [syncSessionId, shellPtyKey]);

  // Which tool is open. Local to this window (a separate React root) - the app
  // window's dock state is host-lifted and doesn't reach here. The bottom panel
  // restores the origin's open state exactly on a tear-off.
  const [explorerOpen, setExplorerOpen] = useState(false);
  // The git tool's overlay (this window's own, never persisted).
  const [toolOpen, setToolOpen] = useState(false);
  const [bottomPanelOpen, setCommandsOpen] = useState(() => initialCommandDock?.open ?? false);
  // The extension's bottom panel, if any.
  const BottomPanel = rendererExtension().bottomPanel?.Dock;

  // "Show in file explorer" (tab context menu): make the sidebar visible so the
  // explorer can mount and take the reveal - same Changes-overlay handling as
  // picking Files on the rail.
  useEffect(
    () =>
      registerExplorerOpener(() => {
        setToolOpen(false);
        setExplorerOpen(true);
      }),
    [],
  );

  // Dock (Changes) + explorer (Files) sidebar widths - persisted, same right-edge
  // drag convention as the app window.
  const [dockWidth, setDockWidth] = usePersistedState<number>(
    DOCK_WIDTH_KEY,
    decodeDockWidth,
    String,
  );
  const { resizing: dockResizing, startResize: startDockResize } = useEdgeResize({
    min: DOCK_MIN_WIDTH,
    max: DOCK_MAX_WIDTH,
    onResize: setDockWidth,
  });
  const [explorerWidth, setExplorerWidth] = usePersistedState<number>(
    EXPLORER_WIDTH_KEY,
    decodeExplorerWidth,
    String,
  );
  const { resizing: explorerResizing, startResize: startExplorerResize } = useEdgeResize({
    min: EXPLORER_MIN_WIDTH,
    max: EXPLORER_MAX_WIDTH,
    onResize: setExplorerWidth,
  });

  // The session-changes drawer (pane tab-strip toggle): open state is this
  // window's own (one session per window), width persisted, left-edge resize
  // (right-anchored → inverted drag) - same handling as the app window.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = usePersistedState<number>(
    CHANGES_DRAWER_WIDTH_KEY,
    decodeChangesDrawerWidth,
    String,
  );
  const { resizing: drawerResizing, startResize: startDrawerResize } = useEdgeResize({
    min: CHANGES_DRAWER_MIN_WIDTH,
    max: CHANGES_DRAWER_MAX_WIDTH,
    invert: true,
    onResize: setDrawerWidth,
  });

  // The session's project id - needed by the bottom panel for saved commands -
  // and whether it runs in its own worktree, for the dock's "Open in…" launcher
  // wording (worktree vs project folder).
  const projectId = session?.projectId ?? null;
  const isWorktree = session?.worktreePath != null;

  // Watch the project directory so the file explorer, open editor tabs and git
  // status stay in sync with on-disk changes (the agent's shell, git, another
  // editor). In the app window this watch belongs to WorkspaceSurface; this window
  // has no surface, so it owns the watch itself.
  useEffect(() => {
    const fs = window.api?.fs;
    if (syncSessionId == null || !fs?.watch || !cwd) return;
    watchFolder(cwd);
    return () => unwatchFolder(cwd);
  }, [syncSessionId, cwd]);

  // One toggle for the rail and the keyboard handler (mirrors the app window's
  // host `toggleDock`). Picking Files while the Changes overlay is up closes the
  // overlay and reveals the explorer, rather than toggling it off underneath where
  // it's hidden behind the overlay. Projects/Sessions have no dock here (a
  // single-session window) - no-op.
  // An extension's git client: the full provider, its tool window's overlay
  // and the review drawer - in the core build a status-only provider (the
  // explorer's colours, the editor gutter) and none of the rest.
  const GitProviderImpl = rendererExtension().git?.Provider ?? GitStatusProvider;
  const gitToolId = rendererExtension().git?.tool;
  const GitTool = gitToolId ? railTool(gitToolId) : undefined;
  const SessionDrawer = rendererExtension().git?.Drawer;
  const toggleBottomPanel = () => setCommandsOpen((o) => !o);
  const toggleDock = (id: RailTabId) => {
    if (GitTool && id === GitTool.id) {
      setToolOpen((v) => !v);
    } else if (id === 'files') {
      if (toolOpen) {
        setToolOpen(false);
        setExplorerOpen(true);
      } else {
        setExplorerOpen((v) => !v);
      }
    }
  };

  const statusBar = (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 font-mono text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-foreground-muted">
      <span className="flex items-center gap-1">
        {/* Dimmed (not primary-green) while no shell is running - design
            `Window/Terminal (Detached) - No Tabs`. */}
        <SquareTerminal
          className={cn(
            'size-[11px]',
            terminalCount === 0 ? 'text-foreground-subtle' : 'text-primary',
          )}
        />
        {terminalCount === 0
          ? 'No terminals'
          : `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`}
      </span>
    </div>
  );

  // The split-pane terminal body plus the Files explorer sidebar. Hidden (not
  // unmounted - shells keep running) while the Changes overlay owns the content.
  const surface = (
    <div className={cn('flex min-h-0 min-w-0 flex-1 bg-background', toolOpen && 'hidden')}>
      {explorerOpen && (
        <>
          <div
            style={{ width: explorerWidth }}
            className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
          >
            {cwd ? (
              <FileExplorer rootPath={cwd} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <FolderTree className="size-5 text-foreground-subtle" />
                <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-snug text-foreground-muted">
                  This session has no project folder to browse.
                </p>
              </div>
            )}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file explorer"
            onPointerDown={(e) => startExplorerResize(e, explorerWidth)}
            className={cn(
              'w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60',
              explorerResizing && 'bg-primary',
            )}
          />
        </>
      )}
      <WorkspaceBody
        cwd={cwd}
        isWorktree={isWorktree}
        browserSessionId={syncSessionId ?? undefined}
        isActiveSession={!toolOpen}
        onEmptiedByTransfer={() => window.close()}
        changesDrawerOpen={drawerOpen && SessionDrawer !== undefined}
        onToggleChangesDrawer={SessionDrawer ? () => setDrawerOpen((o) => !o) : undefined}
      />
      {/* Session-changes drawer: right-anchored, resized from its left edge.
          "Open in Changes" hands off to this window's Changes overlay, with the
          session's branch revealed in the graph - same as the app window. */}
      {drawerOpen && SessionDrawer && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session changes"
            onPointerDown={(e) => startDrawerResize(e, drawerWidth)}
            className={cn(
              'w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60',
              drawerResizing && 'bg-primary',
            )}
          />
          <div style={{ width: drawerWidth }} className="flex shrink-0 flex-col overflow-hidden">
            <SessionDrawer
              onClose={() => setDrawerOpen(false)}
              onOpenTool={() => {
                if (cwd) requestWorktreeReveal(cwd);
                if (GitTool) setToolOpen(true);
              }}
            />
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* The window's title bar (no OS one): a session window shows project ›
          session, a lone terminal window its tab's title - what the OS title
          bar used to say. */}
      <TitleBar size="compact" className="flex items-center gap-2 px-3">
        <DevBadge />
        {!header && title && (
          <span className="truncate font-mono text-xs font-medium text-foreground-muted">
            {title}
          </span>
        )}
        {header && (
          <>
            <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
            <span className="truncate font-mono text-xs font-medium text-foreground-muted">
              {header.projectName ?? 'project'}
            </span>
            <ChevronRight className="size-3 shrink-0 text-foreground-subtle" />
            <GitBranch className="size-3.5 shrink-0 text-primary" />
            <span className="truncate font-mono text-xs font-semibold text-foreground">
              {header.sessionLabel}
            </span>
          </>
        )}
      </TitleBar>

      {syncSessionId != null ? (
        <RepoChoiceContext.Provider value={repoChoices}>
          <GitProviderImpl
            cwd={gitRepo.cwd}
            active
            openOverlay={toolOpen ? (GitTool?.id ?? null) : null}
          >
            {/* Global key handler: layout (new/split/close tab), Files/Changes/
            Commands toggles, and git pull/push/commit. Needs the layout + git
            providers, so it lives here. */}
            <WorkspaceShortcuts
              isActiveSession
              sessionId={syncSessionId}
              projectId={projectId}
              openOverlay={toolOpen ? (GitTool?.id ?? null) : null}
              bottomPanelOpen={bottomPanelOpen}
              cwd={cwd}
              onToggleDock={toggleDock}
              onToggleBottomPanel={toggleBottomPanel}
              onNewSession={() => {}}
            />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <DetachedRail
                explorerOpen={explorerOpen}
                gitTool={GitTool}
                toolOpen={toolOpen}
                bottomPanelOpen={bottomPanelOpen}
                onToggleFiles={() => toggleDock('files')}
                onToggleTool={() => GitTool && toggleDock(GitTool.id)}
                onToggleBottomPanel={toggleBottomPanel}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  {/* The Changes overlay: git refs panel in the dock, git views in
                  the content, with the terminal surface hidden underneath. */}
                  {toolOpen && GitTool && (
                    <>
                      <div
                        style={{ width: dockWidth }}
                        className="flex shrink-0 flex-col overflow-hidden bg-surface"
                      >
                        <GitTool.DockPanel />
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
                  )}
                  {surface}
                  {toolOpen && GitTool && <GitTool.View />}
                </div>
                {/* Mount-hidden (contents/hidden) so the dock stays mounted while
                closed - its project_commands collection stays subscribed (live
                list edits propagate) and it adopts any carried-over running
                command shells right away, matching the app window. */}
                {BottomPanel && (
                  <div className={bottomPanelOpen ? 'contents' : 'hidden'}>
                    <BottomPanel
                      sessionId={syncSessionId}
                      projectId={projectId}
                      cwd={cwd}
                      open={bottomPanelOpen}
                      initialState={initialCommandDock}
                      onClose={() => setCommandsOpen(false)}
                    />
                  </div>
                )}
              </div>
            </div>
          </GitProviderImpl>
        </RepoChoiceContext.Provider>
      ) : (
        <WorkspaceBody cwd={cwd} isActiveSession onEmptiedByTransfer={() => window.close()} />
      )}

      {statusBar}
    </div>
  );
}
