import { useEffect, useRef, useState } from 'react';
import { unwatchFolder, watchFolder } from '@renderer/lib/workspace/watch-mode';
import { CircleHelp, Folder, FolderTree, GitBranch, SquareTerminal } from 'lucide-react';
import { WorkspaceBody } from '@renderer/routes/_app/-components/workspace/workspace-body';
import { FileExplorer } from '@renderer/routes/_app/-components/workspace/file-explorer';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { KeptRunningBanner } from '@renderer/routes/_app/-components/workspace/kept-running-banner';
import { UnreachableBanner } from '@renderer/routes/_app/-components/workspace/unreachable-banner';
import { InputsStatusItem } from '@renderer/routes/_app/-components/workspace/inputs-status';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { useGit } from '@renderer/lib/git/context';
import { getPane, shellPtyIds, structuralSignature } from '@renderer/lib/workspace/layout';
import { registerSessionLayout } from '@renderer/lib/session/bridge';
import { useSessionQuestion } from '@renderer/lib/session/questions';
import { observeSessionStatus } from '@renderer/lib/session/status';
import { usePersistedState } from '@renderer/lib/use-persisted-state';
import { useEdgeResize } from '@renderer/lib/use-edge-resize';
import { useVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import { getProjectScope, windowChromeKey } from '@renderer/lib/workspace/project-scope';
import { cn } from '@renderer/lib/utils';

// The file-explorer sidebar's width (its open state lives in the host, shared
// across sessions). Persisted per the same convention as the dock width - and,
// like it, under a project window's own key there (windowChromeKey).
const EXPLORER_WIDTH_KEY = 'double0-workspace-explorer-width';
const EXPLORER_DEFAULT_WIDTH = 240;
const EXPLORER_MIN_WIDTH = 180;
const EXPLORER_MAX_WIDTH = 480;

function decodeExplorerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return EXPLORER_DEFAULT_WIDTH;
  return Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, width));
}

// The session-changes drawer: its width is shared across sessions (persisted,
// like the other sidebars); its open state is per session, remembered in-memory
// so switching sessions and back restores it (a restart starts closed).
const CHANGES_DRAWER_WIDTH_KEY = 'double0-session-changes-width';
const CHANGES_DRAWER_DEFAULT_WIDTH = 360;
const CHANGES_DRAWER_MIN_WIDTH = 280;
const CHANGES_DRAWER_MAX_WIDTH = 640;

function decodeChangesDrawerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return CHANGES_DRAWER_DEFAULT_WIDTH;
  return Math.min(CHANGES_DRAWER_MAX_WIDTH, Math.max(CHANGES_DRAWER_MIN_WIDTH, width));
}

const changesDrawerMemory = new Map<string, boolean>();

/**
 * The workspace surface: the file-explorer sidebar plus the shared split-pane
 * terminal body (`WorkspaceBody`). Lives inside the layout provider. The status
 * bar is rendered separately (`WorkspaceStatusBar`) so it can span the full width
 * below the bottom panel. Also owns the session's plumbing that must follow the
 * provider's lifetime: publishing the live layout to the session bridge,
 * persisting it across restarts, watching the project directory, and deriving the
 * session's status from its shells.
 */
export function WorkspaceSurface({
  sessionId,
  cwd,
  isWorktree = false,
  isActiveSession,
  explorerOpen,
  onNewSessionAt,
  onOpenTool,
}: {
  sessionId: string;
  cwd?: string | null;
  /** Whether `cwd` is a git worktree - threaded to the tab strip's "Open in IDE". */
  isWorktree?: boolean;
  isActiveSession: boolean;
  /** Whether the file-explorer sidebar is shown (rail "Files" toggle). */
  explorerOpen: boolean;
  /** "New session here" on an explorer folder - threaded to the FileExplorer. */
  onNewSessionAt?: (path: string) => void;
  /** Open the git client's tool window - the drawer footer's hand-off. */
  onOpenTool?: () => void;
}) {
  // The extension's update banner, if any (read at render: the extension is
  // installed after module load).
  const UpdateBanner = rendererExtension().updates?.Banner;
  const { layout } = useWorkspaceLayout();
  // Vertical tabs on → the dock's Tabs panel lists the tabs, so the per-pane
  // horizontal strips hide. Main workspace only - a detached window has no dock
  // to fall back on, so it keeps its strips regardless of the setting.
  const verticalTabs = useVerticalTabs();

  // Watch the project directory so the file explorer and open editor tabs stay in
  // sync with on-disk changes made outside the app (by the agent's shell, git, or
  // another editor). Tied to the project - not the explorer's visibility - so a
  // deleted file still closes its tab even with the explorer collapsed. Ref-counted
  // in main, so sibling sessions on the same project share one OS watcher.
  useEffect(() => {
    const fs = window.api?.fs;
    if (!fs?.watch || typeof cwd !== 'string' || !cwd) return;
    watchFolder(cwd);
    return () => unwatchFolder(cwd);
  }, [cwd]);

  // Explorer width (px) - persisted; same right-edge-drag convention as the dock.
  const [explorerWidth, setExplorerWidth] = usePersistedState<number>(
    windowChromeKey(EXPLORER_WIDTH_KEY),
    decodeExplorerWidth,
    String,
  );
  const { resizing: explorerResizing, startResize: startExplorerResize } = useEdgeResize({
    min: EXPLORER_MIN_WIDTH,
    max: EXPLORER_MAX_WIDTH,
    onResize: setExplorerWidth,
  });

  // The session-changes drawer (pane tab-strip toggle): per-session open state,
  // shared width, and a left-edge resize handle (right-anchored → inverted drag).
  const [changesDrawerOpen, setChangesDrawerOpen] = useState(
    () => changesDrawerMemory.get(sessionId) ?? false,
  );
  useEffect(() => {
    setChangesDrawerOpen(changesDrawerMemory.get(sessionId) ?? false);
  }, [sessionId]);
  // The review drawer is the git client's (Pro, a private plan › M4): the core
  // build has no drawer and the pane strip no toggle.
  const SessionDrawer = rendererExtension().git?.Drawer;
  const drawerShown = changesDrawerOpen && SessionDrawer !== undefined;
  const setDrawerOpen = (open: boolean): void => {
    changesDrawerMemory.set(sessionId, open);
    setChangesDrawerOpen(open);
  };
  const [drawerWidth, setDrawerWidth] = usePersistedState<number>(
    windowChromeKey(CHANGES_DRAWER_WIDTH_KEY),
    decodeChangesDrawerWidth,
    String,
  );
  const { resizing: drawerResizing, startResize: startDrawerResize } = useEdgeResize({
    min: CHANGES_DRAWER_MIN_WIDTH,
    max: CHANGES_DRAWER_MAX_WIDTH,
    invert: true,
    onResize: setDrawerWidth,
  });

  // Publish this session's live layout so the sidebar can read its tabs/splits
  // when tearing it off - even from another session's view, where it's not the
  // active workspace. Kept fresh via a ref so the getter never goes stale.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => registerSessionLayout(sessionId, () => layoutRef.current), [sessionId]);

  // Persist this session's layout (open tabs + split placement) so quitting and
  // reopening the app restores it. Structural changes - tabs added/removed/moved,
  // splits, renames - save immediately; pure resizes (a rapid stream from a
  // resize-handle drag) debounce, so we don't write on every pixel. The first run
  // (mount) is skipped: the layout was just seeded from disk or is the default, so
  // there's nothing new to write. Shells can't survive a restart - restore just
  // respawns them (re-running each tab's startup command), which is the point.
  const firstSave = useRef(true);
  const lastSig = useRef('');
  useEffect(() => {
    const sig = structuralSignature(layout);
    if (firstSave.current) {
      firstSave.current = false;
      lastSig.current = sig;
      return;
    }
    const save = (): void => window.api?.layout?.save(sessionId, layout);
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      save(); // tabs/splits changed → persist now (survives a quit moments later)
      return;
    }
    const handle = setTimeout(save, 400); // only sizes/active-pane changed → debounce
    return () => clearTimeout(handle);
  }, [sessionId, layout]);

  // A project window also streams the live layout to main on every change, so
  // closing the window hands this session back to the main window with the
  // tabs/splits it has NOW - the database copy above can be a debounce behind.
  // Same as a torn-off session window's sync (detached-window.tsx).
  useEffect(() => {
    if (getProjectScope()) window.api?.project?.syncLayout(sessionId, layout);
  }, [sessionId, layout]);

  // Derive this session's live status (active / needs-input / idle) from ALL its
  // terminal tabs - so an agent running in any tab is tracked, not just the primary
  // one - and fire desk alerts when it needs input. Keyed on the sorted shell-PTY
  // signature, NOT `layout`, so it re-subscribes only when the tab set actually
  // changes (a tab added/removed/torn off), not on every cursor move or resize.
  const shellPtyKey = shellPtyIds(layout).sort().join(',');
  useEffect(
    () => observeSessionStatus(sessionId, shellPtyKey ? shellPtyKey.split(',') : []),
    [sessionId, shellPtyKey],
  );

  // The question the agent is currently blocked on (cleared the moment it's
  // answered) - surfaced as a banner above the terminals, so it's visible even
  // when the asking tab isn't the active one or the prompt scrolled away.
  const question = useSessionQuestion(sessionId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-background">
      {/* File-explorer sidebar (rail "Files" toggle), rooted at the project dir.
          Lives inside the layout provider so clicking a file opens an editor tab. */}
      {explorerOpen && (
        <>
          <div
            style={{ width: explorerWidth }}
            className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
          >
            {typeof cwd === 'string' && cwd ? (
              <FileExplorer rootPath={cwd} onNewSessionAt={onNewSessionAt} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <FolderTree className="size-5 text-foreground-subtle" />
                <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-snug text-foreground-muted">
                  {cwd === undefined
                    ? 'Loading project…'
                    : 'This session has no project folder to browse.'}
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Once-per-version "a newer double0 is available" - above the tab strip,
            like the question banner below it - and, once ever, the "sessions
            kept running while double0 was closed" notice (main window only).
            The update banner is the official build's (a private plan › decision 12). */}
        {UpdateBanner && (
          <SlotBoundary name="banner">
            <UpdateBanner />
          </SlotBoundary>
        )}
        <KeptRunningBanner />
        <UnreachableBanner />
        {question && (
          <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/[0.08] px-3 py-1.5">
            <CircleHelp className="size-3.5 shrink-0 text-warning" />
            <span
              title={question.question}
              className="min-w-0 shrink-0 truncate text-xs font-medium text-warning"
              style={{ maxWidth: '60%' }}
            >
              {question.question}
            </span>
            {question.options.length > 0 && (
              <span
                title={question.options.join(' · ')}
                className="min-w-0 flex-1 truncate text-xs text-foreground-muted"
              >
                {question.options.join(' · ')}
              </span>
            )}
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1">
          <WorkspaceBody
            cwd={cwd}
            isWorktree={isWorktree}
            isActiveSession={isActiveSession}
            sessionId={sessionId}
            hideTabStrips={verticalTabs}
            changesDrawerOpen={drawerShown}
            onToggleChangesDrawer={
              SessionDrawer ? () => setDrawerOpen(!changesDrawerOpen) : undefined
            }
          />
          {/* Session-changes drawer: right-anchored, resized from its left edge. */}
          {drawerShown && SessionDrawer && (
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
              <div
                style={{ width: drawerWidth }}
                className="flex shrink-0 flex-col overflow-hidden"
              >
                <SlotBoundary name="drawer">
                  <SessionDrawer onClose={() => setDrawerOpen(false)} onOpenTool={onOpenTool} />
                </SlotBoundary>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The last few path segments (`…/parent/child/leaf`) - a compact status-bar
 * display; the full path lives in the segment's hover tooltip. */
function shortPath(path: string, count = 3): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-count).join('/');
  return parts.length > count ? `…/${tail}` : tail;
}

/**
 * The session's status bar - path, branch and terminal count on the left; the
 * focused tab's inputs (`InputsStatusItem`) and the extension's items
 * (`statusBarItems`) on the right, nothing else.
 * Rendered at the bottom of the workspace's right side (full width, below the
 * bottom panel), inside the layout provider so it can read the live terminal-tab
 * count. `sessionPath` is the folder the session runs in (its worktree/subfolder
 * root), so it re-points whenever a different session is viewed.
 */
export function WorkspaceStatusBar({ sessionPath }: { sessionPath: string | null }) {
  const { layout } = useWorkspaceLayout();
  const { status } = useGit();
  // Only tabs with a shell count (no editor, no extension view).
  // Shells this build runs - never a tab of a kind it does not render.
  const terminalCount = shellPtyIds(layout).length;
  // The checked-out branch, not the session's name: a git-branch icon has to
  // answer "what am I committing to", which a checkout in a terminal changes
  // under a session whose name never moves. Same root as the rest of the
  // workspace's git surfaces, so a worktree picked in a git tool is
  // reported here too. Null while the status loads, and outside a repo - there
  // is no branch to name then, so the segment stays out of the bar.
  const branch = status?.branch ?? (status?.detached ? 'detached HEAD' : null);
  // The focused tab's shell - the inputs and the extension's items speak for it.
  const activePane = getPane(layout, layout.activePaneId);
  const focusedTab = activePane ? layout.tabs[activePane.activeTabId] : undefined;
  const focusedPtyId =
    focusedTab && focusedTab.kind !== 'editor' ? (focusedTab.ptyId ?? null) : null;
  // Read at render time, never at module load (the extension installs first).
  const items = rendererExtension().statusBarItems ?? [];
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 font-mono text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-foreground-muted">
      {sessionPath && (
        <>
          <span className="flex min-w-0 items-center gap-1" title={sessionPath}>
            <Folder className="size-[11px] shrink-0" />
            <span className="max-w-[360px] truncate">{shortPath(sessionPath)}</span>
          </span>
          <div className="h-3 w-px shrink-0 bg-border" />
        </>
      )}
      {branch && (
        <span className="flex min-w-0 items-center gap-1" title={branch}>
          <GitBranch className="size-[11px] shrink-0 text-primary" />
          <span className="max-w-[240px] truncate">{branch}</span>
        </span>
      )}
      <span className="flex items-center gap-1">
        <SquareTerminal className="size-[11px]" />
        {terminalCount === 0
          ? 'No terminals'
          : `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`}
      </span>
      <div className="flex-1" />
      <InputsStatusItem focusedPtyId={focusedPtyId} />
      {items.map((Item, i) => (
        // Each item alone: one that fails leaves the bar and its neighbours (2026-11-18).
        <SlotBoundary key={i} name="status-bar-item">
          <Item focusedPtyId={focusedPtyId} sessionPath={sessionPath} />
        </SlotBoundary>
      ))}
    </div>
  );
}
