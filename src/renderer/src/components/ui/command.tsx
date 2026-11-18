import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@renderer/lib/utils';

/**
 * Thin, app-styled wrapper around cmdk (the command-palette primitive shadcn's
 * `<Command>` is built on). Headless keyboard nav + ARIA combobox semantics come
 * from cmdk; the Search Everywhere palette composes these inside a Radix Dialog
 * and drives ranking itself (`shouldFilter={false}`). Sizes follow the app font
 * scale (`--ui-font-scale`), like the settings dialog.
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn('flex h-full w-full flex-col overflow-hidden text-foreground', className)}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4">
      <Search className="size-[18px] shrink-0 text-foreground-muted" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-12 w-full bg-transparent text-[length:calc(14px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-muted disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[min(420px,60vh)] overflow-y-auto overflow-x-hidden p-1.5', className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-10 text-center text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground-muted"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[length:calc(11px*var(--ui-font-scale,1))] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-foreground-subtle',
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[length:calc(13px*var(--ui-font-scale,1))] outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
