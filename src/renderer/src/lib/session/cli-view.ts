import { isClaudeCodeAgent } from '@renderer/lib/session/templates';
import { canShowView, type Tab } from '@renderer/lib/workspace/layout';

/** The CLI a shell tab runs, as far as its label and command tell. */
function cliOf(tab: Tab): 'Claude' | 'Codex' | null {
  const command = tab.startupCommand ?? '';
  if (isClaudeCodeAgent(tab.title) || /\bclaude\b/.test(command)) return 'Claude';
  if (/\bcodex\b/i.test(tab.title) || /\bcodex\b/.test(command)) return 'Codex';
  return null;
}

/**
 * Whether a shell tab runs Claude Code or Codex, so it offers an extension's
 * view over that CLI: a tab labelled after either, one whose command starts
 * it, or one already shown in the view. Main decides which CLI the view
 * follows from what actually runs in the tab.
 */
export function followsAgentCli(tab: Tab): boolean {
  return canShowView(tab) && (!!tab.view || cliOf(tab) !== null);
}

/** The CLI's name for a button's tooltip ("Show this Codex as …"). */
export function agentCliName(tab: Tab): string {
  return cliOf(tab) ?? 'agent';
}
