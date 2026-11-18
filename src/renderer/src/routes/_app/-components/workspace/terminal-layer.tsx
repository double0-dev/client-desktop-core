import { rendersTabKind } from '@renderer/lib/workspace/tab-kinds';
import { showsView } from '@renderer/lib/workspace/tab-kinds';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { memo, useMemo } from 'react';
import { agentCliName, followsAgentCli } from '@renderer/lib/session/cli-view';
import {
  allTabs,
  type NodeId,
  type Tab,
  type TabId,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import { TerminalView } from '@renderer/routes/_app/-components/workspace/terminal-view';
import { getPooledTerminal } from '@renderer/lib/terminal/pool';
import { useTerminalTheme } from '@renderer/lib/settings/terminal-settings';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';

/**
 * One pooled terminal, absolutely positioned over its pane's content rect.
 * Memoized: layout churn that doesn't touch this tab - a focus flip in another
 * pane, a resize that only moved other panes (rect identity is preserved for
 * unmoved panes by `usePaneRects`) - skips its render entirely. Tab objects are
 * never recreated by layout ops, so the `tab` prop is identity-stable too.
 */
const TerminalSlot = memo(function TerminalSlot({
  tab,
  ptyId,
  paneId,
  rect,
  isActiveInPane,
  isFocused,
  cwd,
  onActivatePane,
  onShowView,
}: {
  tab: Tab;
  ptyId: string;
  paneId: NodeId | null;
  rect: PaneRect | undefined;
  /** This tab is its pane's active (visible) tab. */
  isActiveInPane: boolean;
  /** …and its pane is the focused pane of the active session. */
  isFocused: boolean;
  cwd?: string | null;
  onActivatePane: (paneId: NodeId) => void;
  /** Show the tab in the extension's view over its agent (the button over an agent's terminal). */
  onShowView?: (tabId: TabId) => void;
}) {
  const viewSlot = onShowView ? rendererExtension().sessionView : undefined;
  // The wrapper paints the active theme's background so the padding and the
  // cell-grid rounding remainder from fit() blend into the terminal instead of
  // framing it.
  const terminalBg = useTerminalTheme().background ?? '#0d0d0d';
  // Inactive tabs use display:none (not visibility:hidden) so only one
  // terminal is in the layout at a time. Two overlapping xterms - one
  // hidden - make a freshly-focused terminal blur itself; display:none
  // removes the hidden one from layout entirely and avoids that.
  //
  // Positioned with left/top, NOT `transform: translate()`: a fractional
  // translate puts the xterm's WebGL canvas on a sub-pixel offset and the
  // compositor resamples it - every pane but the first (x=0) rendered blurred
  // text. left/top are pixel-snapped by the layout engine (and the rects are
  // whole pixels anyway, see usePaneRects), so the canvas stays crisp.
  const style: React.CSSProperties = rect
    ? {
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        display: isActiveInPane ? 'block' : 'none',
        zIndex: isActiveInPane ? 1 : 0,
        backgroundColor: terminalBg,
      }
    : { display: 'none' };
  return (
    <div
      className="pointer-events-auto absolute overflow-hidden p-2"
      style={style}
      onPointerDown={() => paneId && onActivatePane(paneId)}
      // xterm preventDefaults mousedown, so the browser's native
      // click-to-focus doesn't land in this overlay. Focus the clicked
      // terminal explicitly - deferred a frame, because focusing
      // synchronously during the click gets overridden, whereas a
      // post-click focus (same as the tab path) sticks.
      onPointerUp={() => {
        const term = getPooledTerminal(ptyId)?.term;
        if (term) requestAnimationFrame(() => term.focus());
      }}
    >
      {onShowView && viewSlot && followsAgentCli(tab) && (
        // The way back to the view - its own "Terminal" button's twin.
        <button
          type="button"
          title={viewSlot.labels.buttonTitle(agentCliName(tab))}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => onShowView(tab.id)}
          className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated/90 px-2 py-1 text-xs text-foreground-muted opacity-70 shadow-sm transition-opacity hover:text-foreground hover:opacity-100"
        >
          <viewSlot.Icon className="size-3.5" />
          {viewSlot.labels.button}
        </button>
      )}
      <TerminalView
        ptyId={ptyId}
        cwd={cwd}
        active={isFocused}
        className="size-full"
        // Each tab carries its own startup command (set from the session's
        // template), so the primary tab and any new terminals opened in a
        // Claude Code session all launch the agent.
        initialCommand={tab.startupCommand}
      />
    </div>
  );
});

/**
 * The terminal layer: a flat pool of every tab's `TerminalView`, each absolutely
 * positioned over its current pane's measured content rect. The array is keyed
 * by tab id and never reordered, so restructuring the layout (split / move /
 * resize) only changes a terminal's position and visibility - never its place in
 * the React tree - and the shell is never remounted.
 *
 * Sits beneath the geometry layer; only the active tab in each pane is visible.
 */
export function TerminalLayer({
  layout,
  rects,
  version,
  cwd,
  isActiveSession,
  onActivatePane,
  onShowView,
}: {
  layout: WorkspaceLayout;
  rects: Map<NodeId, PaneRect>;
  /** Changes whenever rects change; presence in props re-renders this layer. */
  version: number;
  /** `undefined` while the working dir is still resolving (shells wait). */
  cwd?: string | null;
  isActiveSession: boolean;
  onActivatePane: (paneId: NodeId) => void;
  onShowView?: (tabId: TabId) => void;
}) {
  void version;
  const { activePaneId } = layout;

  // tabId → owning paneId, built once per layout instead of scanning every node
  // per tab (`paneOf` would make this render O(tabs × nodes)).
  const paneByTab = useMemo(() => {
    const map = new Map<TabId, NodeId>();
    for (const id in layout.nodes) {
      const node = layout.nodes[id];
      if (node.type === 'pane') for (const t of node.tabs) map.set(t, id);
    }
    return map;
  }, [layout.nodes]);

  return (
    <div className="pointer-events-none absolute inset-0">
      {allTabs(layout)
        // Never a kind this build does not render (tab-kinds.ts): such a tab
        // shows a placeholder and must not spawn a shell under its ptyId.
        .filter((tab) => tab.kind !== 'editor' && rendersTabKind(tab.kind))
        .map((tab) => {
          // Non-editor tabs always own a PTY id; this also narrows the type.
          if (!tab.ptyId) return null;
          const paneId = paneByTab.get(tab.id) ?? null;
          const pane = paneId ? layout.nodes[paneId] : undefined;
          const isActiveInPane = !!pane && pane.type === 'pane' && pane.activeTabId === tab.id;
          return (
            <TerminalSlot
              key={tab.id}
              tab={tab}
              ptyId={tab.ptyId}
              paneId={paneId}
              rect={paneId ? rects.get(paneId) : undefined}
              isActiveInPane={isActiveInPane}
              // Shown in the extension's view: its layer covers it and takes the keys.
              isFocused={
                isActiveSession && isActiveInPane && paneId === activePaneId && !showsView(tab)
              }
              cwd={cwd}
              onActivatePane={onActivatePane}
              onShowView={onShowView}
            />
          );
        })}
    </div>
  );
}
