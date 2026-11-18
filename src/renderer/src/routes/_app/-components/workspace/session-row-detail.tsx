import { memo } from 'react';
import { Folder } from 'lucide-react';

import type { AgentSession } from '@renderer/lib/collections';
import { relativeShort } from '@renderer/lib/format';
import { useSessionActivity } from '@renderer/lib/session/activity';
import { resolveSessionLine } from '@renderer/lib/session/activity-text';
import { useSessionQuestion } from '@renderer/lib/session/questions';
import { useNow } from '@renderer/lib/use-now';
import { hostsEnabled } from '@renderer/lib/hosts/hosts-enabled';
import { cn } from '@renderer/lib/utils';
import { HostBadgeSlot } from '@renderer/components/host-badge-slot';
import { HoverScrollText } from '@renderer/components/hover-scroll-text';

/**
 * A sidebar session row's lower lines: where it runs (the host of a remote
 * session, the subfolder chip), then diff stats and what
 * the agent is up to - the tool it's on, the question or permission it's
 * blocked on, else the summary its last turn left in `detail` - plus the age.
 * Its own component so the live activity / question stores and the clock
 * re-render this line alone: read in the view, every tool call of any agent
 * re-rendered every mounted session's whole chrome.
 */
export const SessionRowDetail = memo(function SessionRowDetail({
  sessionId,
  status,
  detail,
  updatedAtMs,
  added,
  removed,
  rootLabel,
  rootPath,
  hostId,
}: {
  sessionId: string;
  status: AgentSession['status'];
  detail: string;
  updatedAtMs: number;
  /** Uncommitted lines vs HEAD - null when unknown, all-zero or archived. */
  added: number | null;
  removed: number | null;
  rootLabel: string | null;
  rootPath: string | null;
  /** The project's host - null for a session on this machine. */
  hostId?: string | null;
}) {
  const now = useNow();
  // What the agent is doing or asking (this window's observed sessions only).
  const activity = useSessionActivity(sessionId);
  const question = useSessionQuestion(sessionId);
  const line = resolveSessionLine({ status, activity, question, detail });
  const showsHost = hostsEnabled() && !!hostId;
  return (
    <>
      {/* Where it runs - the server and the subfolder - on a line of their
          own, so the activity line below keeps the row's full width. Never
          hidden while the agent works: the row would change height. */}
      {(showsHost || rootLabel) && (
        <div className="flex min-w-0 items-center gap-1.5">
          <HostBadgeSlot hostId={hostId} className="min-w-0 shrink" />
          {rootLabel && (
            <span
              title={rootPath ?? undefined}
              className="flex min-w-0 shrink items-center gap-1 rounded-sm bg-muted px-1.5 py-px font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-medium text-foreground-muted"
            >
              <Folder className="size-2.5 shrink-0 text-[#fbbf24]" />
              <span className="truncate">{rootLabel}</span>
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        {added != null && removed != null && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold">
            <span className="text-success">+{added}</span>
            <span className="text-destructive">-{removed}</span>
          </span>
        )}
        {added != null && line != null && (
          <span className="shrink-0 text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
            ·
          </span>
        )}
        {line && (
          <HoverScrollText
            // The row truncates - hovering it slides the rest into view, and
            // the full line lives in the tooltip.
            title={line.text}
            className={cn(
              'min-w-0 flex-1 text-[length:calc(11px*var(--ui-font-scale,1))] leading-snug',
              line.tone === 'warning' ? 'text-warning' : 'text-foreground-muted',
            )}
          >
            {line.text}
          </HoverScrollText>
        )}
        <span className="ml-auto shrink-0 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-medium text-foreground-muted">
          {relativeShort(new Date(updatedAtMs), now)}
        </span>
      </div>
    </>
  );
});
