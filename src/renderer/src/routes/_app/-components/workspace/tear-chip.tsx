import { createPortal } from 'react-dom';
import { Monitor } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * The floating chip that follows the cursor during a tear-off drag (tab or
 * session), portalled to <body> so it's never clipped. It switches to a primary
 * accent + Monitor icon once the cursor crosses the window edge, signalling that
 * releasing will tear the payload into another window; `hint` spells out what
 * the release would do (e.g. "new window" vs "move to window").
 */
export function TearChip({
  pointer,
  outside,
  icon,
  label,
  hint,
}: {
  /** Client (viewport) coords of the cursor. */
  pointer: { x: number; y: number };
  /** Cursor is beyond the window edge - releasing tears off. */
  outside: boolean;
  /** Payload icon shown while still inside the window (terminal, session, …). */
  icon: React.ReactNode;
  label: string;
  /** Outside-the-window hint, rendered as "- {hint}"; only shown while outside. */
  hint: string;
}) {
  return createPortal(
    <div
      className={cn(
        'pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-md border bg-surface px-2.5 py-1 text-xs font-medium shadow-lg',
        outside ? 'border-primary text-primary' : 'border-border-strong text-foreground',
      )}
      style={{ left: pointer.x + 12, top: pointer.y + 8 }}
    >
      {outside ? <Monitor className="size-3.5 text-primary" /> : icon}
      {label}
      {outside && <span className="text-muted-foreground">- {hint}</span>}
    </div>,
    document.body,
  );
}
