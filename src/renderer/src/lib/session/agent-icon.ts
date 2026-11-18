import { Bot, CodeXml, Sparkles, type LucideIcon } from 'lucide-react';
import { agentIconKind, type AgentIconKind } from '@renderer/lib/session/templates';

/**
 * Indexed directly where a component renders the glyph
 * (`AGENT_ICONS[kind]`): a component returned by a function call reads as
 * one created during render to react-hooks' static-components rule.
 */
export const AGENT_ICONS: Record<AgentIconKind, LucideIcon> = {
  claude: Sparkles,
  codex: Bot,
  opencode: CodeXml,
};

/**
 * The glyph a tab or session row shows for the agent its label names (the
 * tab strip, the vertical tabs, the busy-tabs and project-delete lists) -
 * undefined for a plain shell, which keeps the terminal icon.
 */
export function agentIconFor(label: string): LucideIcon | undefined {
  const kind = agentIconKind(label);
  return kind ? AGENT_ICONS[kind] : undefined;
}
