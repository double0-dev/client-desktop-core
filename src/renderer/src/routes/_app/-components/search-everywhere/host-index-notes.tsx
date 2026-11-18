import { Loader2 } from 'lucide-react';
import type { FileIndex } from '@renderer/lib/search/types';

/**
 * Where each remote host's files stand (plan 29 spec › 5.3): a walk running
 * there, or a host that is away (its last list is in the results).
 */
export function HostIndexNotes({
  index,
  label,
}: {
  index: FileIndex;
  label: (id: string) => string;
}) {
  if (index.pending.length === 0 && index.unreachable.length === 0) return null;
  return (
    <div
      data-testid="search-host-index"
      className="flex flex-col gap-1 px-3 py-2 text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-subtle"
    >
      {index.pending.map((id) => (
        <div key={`p:${id}`} className="flex items-center gap-2">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Indexing {label(id)}…
        </div>
      ))}
      {index.unreachable.map((id) => (
        <div key={`u:${id}`}>{label(id)} is unreachable - showing the last list</div>
      ))}
    </div>
  );
}
