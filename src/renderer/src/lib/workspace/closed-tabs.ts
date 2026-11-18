import {
  isPageTab,
  type NodeId,
  type Tab,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';

/**
 * Recently closed tabs, for Reopen closed tab (⇧⌘T). Per workspace (session)
 * and in memory only. Only tabs that can come back as they were are kept: an
 * editor (its file) and a page tab (its page). A closed shell's process is
 * gone - a "reopened" terminal would be a different shell, and one whose start
 * command re-launched an agent would be worse than nothing.
 */
export type ClosedTab = {
  tab: Tab;
  /** The pane it sat in, and where in its strip. */
  paneId: NodeId;
  index: number;
};

/** How many closed tabs a workspace remembers. */
export const CLOSED_TAB_LIMIT = 20;

export function isReopenable(tab: Tab): boolean {
  if (tab.kind === 'editor') return !!tab.filePath;
  return isPageTab(tab);
}

/** The stack with `entry` on top (newest last), capped, or unchanged when the
 * tab cannot come back. */
export function rememberClosed(stack: ClosedTab[], entry: ClosedTab): ClosedTab[] {
  if (!isReopenable(entry.tab)) return stack;
  const next = [...stack, entry];
  return next.length > CLOSED_TAB_LIMIT ? next.slice(next.length - CLOSED_TAB_LIMIT) : next;
}

/**
 * Where a reopened tab goes: its old pane at its old place when that pane
 * still exists, else the active pane's end. The tab gets a fresh id (the old
 * id is never reused for a second life of a tab).
 */
export function reopenTarget(
  layout: WorkspaceLayout,
  entry: ClosedTab,
  newId: string,
): { paneId: NodeId; index?: number; tab: Tab } {
  const tab: Tab = { ...entry.tab, id: newId };
  const pane = layout.nodes[entry.paneId];
  if (pane?.type === 'pane') {
    return { paneId: entry.paneId, index: Math.min(entry.index, pane.tabs.length), tab };
  }
  return { paneId: layout.activePaneId, tab };
}

/** The newest entry and the rest of the stack. */
export function popClosed(stack: ClosedTab[]): { entry: ClosedTab | null; rest: ClosedTab[] } {
  if (stack.length === 0) return { entry: null, rest: stack };
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
