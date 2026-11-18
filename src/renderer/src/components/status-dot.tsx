import type { ComponentProps } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * The small round status dot shown wherever a session's state is (design:
 * `status-dot` on `SessionItem`, node `SFbTa` in the sessions tool window) -
 * the sidebar rows, the top-bar pill, the
 * tabs (`TabStatusDot`).
 *
 * Color and size stay with the caller: every surface has its own scale (6px in
 * the sidebar, 8px in the project table) and its own palette. All this adds is
 * `live`, which swaps in the breathing halo from globals.css - pass it
 * `isLiveSessionStatus(status)` (session-counts.ts).
 */
export function StatusDot({
  live = false,
  className,
  ...props
}: { live?: boolean } & ComponentProps<'span'>) {
  return <span className={cn('rounded-full', live && 'status-dot-live', className)} {...props} />;
}
