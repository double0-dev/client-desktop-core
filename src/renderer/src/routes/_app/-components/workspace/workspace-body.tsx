import { useCallback, useEffect, useRef, useState } from 'react';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { TerminalLayer } from '@renderer/routes/_app/-components/workspace/terminal-layer';
import { EditorLayer } from '@renderer/routes/_app/-components/workspace/editor-layer';
import { UnavailableTabLayer } from '@renderer/routes/_app/-components/workspace/unavailable-tab-layer';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { LayoutGeometry } from '@renderer/routes/_app/-components/workspace/layout-geometry';
import { DragLayer, DropIndicator } from '@renderer/routes/_app/-components/workspace/drag-layer';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { usePaneRects } from '@renderer/lib/workspace/use-pane-rects';
import {
  useTabDrag,
  computeDropTarget,
  type DropTarget,
} from '@renderer/lib/workspace/use-tab-drag';
import { disposePooledTerminal } from '@renderer/lib/terminal/pool';
import { markTerminalSeen, subscribeTerminalBusy } from '@renderer/lib/terminal/busy';
import { useTerminalTheme } from '@renderer/lib/settings/terminal-settings';
import {
  registerWorkspaceController,
  setActiveWorkspace,
  type WorkspaceController,
} from '@renderer/lib/workspace/bridge';
import {
  allTabs,
  isTearable,
  visibleShellPtyIds,
  type NodeId,
  type Tab,
  type TabId,
} from '@renderer/lib/workspace/layout';
import type { TabDescriptor } from '@renderer/lib/transfer';

/**
 * The split-pane terminal surface shared by the in-app workspace and detached
 * terminal windows: a terminal layer beneath a click-through geometry layer,
 * plus the drag overlay. Every mounted body registers its cross-window
 * controller (so `tab:removed` can reach a session the user has switched away
 * from); the one that `isActiveSession` is additionally marked active, making it
 * the surface incoming tabs are inserted into.
 */
export function WorkspaceBody({
  cwd,
  isWorktree = false,
  isActiveSession,
  sessionId,
  browserSessionId = sessionId,
  hideTabStrips = false,
  onEmptiedByTransfer,
  changesDrawerOpen = false,
  onToggleChangesDrawer,
}: {
  cwd?: string | null;
  /** Whether `cwd` is a git worktree - threaded to the tab strip's "Open in IDE". */
  isWorktree?: boolean;
  isActiveSession: boolean;
  /**
   * Registry key for the cross-window controller. The in-app host passes its
   * session id; a detached window omits it (it mounts exactly one body, so the
   * fallback key can't collide).
   */
  sessionId?: string;
  /**
   * The session browser tabs belong to (their review, the dev servers they
   * list) - `sessionId` by default; a torn-off session window passes its own.
   * Absent in a torn-off terminal window: no browser there.
   */
  browserSessionId?: string;
  /** Vertical-tabs mode: skip the per-pane strips (the dock's Tabs panel lists
   * them instead). Only the in-app surface sets this - never detached windows. */
  hideTabStrips?: boolean;
  /**
   * A cross-window transfer just removed this body's last tab (its shell lives
   * on in another window). Detached windows pass `window.close` - emptied by a
   * drag-out they close browser-style, while a user closing the last tab keeps
   * the window on its "No tabs open" state. The in-app surface passes nothing.
   */
  onEmptiedByTransfer?: () => void;
  /** Session-changes drawer state → the pane strips' toggle button (in-app
   * surface only; detached windows have no drawer). */
  changesDrawerOpen?: boolean;
  onToggleChangesDrawer?: () => void;
}) {
  const BrowserLayer = rendererExtension().browser?.Layer;
  const viewSlot = rendererExtension().sessionView;
  const ViewLayer = viewSlot?.Layer;
  const { layout, dispatch } = useWorkspaceLayout();

  // Seeing is clearing: a tab's finished-unseen wash (terminal/busy) drops the
  // moment the user can see the tab - it is the active tab of a pane, this body
  // is the on-screen session, and the window has focus. Checked on every busy
  // change and layout change (selecting the tab is the common clear), and on
  // window focus (the finish happened while the app was in the background).
  // Imperative subscription, not useTerminalBusyMap - the body must not
  // re-render every pane on every busy flip.
  useEffect(() => {
    if (!isActiveSession) return;
    const check = (): void => {
      if (!document.hasFocus()) return;
      visibleShellPtyIds(layout).forEach(markTerminalSeen);
    };
    check();
    const offBusy = subscribeTerminalBusy(check);
    window.addEventListener('focus', check);
    return () => {
      offBusy();
      window.removeEventListener('focus', check);
    };
  }, [layout, isActiveSession]);

  const terminalBg = useTerminalTheme().background ?? '#0d0d0d';
  const bodyRef = useRef<HTMLDivElement>(null);
  const structuralKey = Object.keys(layout.nodes).sort().join(',');
  const { registerPane, rects, version } = usePaneRects(bodyRef, structuralKey);
  const { onTabPointerDown, dragState } = useTabDrag({
    containerRef: bodyRef,
    rects,
    layout,
    dispatch,
    cwd: cwd ?? null,
  });
  const onActivatePane = useCallback(
    (paneId: NodeId) => dispatch({ type: 'setActivePane', paneId }),
    [dispatch],
  );
  // Stable: the terminal slots are memoized.
  const shownView = viewSlot?.view;
  const onShowView = useCallback(
    (tabId: TabId) => {
      if (shownView) dispatch({ type: 'setTabView', tabId, view: shownView });
    },
    [dispatch, shownView],
  );

  // The strips' slide-apart preview: while a local drag is over a strip, that
  // strip opens a gap at the insertion index (pane-tab-strip.tsx); the dragged
  // tab collapses everywhere. Null outside a drag.
  const stripDrag = dragState
    ? {
        tabId: dragState.tabId,
        width: dragState.tabWidth,
        target:
          !dragState.outside && dragState.target?.kind === 'strip'
            ? { paneId: dragState.target.paneId, index: dragState.target.index }
            : null,
      }
    : null;

  // A tab from another window is being dragged over this one: the live drop
  // placeholder to draw (forwarded from main as a window-client point). Mirrors
  // the local `dragState.target`, but for a drag happening in a different window.
  const [externalPreview, setExternalPreview] = useState<DropTarget | null>(null);

  // Fresh refs for the controller, which is invoked from window-level IPC.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const rectsRef = useRef(rects);
  rectsRef.current = rects;
  const onEmptiedByTransferRef = useRef(onEmptiedByTransfer);
  onEmptiedByTransferRef.current = onEmptiedByTransfer;

  // Tab menu's "Open in separate window": the same transfer as dropping a tab
  // past the window edge, but forced into a brand-new window - the cursor is
  // still over THIS window on a menu click, so cursor routing would misfire.
  // Origin-side removal rides the normal `tab:removed` reply.
  const openTabInNewWindow = useCallback(
    (tabId: TabId) => {
      const tab = layoutRef.current.tabs[tabId];
      if (!tab?.ptyId || !isTearable(tab)) return;
      window.api?.tab?.dropExternal(
        { kind: 'terminal', termId: tab.ptyId, title: tab.title, cwd: cwd ?? null },
        { newWindow: true },
      );
    },
    [cwd],
  );

  const controllerRef = useRef<WorkspaceController>({
    insertExternalTab: (descriptor: TabDescriptor, clientX, clientY) => {
      setExternalPreview(null);
      const tab: Tab = {
        id: crypto.randomUUID(),
        kind: 'terminal',
        title: descriptor.title,
        ptyId: descriptor.termId,
      };
      // Resolve the drop with the SAME hit-test the preview used, so the tab
      // lands exactly where the DropIndicator promised: a split half splits the
      // pane, a strip caret inserts at that index, a pane body appends.
      const target = computeDropTarget(bodyRef.current, rectsRef.current, clientX, clientY);
      if (target?.kind === 'split') {
        // `splitNewTerminal` adds the tab to the pane and splits it out in one
        // action - exactly what adopting an external shell into a split needs.
        // Node ids are minted here, dispatch-side, to keep the reducer pure.
        dispatch({
          type: 'splitNewTerminal',
          paneId: target.paneId,
          edge: target.edge,
          tab,
          newPaneId: crypto.randomUUID(),
          splitId: crypto.randomUUID(),
        });
      } else if (target?.kind === 'strip') {
        dispatch({ type: 'addTab', paneId: target.paneId, tab, index: target.index });
      } else {
        dispatch({
          type: 'addTab',
          paneId: target?.paneId ?? layoutRef.current.activePaneId,
          tab,
        });
      }
      // Every branch lands the tab somewhere (addTab falls back to the first
      // leaf), so a mounted body always accepts - the ack matters for the case
      // where NO body is mounted, handled at the window level in main.tsx.
      return true;
    },
    removeTabByPtyId: (ptyId) => {
      const tab = allTabs(layoutRef.current).find((t) => t.ptyId === ptyId);
      // Only tearable tabs can have been transferred.
      if (!tab || !isTearable(tab)) return false;
      // The shell moved to another window - drop our xterm but keep the PTY.
      disposePooledTerminal(ptyId, false);
      dispatch({ type: 'closeTab', tabId: tab.id });
      // Transferring the last tab away empties this body: a detached window
      // closes itself here (unlike a user close, which shows "No tabs open").
      if (allTabs(layoutRef.current).length === 1) onEmptiedByTransferRef.current?.();
      return true;
    },
    previewExternalDrop: (clientX, clientY) => {
      setExternalPreview(computeDropTarget(bodyRef.current, rectsRef.current, clientX, clientY));
    },
    clearExternalDropPreview: () => setExternalPreview(null),
  });
  // Register for the lifetime of the mount - hidden sessions stay reachable for
  // `tab:removed` - and additionally mark this body active while it's the
  // visible one (insert/preview targets).
  const registryKey = sessionId ?? 'detached';
  useEffect(() => registerWorkspaceController(registryKey, controllerRef.current), [registryKey]);
  useEffect(() => {
    if (!isActiveSession) return;
    return setActiveWorkspace(registryKey);
  }, [isActiveSession, registryKey]);

  return (
    <div
      ref={bodyRef}
      className="relative min-h-0 flex-1"
      // Match the terminal theme so pane gaps and resize slack don't read as a
      // black frame around themed terminals.
      style={{ backgroundColor: terminalBg }}
    >
      <TerminalLayer
        layout={layout}
        rects={rects}
        version={version}
        cwd={cwd}
        isActiveSession={isActiveSession}
        onActivatePane={onActivatePane}
        onShowView={ViewLayer ? onShowView : undefined}
      />
      <EditorLayer
        layout={layout}
        rects={rects}
        version={version}
        cwd={cwd ?? null}
        onActivatePane={onActivatePane}
      />
      {/* Browser tabs are Pro (a private plan › M5); none in the core build. */}
      {BrowserLayer && (
        <SlotBoundary name="page-layer">
          <BrowserLayer
            layout={layout}
            rects={rects}
            version={version}
            sessionId={browserSessionId ?? null}
            cwd={cwd ?? null}
            isActiveSession={isActiveSession}
            onActivatePane={onActivatePane}
          />
        </SlotBoundary>
      )}
      {/* An extension's view over the tabs; none in the core build. */}
      {ViewLayer && (
        <SlotBoundary name="view-layer">
          <ViewLayer
            sessionId={sessionId}
            hostId={currentHostOfPath(cwd)}
            layout={layout}
            rects={rects}
            version={version}
            isActiveSession={isActiveSession}
            onActivatePane={onActivatePane}
            onShowTerminal={(tabId) => dispatch({ type: 'setTabView', tabId, view: null })}
          />
        </SlotBoundary>
      )}
      <UnavailableTabLayer
        layout={layout}
        rects={rects}
        version={version}
        onActivatePane={onActivatePane}
      />
      <div className="pointer-events-none absolute inset-0 z-10">
        <LayoutGeometry
          registerPane={registerPane}
          cwd={cwd ?? null}
          isWorktree={isWorktree}
          onTabPointerDown={onTabPointerDown}
          onOpenTabInWindow={openTabInNewWindow}
          hideTabStrips={hideTabStrips}
          stripDrag={stripDrag}
          changesDrawerOpen={changesDrawerOpen}
          onToggleChangesDrawer={onToggleChangesDrawer}
          browserSessionId={browserSessionId}
        />
      </div>
      <DragLayer dragState={dragState} />
      {/* The drop placeholder for a tab being dragged in from ANOTHER window. */}
      <DropIndicator target={externalPreview} />
    </div>
  );
}
