import type { ComponentType, ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-[18px] rounded-lg border border-border-strong bg-surface px-8 py-11 text-center',
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-lg border border-border bg-muted text-foreground-muted">
        <Icon className="size-6" />
      </span>
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="text-base font-semibold tracking-[-0.2px] text-foreground">{title}</p>
        <p className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
