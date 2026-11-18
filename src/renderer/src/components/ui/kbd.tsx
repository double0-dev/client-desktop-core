/** A single key chip (design `Kbd`, node `h9ohfZ`). */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="flex h-5 min-w-[20px] items-center justify-center rounded-sm border border-border bg-muted px-1.5 font-mono text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-foreground-muted">
      {children}
    </kbd>
  );
}
