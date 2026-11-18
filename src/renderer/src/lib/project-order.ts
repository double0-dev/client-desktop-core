import { ms } from '@renderer/lib/format';

// Pure ordering logic for the project lists (the workspace Projects panel,
// startup's pick), kept free of collection imports so it's unit-testable.

type ProjectOrderable = {
  id: string;
  sortOrder: number;
  createdAt: Date;
};

/**
 * The display order every project list shares: manual order (ascending
 * sortOrder - never name or activity, so only an explicit drag moves a
 * project), newest-first as a tiebreak for legacy rows sharing the 0 default.
 * Pinning is gone (a private plan): the `pinned` column is
 * never read, and the migration that dropped it baked the old pinned-first
 * order into sortOrder.
 */
export function sortProjects<T extends ProjectOrderable>(projects: T[]): T[] {
  return [...projects].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return ms(b.createdAt) - ms(a.createdAt);
  });
}

/**
 * The sortOrder that drops `draggedId` at `targetIndex` of the displayed list
 * (0 = first, length = last; the index counts the dragged item itself), or null
 * when the drop changes nothing. The dragged project slots in at the midpoint
 * between its new neighbours - a local write, no renumbering of the rest.
 */
export function projectDropSortOrder(
  sorted: ProjectOrderable[],
  draggedId: string,
  targetIndex: number,
): number | null {
  const from = sorted.findIndex((p) => p.id === draggedId);
  if (from === -1) return null;
  // Dropped back into its own slot (just above or below itself) - nothing to do.
  if (targetIndex === from || targetIndex === from + 1) return null;
  const rest = sorted.filter((p) => p.id !== draggedId);
  // targetIndex counts the dragged item; discount it once the drop is below it.
  const gap = targetIndex > from ? targetIndex - 1 : targetIndex;
  const above = gap > 0 ? rest[gap - 1] : undefined;
  const below = rest[gap];
  if (!above && !below) return null;
  if (!above) return below!.sortOrder - 1;
  if (!below) return above.sortOrder + 1;
  return (above.sortOrder + below.sortOrder) / 2;
}
