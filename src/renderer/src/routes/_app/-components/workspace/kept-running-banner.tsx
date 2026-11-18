import { ChevronRight, History, X } from 'lucide-react';
import {
  dismissKeptRunningNotice,
  useKeptRunningNotice,
} from '@renderer/lib/session/kept-running-notice';
import { requestOpenSettings } from '@renderer/lib/settings/open-settings';

/**
 * The once-ever "N sessions kept running while double0 was closed" banner at
 * the top of the workspace pane - the update banner's shape (the generic
 * `Banner` in its accent/info variant with `close` enabled; designed as `Screen/Workspace - Sessions kept notice` in
 * `design/client_desktop.pen`). It exists so the Keep-running switch is
 * found: *Sessions settings* opens Settings › Sessions where it
 * lives, × hides it. Either way it never shows again on this machine - main
 * counted it shown when it answered (a private plan › Quit).
 */
export function KeptRunningBanner() {
  const notice = useKeptRunningNotice();
  if (!notice) return null;

  return (
    <div
      role="status"
      data-testid="kept-running-banner"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-accent px-3"
    >
      <History className="size-3.5 shrink-0 text-primary" />
      <span className="truncate text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold text-foreground">
        {notice.text}
      </span>
      <span className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
        ·
      </span>
      <span className="min-w-0 truncate text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
        Every tab picked its terminal up again
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => {
          requestOpenSettings('sessions');
          dismissKeptRunningNotice();
        }}
        className="flex h-[18px] items-center gap-1 rounded-full bg-primary px-2 text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Sessions settings
        <ChevronRight className="size-[11px]" />
      </button>
      <button
        type="button"
        aria-label="Dismiss kept-running notice"
        onClick={dismissKeptRunningNotice}
        className="flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
