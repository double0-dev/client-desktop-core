import type { ReactNode } from 'react';

import { cn } from '@renderer/lib/utils';
import { titleBarInsets, useWindowChrome } from '@renderer/lib/window-chrome';

/**
 * The header heights. Main places the traffic lights and sizes the Windows /
 * Linux controls overlay for these exact heights (`TITLE_BAR_HEIGHT` in
 * main/window-chrome.ts; its test reads this table) - change both together.
 */
const HEIGHT_CLASS = { full: 'h-14', compact: 'h-9' } as const;

/**
 * A window's header doubling as its title bar (lib/window-chrome.ts): it
 * drags the window, keeps the OS window controls' corner free, and its
 * buttons, links and fields stay clickable (`[data-titlebar]` in
 * globals.css). Every window's top edge is one of these, always on
 * `bg-surface`: the Windows / Linux overlay is painted in that colour by the
 * OS, so a header of any other shade shows a slab under the controls.
 */
export function TitleBar({
  size = 'full',
  className,
  children,
}: {
  /** `full` = the app chrome (main / project windows), `compact` = a torn-off window. */
  size?: keyof typeof HEIGHT_CLASS;
  className?: string;
  children?: ReactNode;
}) {
  const chrome = useWindowChrome();
  return (
    <header
      data-titlebar
      style={titleBarInsets(chrome)}
      className={cn(
        'shrink-0 border-b border-border bg-surface [-webkit-app-region:drag]',
        HEIGHT_CLASS[size],
        className,
      )}
    >
      {children}
    </header>
  );
}

/**
 * Marks a local instance (`pnpm dev`, a build against localhost) next to the
 * logo - the job the " - DEV" window title did while the OS drew a title bar.
 * Red like the local launcher icon.
 */
export function DevBadge({ className }: { className?: string }) {
  const { local } = useWindowChrome();
  if (!local) return null;
  return (
    <span
      title="Local build"
      className={cn(
        'shrink-0 rounded-[4px] border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold leading-none tracking-[0.5px] text-destructive',
        className,
      )}
    >
      DEV
    </span>
  );
}
