import { Loader2, X } from 'lucide-react';
import { uploadLabel } from '@renderer/lib/workspace/explorer-upload';
import type { ExplorerUploadRun } from '@renderer/lib/workspace/use-explorer-upload';

/** The footer row while a drop copies: what and how far, and Cancel. */
export function UploadFooter({
  run,
  hostLabel,
  onCancel,
}: {
  run: ExplorerUploadRun;
  hostLabel: string | null;
  onCancel: () => void;
}) {
  const p = run.progress;
  const pct = p && p.totalBytes > 0 ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)) : 0;
  return (
    <div
      data-testid="explorer-upload"
      role="status"
      className="relative flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] text-foreground-muted"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-primary/10"
        style={{ width: `${pct}%` }}
      />
      <Loader2 className="relative size-3 shrink-0 animate-spin" />
      <span className="relative min-w-0 flex-1 truncate" title={run.destDir}>
        {uploadLabel(p, hostLabel)}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="relative flex shrink-0 items-center gap-1 rounded px-1 text-foreground-muted hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
        Cancel
      </button>
    </div>
  );
}
