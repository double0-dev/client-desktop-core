/**
 * The session-count pill at the end of a Projects panel row (design: `count`
 * on the `tw/projects` list rows). Counts the project's live sessions -
 * archived ones don't count, see `projectSessionMeta`. Same rule as the rail's
 * `RailCountBadge`: zero renders nothing. A permanent "-" on every quiet
 * project is noise, not information - a row without a pill *is* the answer.
 */
export function ProjectCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-label={`${count} session${count === 1 ? '' : 's'}`}
      className="shrink-0 rounded-full bg-muted px-[7px] py-px font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold text-foreground-muted"
    >
      {count}
    </span>
  );
}
