import { useRef, useState, type ReactNode } from 'react';
import { presentImperative } from '@renderer/lib/imperative-root';
import { SquareTerminal, Trash2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@renderer/components/ui/dialog';
import { StatusDot } from '@renderer/components/status-dot';
import { AGENT_ICONS } from '@renderer/lib/session/agent-icon';
import { agentIconKind, type AgentIconKind } from '@renderer/lib/session/templates';

const AGENT_NAMES: Record<AgentIconKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};
import type { BusyTab } from '@renderer/lib/terminal/busy';
import { cn } from '@renderer/lib/utils';

/**
 * Warnings for closing work that's still in flight (designs: `Screen/Close Tab
 * Dialog` and the busy-tabs section of `Screen/Delete Session Dialog`): a tab
 * whose terminal hosts a running agent/task or one waiting for input, and a
 * session whose tabs do. Imperative one-off roots like `confirmDialog`; each
 * resolves `true` when the user chose to close anyway.
 *
 * `BusyTabsCard` is shared with the worktree delete dialog, which shows the
 * same tab list above its worktree details when the session is busy.
 */

/** Status pill matching the app's session-status pills (dot + label). Shared
 * with the project delete dialog, which pills its busy session rows. */
export function BusyStatusPill({ status }: { status: BusyTab['status'] }) {
  const needsInput = status === 'needs-input';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
        needsInput
          ? 'border-warning/25 bg-warning/15 text-warning'
          : 'border-success/25 bg-success/15 text-success',
      )}
    >
      {/* Every tab listed here is busy by definition, so its dot always breathes. */}
      <StatusDot live className={cn('size-1.5', needsInput ? 'bg-warning' : 'bg-success')} />
      {needsInput ? 'Needs input' : 'Running'}
    </span>
  );
}

/** One busy tab, iconed like the tab strip (Claude glyph for agent tabs). */
function BusyTabRow({ tab }: { tab: BusyTab }) {
  const kind = agentIconKind(tab.title);
  const AgentIcon = kind ? AGENT_ICONS[kind] : undefined;
  return (
    <div className="flex items-center gap-2">
      {AgentIcon ? (
        <AgentIcon className="size-3.5 shrink-0 text-primary" />
      ) : (
        <SquareTerminal className="size-3.5 shrink-0 text-foreground-muted" />
      )}
      <span className="flex-1 truncate text-[13px] font-medium text-foreground">{tab.title}</span>
      <BusyStatusPill status={tab.status} />
    </div>
  );
}

/** The busy tabs of a session, listed with their status. */
export function BusyTabsCard({ tabs }: { tabs: BusyTab[] }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-muted p-3">
      <span className="text-[11px] font-semibold text-foreground-muted">
        {tabs.length === 1 ? '1 tab is' : `${tabs.length} tabs are`} still busy - closing will end
        them
      </span>
      <div className="h-px bg-border" />
      {tabs.map((tab, i) => (
        <BusyTabRow key={i} tab={tab} />
      ))}
    </div>
  );
}

/** Closing ONE busy tab: warn with the tab, its status, and (when the agent is
 * blocked on a question) what it's asking. Resolves true to close anyway. */
// eslint-disable-next-line react-refresh/only-export-components -- one-off roots, never hot-reloaded
export function confirmCloseBusyTab(opts: { tab: BusyTab; detail?: string }): Promise<boolean> {
  const kind = agentIconKind(opts.tab.title);
  const agent = kind ? AGENT_NAMES[kind] : null;
  const subject = agent ?? 'This tab';
  const doing =
    opts.tab.status === 'needs-input'
      ? `${subject} is waiting for your input${agent ? ' in this tab' : ''}.`
      : agent
        ? `${agent} is still working in this tab.`
        : 'This tab is still busy.';
  return presentBusyConfirm({
    title: 'Close this tab?',
    description: `${doing} Closing it will end the running task.`,
    confirmLabel: 'Close tab',
    confirmIcon: <X className="size-3.5" />,
    body: (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3">
        <BusyTabRow tab={opts.tab} />
        {opts.detail && (
          <span className="truncate text-[11px] text-foreground-muted" title={opts.detail}>
            {opts.detail}
          </span>
        )}
      </div>
    ),
  });
}

/** Bulk close ("close others"/"close all") that would end busy tabs. */
// eslint-disable-next-line react-refresh/only-export-components -- see confirmCloseBusyTab
export function confirmCloseBusyTabs(opts: { tabs: BusyTab[] }): Promise<boolean> {
  return presentBusyConfirm({
    title: 'Close tabs?',
    description: 'Some of the tabs you are closing are still busy.',
    confirmLabel: 'Close tabs',
    confirmIcon: <X className="size-3.5" />,
    body: <BusyTabsCard tabs={opts.tabs} />,
  });
}

/** Deleting a session (no worktree involved) whose tabs are still busy. The
 * worktree variant folds the same card into its own dialog instead. */
// eslint-disable-next-line react-refresh/only-export-components -- see confirmCloseBusyTab
export function confirmDeleteBusySession(opts: { tabs: BusyTab[] }): Promise<boolean> {
  return presentBusyConfirm({
    title: 'Delete session?',
    description: 'This session still has busy tabs. Deleting it will end them.',
    confirmLabel: 'Delete session',
    confirmIcon: <Trash2 className="size-3.5" />,
    body: <BusyTabsCard tabs={opts.tabs} />,
  });
}

type BusyConfirmOptions = {
  title: string;
  description: string;
  confirmLabel: string;
  confirmIcon: ReactNode;
  body: ReactNode;
};

function presentBusyConfirm(opts: BusyConfirmOptions): Promise<boolean> {
  return presentImperative<boolean>((onDone) => <BusyConfirmHost opts={opts} onDone={onDone} />);
}

function BusyConfirmHost({
  opts,
  onDone,
}: {
  opts: BusyConfirmOptions;
  onDone: (ok: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const done = useRef(false);
  const finish = (ok: boolean): void => {
    if (done.current) return;
    done.current = true;
    setOpen(false);
    onDone(ok);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(false)}>
      <DialogContent showCloseButton={false} className="gap-4">
        <div className="flex items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-warning/15">
            <TriangleAlert className="size-5 text-warning" />
          </div>
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-base">{opts.title}</DialogTitle>
            <p className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
              {opts.description}
            </p>
          </div>
        </div>
        {opts.body}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" autoFocus onClick={() => finish(true)}>
            {opts.confirmIcon}
            {opts.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
