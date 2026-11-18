import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@renderer/lib/utils';

type CheckboxProps = Omit<React.ComponentProps<'button'>, 'onChange' | 'defaultChecked'> & {
  /** Controlled checked state. Omit to use uncontrolled mode. */
  checked?: boolean;
  /** Initial checked state when uncontrolled. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * Lightweight, dependency-free checkbox matching the design system's
 * Checkbox/Checked + Checkbox/Unchecked components. Supports both controlled
 * (pass `checked` + `onCheckedChange`) and uncontrolled (`defaultChecked`) use.
 */
function Checkbox({
  checked: controlledChecked,
  defaultChecked = false,
  onCheckedChange,
  className,
  ...props
}: CheckboxProps) {
  const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
  const isControlled = controlledChecked !== undefined;
  const checked = isControlled ? controlledChecked : internalChecked;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-slot="checkbox"
      onClick={() => {
        const next = !checked;
        if (!isControlled) setInternalChecked(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        checked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border-strong bg-input',
        className,
      )}
      {...props}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

export { Checkbox };
export type { CheckboxProps };
