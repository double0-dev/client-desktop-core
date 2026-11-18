import { StatusDot } from '@renderer/components/status-dot';
import type { TerminalTabState } from '@renderer/lib/terminal/busy';
import { cn } from '@renderer/lib/utils';

const TAB_DOT: Record<TerminalTabState, string> = {
  running: 'bg-success',
  'needs-input': 'bg-warning',
  finished: 'bg-info',
};

/**
 * A tab's status dot (design: WorkspaceTab `status-dot`, `Label/Tab status
 * dots`): the dot a session or project row carries, for one terminal - from
 * the same per-pty state that washes the tab (terminal/busy.ts). It sits after
 * the label, where the project row puts its dot, and before the close button,
 * so an editor's unsaved dot keeps the close slot to itself.
 *
 * Running and needs-input breathe; finished holds still until the tab is
 * viewed. An idle or unknown terminal - and every editor tab, which has no
 * pty - shows nothing: like a project row, a tab only speaks when something
 * happened.
 */
export function TabStatusDot({ state }: { state: TerminalTabState | null | undefined }) {
  if (!state) return null;
  return (
    <StatusDot
      live={state !== 'finished'}
      data-tab-status={state}
      className={cn('size-1.5 shrink-0', TAB_DOT[state])}
    />
  );
}
