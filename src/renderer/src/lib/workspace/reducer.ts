import {
  addTab,
  moveTab,
  removeTab,
  resizeSplit,
  setActivePane,
  setActiveTab,
  showTab,
  setPageTab,
  setEditorTabPath,
  setTabView,
  splitPane,
  syncConversationTab,
  type Edge,
  type NodeId,
  type Tab,
  type TabId,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';

/**
 * Pure reducer over the workspace layout. Every case delegates to a pure op in
 * `workspace-layout.ts`. It contains NO side effects (no id minting, no PTY
 * disposal) - those live in the dispatchers' action helpers, which is why the
 * split actions carry pre-minted node ids - so it stays safe under React
 * StrictMode's double-invocation.
 */
export type WorkspaceAction =
  | { type: 'addTab'; paneId: NodeId; tab: Tab; index?: number }
  | {
      /** Add `tab` (any kind - a terminal, a browser tab) on a new split of `paneId`. */
      type: 'splitNewTerminal';
      paneId: NodeId;
      edge: Edge;
      tab: Tab;
      /** Pre-minted (dispatch-side) ids for the pane/split the op creates. */
      newPaneId: NodeId;
      splitId: NodeId;
    }
  | { type: 'closeTab'; tabId: TabId }
  | {
      type: 'split';
      targetPaneId: NodeId;
      edge: Edge;
      tabId: TabId;
      /** Pre-minted (dispatch-side) ids for the pane/split the op creates. */
      newPaneId: NodeId;
      splitId: NodeId;
    }
  | { type: 'moveTab'; tabId: TabId; toPaneId: NodeId; index: number }
  | { type: 'setActiveTab'; paneId: NodeId; tabId: TabId }
  /** Bring a tab to the front of its pane without making that pane the active one. */
  | { type: 'showTab'; tabId: TabId }
  | { type: 'setActivePane'; paneId: NodeId }
  | { type: 'renameEditorTab'; tabId: TabId; filePath: string; title: string }
  | { type: 'resize'; splitId: NodeId; sizes: number[] }
  | { type: 'syncConversation'; title: string; startupCommand?: string }
  | { type: 'setTabView'; tabId: TabId; view: string | null }
  | { type: 'setPageTab'; tabId: TabId; url?: string; title?: string };

export function workspaceReducer(state: WorkspaceLayout, action: WorkspaceAction): WorkspaceLayout {
  switch (action.type) {
    case 'addTab':
      return addTab(state, action.paneId, action.tab, action.index);
    case 'splitNewTerminal':
      // Add the new terminal to the pane, then split it out onto the chosen edge.
      return splitPane(
        addTab(state, action.paneId, action.tab),
        action.paneId,
        action.edge,
        action.tab.id,
        { newPaneId: action.newPaneId, splitId: action.splitId },
      );
    case 'closeTab':
      return removeTab(state, action.tabId);
    case 'split':
      return splitPane(state, action.targetPaneId, action.edge, action.tabId, {
        newPaneId: action.newPaneId,
        splitId: action.splitId,
      });
    case 'moveTab':
      return moveTab(state, action.tabId, action.toPaneId, action.index);
    case 'setActiveTab':
      return setActiveTab(state, action.paneId, action.tabId);
    case 'showTab':
      return showTab(state, action.tabId);
    case 'setActivePane':
      return setActivePane(state, action.paneId);
    case 'renameEditorTab':
      return setEditorTabPath(state, action.tabId, action.filePath, action.title);
    case 'resize':
      return resizeSplit(state, action.splitId, action.sizes);
    case 'syncConversation':
      return syncConversationTab(state, action.title, action.startupCommand);
    case 'setTabView':
      return setTabView(state, action.tabId, action.view);
    case 'setPageTab':
      return setPageTab(state, action.tabId, { url: action.url, title: action.title });
    default:
      return state;
  }
}
