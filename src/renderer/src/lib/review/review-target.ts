// Which agent a session's review goes to (a private plan):
// the pure pick plus the per-session focus history it reads.

import { cliViewKey } from '@renderer/lib/session/pty-ids';
import {
  isPrimaryViewTab,
  type Tab,
  type TabId,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';

/**
 * `key` is what the extension's prompt action takes: a runtime session's id,
 * or `cli:<ptyId>` for a terminal's own Claude Code / Codex (typed into the
 * terminal by main's watcher). `label` names the tab in the review bar ("to
 * Claude Code").
 */
export type ReviewTarget = { key: string; label: string };

function agentTab(tab: Tab | undefined): tab is Tab & { ptyId: string } {
  return (
    !!tab && (tab.kind === 'conversation' || tab.kind === 'terminal') && tab.ptyId !== undefined
  );
}

/**
 * The tab a review is sent to, or null when the session has none:
 * - a runtime session (`runtime` set): its agent;
 * - else the most recently focused tab that runs an agent (`recent`, newest
 *   first - the browser or an editor holds focus while you comment, so the
 *   focused tab alone would miss the one you were just talking to), else the
 *   session's conversation tab, else any tab that launched one.
 * A tab runs an agent when it launched one or `runsAgent` says a program in it
 * speaks the marker protocol (a `claude` typed into a "+" shell by hand).
 * A conversation tab with no start command (a plain Terminal session) is
 * still a target: the user may run `claude` in it by hand - main answers
 * with the reason when nothing is listening there.
 */
export function resolveReviewTarget(
  sessionId: string,
  layout: WorkspaceLayout | null,
  runtime: string | null | undefined,
  recent: readonly TabId[] = [],
  runsAgent: (ptyId: string) => boolean = () => false,
): ReviewTarget | null {
  if (runtime != null) {
    const primary = layout && Object.values(layout.tabs).find(isPrimaryViewTab);
    return { key: sessionId, label: primary?.title || 'the agent' };
  }
  if (!layout) return null;
  const pane = layout.nodes[layout.activePaneId];
  const focused = pane?.type === 'pane' ? pane.activeTabId : undefined;
  const hasAgent = (t: Tab | undefined): t is Tab & { ptyId: string } =>
    agentTab(t) && (!!t.startupCommand || runsAgent(t.ptyId));
  const tabs = Object.values(layout.tabs);
  const pick =
    [focused, ...recent].map((id) => (id ? layout.tabs[id] : undefined)).find(hasAgent) ??
    tabs.find((t) => t.kind === 'conversation' && agentTab(t)) ??
    tabs.find((t) => agentTab(t) && !!t.startupCommand);
  if (!agentTab(pick)) return null;
  return { key: cliViewKey(pick.ptyId), label: pick.title };
}

/** Per session, the terminal tabs focused in this window, newest first. Memory only. */
const recentTabs = new Map<string, TabId[]>();
const MAX_RECENT = 16;

/** Note that `tabId` took focus in `sessionId`'s workspace (any kind - only shells count). */
export function noteFocusedTab(sessionId: string, tab: Tab | undefined): void {
  if (!agentTab(tab)) return;
  const list = recentTabs.get(sessionId) ?? [];
  if (list[0] === tab.id) return;
  recentTabs.set(sessionId, [tab.id, ...list.filter((id) => id !== tab.id)].slice(0, MAX_RECENT));
}

export function recentFocusedTabs(sessionId: string): readonly TabId[] {
  return recentTabs.get(sessionId) ?? [];
}

/** Tests only. */
export function resetRecentTabsForTests(): void {
  recentTabs.clear();
}
