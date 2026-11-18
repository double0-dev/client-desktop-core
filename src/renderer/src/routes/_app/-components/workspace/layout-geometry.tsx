import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { PaneEmptyState } from '@renderer/routes/_app/-components/workspace/pane-empty-state';
import { PaneTabStrip } from '@renderer/routes/_app/-components/workspace/pane-tab-strip';
import {
  shellPtyIds,
  type NodeId,
  type PaneNode,
  type TabId,
} from '@renderer/lib/workspace/layout';
import { rendererExtension } from '@renderer/lib/extension/registry';
import type { SessionServer } from '@renderer/lib/extension/types';

/** A live tab drag, body-wide: which strip (if any) opens a gap, and where. */
export type LayoutStripDrag = {
  tabId: TabId;
  /** The dragged tab's pre-drag width - the size of the gap. */
  width: number;
  /** The hovered strip + insertion index, or null (pane body / off-window). */
  target: { paneId: NodeId; index: number } | null;
};

/**
 * Renders the layout tree as the geometry/chrome layer: nested
 * `react-resizable-panels` for the splits + dividers, and each leaf pane's tab
 * strip and an empty content slot that the rect registry measures.
 *
 * It sits ABOVE the terminal layer but is `pointer-events-none` everywhere
 * except the strips and resize handles. That lets terminal-body interaction
 * (clicks, selection, scroll) fall through to the terminals underneath, while
 * dividers stay grabbable even where they visually overlap a terminal edge - no
 * gutters or z-index fights required.
 */
const NO_SERVERS: readonly SessionServer[] = [];
const noServers = (): readonly SessionServer[] => NO_SERVERS;

export function LayoutGeometry({
  registerPane,
  cwd,
  isWorktree,
  onTabPointerDown,
  onOpenTabInWindow,
  hideTabStrips = false,
  stripDrag = null,
  changesDrawerOpen = false,
  onToggleChangesDrawer,
  browserSessionId,
}: {
  registerPane: (paneId: NodeId) => (el: HTMLElement | null) => void;
  /** This session's folder (worktree or project dir) - the tab strip's "Open in IDE" target. */
  cwd: string | null;
  /** Whether `cwd` is a git worktree - only affects the launcher's wording. */
  isWorktree: boolean;
  onTabPointerDown?: (e: React.PointerEvent, tabId: TabId) => void;
  /** Tab menu's "Open in separate window" - owned by the body, which knows the cwd. */
  onOpenTabInWindow: (tabId: TabId) => void;
  /** Vertical-tabs mode: render panes without their strips (the dock's Tabs
   * panel switches/closes tabs instead); splits + dividers stay. */
  hideTabStrips?: boolean;
  /** The live tab drag - threads the slide-apart gap into each pane's strip. */
  stripDrag?: LayoutStripDrag | null;
  /** Session-changes drawer state → the strips' file-diff toggle button. */
  changesDrawerOpen?: boolean;
  onToggleChangesDrawer?: () => void;
  /**
   * The session whose browser tabs the strips open (globe, hold-+ menu);
   * absent in a torn-off terminal window, which holds terminals only.
   */
  browserSessionId?: string | null;
}) {
  const {
    layout,
    dispatch,
    addTerminal,
    addTemplateTerminal,
    splitWithNewTerminal,
    closeTab,
    closeTabs,
    dirtyTabs,
    openBrowser,
  } = useWorkspaceLayout();
  const ptyIds = useMemo(() => shellPtyIds(layout), [layout]);
  // The session's dev servers for the hold-+ menu - the browser's (Pro, M5);
  // the slot is fixed for the window's life, so the hook runs on every render
  // alike.
  const useSessionServers = rendererExtension().browser?.useSessionServers ?? noServers;
  const viewSlot = rendererExtension().sessionView;
  const sessionServerList = useSessionServers(ptyIds, browserSessionId ?? '');
  const servers = browserSessionId === undefined ? NO_SERVERS : sessionServerList;

  // react-resizable-panels fires onLayout continuously during a divider drag and
  // handles the live visual resize itself; we only need to persist the FINAL
  // sizes into our model. Debounce per split so a drag commits once on settle,
  // instead of dispatching a full layout copy (+ re-render + re-measure cascade)
  // every frame.
  const resizeTimers = useRef(new Map<NodeId, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = resizeTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);
  const commitResize = useCallback(
    (splitId: NodeId, sizes: number[]) => {
      const timers = resizeTimers.current;
      const pending = timers.get(splitId);
      if (pending) clearTimeout(pending);
      timers.set(
        splitId,
        setTimeout(() => {
          timers.delete(splitId);
          dispatch({ type: 'resize', splitId, sizes });
        }, 120),
      );
    },
    [dispatch],
  );

  function renderNode(nodeId: NodeId): React.ReactNode {
    const node = layout.nodes[nodeId];
    if (!node) return null;

    if (node.type === 'pane') {
      const isActivePane = layout.activePaneId === node.id;
      return (
        <div
          // The focus frame (globals.css): the active pane is outlined for a few
          // seconds after ⇧⌘Arrow lands in the surface - the same frame the
          // sidebar sections show when the shortcut lands there, so it always
          // marks one place.
          className={cn(
            'flex size-full flex-col overflow-hidden focus-frame',
            isActivePane && 'focus-frame-pane',
          )}
        >
          {!hideTabStrips && (
            <PaneTabStrip
              pane={node as PaneNode}
              tabs={layout.tabs}
              isActivePane={isActivePane}
              dirtyTabs={dirtyTabs}
              cwd={cwd}
              isWorktree={isWorktree}
              onSelectTab={(tabId) => dispatch({ type: 'setActiveTab', paneId: node.id, tabId })}
              onCloseTab={closeTab}
              onCloseTabs={closeTabs}
              onOpenInWindow={onOpenTabInWindow}
              // An extension's view over a tab's agent: no toggle without one.
              onToggleView={
                viewSlot
                  ? (tabId) =>
                      dispatch({
                        type: 'setTabView',
                        tabId,
                        view: layout.tabs[tabId]?.view === viewSlot.view ? null : viewSlot.view,
                      })
                  : undefined
              }
              onAddTerminal={() => addTerminal(node.id)}
              onAddTemplateTerminal={(title, command) =>
                addTemplateTerminal(title, command, node.id)
              }
              onSplit={() => splitWithNewTerminal(node.id, 'right')}
              onTabPointerDown={onTabPointerDown}
              changesDrawerOpen={changesDrawerOpen}
              onToggleChangesDrawer={onToggleChangesDrawer}
              onOpenBrowser={
                browserSessionId === undefined || !openBrowser
                  ? undefined
                  : (url, o) =>
                      openBrowser(url ?? '', {
                        paneId: node.id,
                        // Side by side: always a new page beside this pane.
                        ...(o?.split ? { split: 'right' as const, newTab: true } : {}),
                      })
              }
              servers={servers}
              drag={
                stripDrag && {
                  tabId: stripDrag.tabId,
                  width: stripDrag.width,
                  index: stripDrag.target?.paneId === node.id ? stripDrag.target.index : null,
                }
              }
            />
          )}
          {/* Empty, transparent slot - geometry only. The terminal is painted by
              the terminal layer beneath, positioned to this slot's measured rect.
              With no tabs left (only ever the sole root pane) there's nothing
              beneath, so the slot itself shows the "No tabs open" state. */}
          <div ref={registerPane(node.id)} className="relative min-h-0 flex-1">
            {node.tabs.length === 0 && (
              <PaneEmptyState onNewTerminal={() => addTerminal(node.id)} />
            )}
          </div>
        </div>
      );
    }

    const orientation = node.direction === 'row' ? 'horizontal' : 'vertical';
    return (
      <Group
        id={node.id}
        orientation={orientation}
        onLayoutChanged={(layout) =>
          commitResize(
            node.id,
            node.children.map((id) => layout[id] ?? 0),
          )
        }
        className="size-full"
      >
        {node.children.map((childId, i) => (
          <Fragment key={childId}>
            {i > 0 && (
              <Separator
                className={cn(
                  'pointer-events-auto relative bg-border transition-colors',
                  'data-[separator=hover]:bg-primary/60 data-[separator=active]:bg-primary',
                  orientation === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
                )}
              />
            )}
            <Panel
              id={childId}
              defaultSize={`${node.sizes[i]}%`}
              minSize="10%"
              className="flex min-h-0 min-w-0"
            >
              {renderNode(childId)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    );
  }

  // pointer-events-none here; since pointer-events inherits, the strips and
  // resize handles re-enable themselves (and their children) while everything
  // else - including the empty pane slots - lets events fall through to the
  // terminal layer beneath.
  return <div className="pointer-events-none size-full">{renderNode(layout.rootId)}</div>;
}
