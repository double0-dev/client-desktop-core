import * as React from 'react';

import { cn } from '@renderer/lib/utils';

type InputProps = React.ComponentProps<'input'> & {
  /** Optional leading adornment (e.g. an icon) rendered inside the field. */
  startIcon?: React.ReactNode;
  /** Optional trailing adornment (e.g. a show/hide toggle) rendered inside the field. */
  endIcon?: React.ReactNode;
  /** Class applied to the field shell when start/end adornments are used. */
  shellClassName?: string;
};

const baseFieldClasses =
  'rounded-md border border-border bg-input text-sm text-foreground transition-colors placeholder:text-foreground-muted disabled:cursor-not-allowed disabled:opacity-50';

function Input({ className, type, startIcon, endIcon, shellClassName, ...props }: InputProps) {
  if (startIcon || endIcon) {
    return (
      <div
        data-slot="input-shell"
        className={cn(
          'flex h-10 w-full items-center gap-2 px-3',
          baseFieldClasses,
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          shellClassName,
        )}
      >
        {startIcon}
        <input
          type={type}
          data-slot="input"
          className={cn(
            'min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-foreground-muted',
            className,
          )}
          {...props}
        />
        {endIcon}
      </div>
    );
  }

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-10 w-full px-3 py-2 outline-none',
        baseFieldClasses,
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
export type { InputProps };
