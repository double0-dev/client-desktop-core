import { getPane, type TabId, type WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { showsView } from '@renderer/lib/workspace/tab-kinds';
import { getPooledTerminal } from '@renderer/lib/terminal/pool';

/**
 * Explicitly put the caret into the surface's active tab - the terminal or
 * editor the active pane shows. Used when focus returns to the surface from a
 * sidebar region (⇧⌘→ out of the explorer / dock): nothing in the layout
 * changes then, so the surface's own "focus when I become active" effects
 * don't fire, and something has to move focus deliberately.
 *
 * Terminals are reachable through the pool by pty id; editors register a focus
 * callback here (there's no global handle to a mounted Monaco instance).
 */

const editorFocus = new Map<TabId, () => void>();

/** A mounted file editor or extension view publishes how to focus itself; returns the unregister. */
export function registerEditorFocus(tabId: TabId, focus: () => void): () => void {
  editorFocus.set(tabId, focus);
  return () => {
    if (editorFocus.get(tabId) === focus) editorFocus.delete(tabId);
  };
}

/** Focus the active pane's active tab; false when there's nothing focusable
 * (no tabs, an image viewer, an editor still loading). */
export function focusActiveTab(layout: WorkspaceLayout): boolean {
  const pane = getPane(layout, layout.activePaneId);
  const tab = pane ? layout.tabs[pane.activeTabId] : undefined;
  if (!tab) return false;
  // A registered focus wins: an editor, or an extension view (over a terminal's
  // `claude` too - its hidden terminal must not take the keys).
  const focus = editorFocus.get(tab.id);
  if (focus) {
    focus();
    return true;
  }
  if (tab.kind === 'editor' || showsView(tab)) return false;
  if (!tab.ptyId) return false;
  const term = getPooledTerminal(tab.ptyId)?.term;
  if (!term) return false;
  term.focus();
  return true;
}
