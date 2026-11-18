import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { isFontInstalled, offeredFontFamilies } from '@renderer/lib/settings/font-availability';
import { isMac } from '@renderer/lib/settings/keyboard-shortcuts';
import { DEFAULT_FONT_FAMILY, UI_FONT_SIZE } from '@renderer/lib/settings/ui-font-settings';
import { cn } from '@renderer/lib/utils';
import { HEX_RE } from '@renderer/routes/_app/-components/settings/settings-form';

/**
 * One settings row with an action instead of a value: title + description on
 * the left, an outline button on the right (design: the General tab's
 * Import / Export / Reset rows). `destructive` colours the label; the real
 * guard is the confirm the handler opens.
 */
export function SettingActionRow({
  title,
  description,
  buttonLabel,
  destructive = false,
  disabled,
  onClick,
}: {
  title: string;
  description: ReactNode;
  buttonLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
          {title}
        </p>
        <p className="text-xs leading-relaxed text-foreground-subtle">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'text-[length:calc(13px*var(--ui-font-scale,1))]',
          destructive && 'text-destructive hover:text-destructive',
        )}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

/** One settings row: title + description on the left, a toggle switch on the
 * right. The description may carry inline elements (a link) - never a block. */
export function SettingToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Dimmed and inert - a follow-up row whose parent switch is off. */
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-4', disabled && 'opacity-60')}>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
          {title}
        </p>
        <p className="text-xs leading-relaxed text-foreground-subtle">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

/** Pill switch (design `Toggle/On`, node `S96uk`): primary track on, knob slides right. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
        checked ? 'bg-primary' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'size-4 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** Bare font select; `defaultLabel` prepends the no-override `'default'` choice. */
export function FontSelect({
  id,
  value,
  options,
  defaultLabel,
  onChange,
  className,
}: {
  id?: string;
  value: string;
  options: { id: string; label: string; probe?: string; notOnMac?: boolean }[];
  defaultLabel?: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const offered = useMemo(
    () => offeredFontFamilies(options, value, isFontInstalled, isMac),
    [options, value],
  );
  return (
    <div className={cn('relative', className)}>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full appearance-none rounded-md border border-border bg-input pl-2.5 pr-8 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        {defaultLabel && <option value={DEFAULT_FONT_FAMILY}>{defaultLabel}</option>}
        {offered.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-muted" />
    </div>
  );
}

/** Size select for the cascading UI font sizes; `null` = the `defaultLabel` choice. */
export function FontSizeSelect({
  id,
  value,
  defaultLabel,
  onChange,
  className,
}: {
  id?: string;
  value: number | null;
  defaultLabel: string;
  onChange: (size: number | null) => void;
  className?: string;
}) {
  const options = Array.from({ length: UI_FONT_SIZE.max - UI_FONT_SIZE.min + 1 }, (_, i) => {
    const size = UI_FONT_SIZE.min + i;
    return { id: String(size), label: `${size} px` };
  });
  return (
    <FontSelect
      id={id}
      value={value == null ? DEFAULT_FONT_FAMILY : String(value)}
      options={options}
      defaultLabel={defaultLabel}
      onChange={(next) => onChange(next === DEFAULT_FONT_FAMILY ? null : Number(next))}
      className={className}
    />
  );
}

/** Labeled `FontSizeSelect` for the Files/Changes sections. */
export function FontSizeField({
  value,
  defaultLabel,
  onChange,
}: {
  value: number | null;
  defaultLabel: string;
  onChange: (size: number | null) => void;
}) {
  const selectId = useId();
  return (
    <div className="flex w-[116px] shrink-0 flex-col gap-1">
      <label
        htmlFor={selectId}
        className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted"
      >
        Size
      </label>
      <FontSizeSelect id={selectId} value={value} defaultLabel={defaultLabel} onChange={onChange} />
    </div>
  );
}

/** Labeled font select shared by the Terminal/Editor/Files/Changes sections. */
export function FontFamilyField({
  value,
  options,
  defaultLabel,
  onChange,
}: {
  value: string;
  options: { id: string; label: string; probe?: string; notOnMac?: boolean }[];
  defaultLabel?: string;
  onChange: (id: string) => void;
}) {
  const selectId = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label
        htmlFor={selectId}
        className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted"
      >
        Family
      </label>
      <FontSelect
        id={selectId}
        value={value}
        options={options}
        defaultLabel={defaultLabel}
        onChange={onChange}
      />
    </div>
  );
}

/** A color well that opens the native picker; used bare (ANSI) and inside fields. */
export function ColorSwatch({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}) {
  return (
    <label
      title={label}
      className={cn(
        'relative cursor-pointer border border-border-strong transition-shadow focus-within:ring-2 focus-within:ring-ring/40',
        className,
      )}
      style={{ backgroundColor: value }}
    >
      <input
        type="color"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}

/** Labeled color field: swatch + editable hex text, committing only valid hex. */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  // Sync the draft when the committed value changes externally (picker, reset).
  useEffect(() => setText(value), [value]);

  function commit(raw: string) {
    const candidate = raw.startsWith('#') ? raw : `#${raw}`;
    if (HEX_RE.test(candidate)) onChange(candidate.toLowerCase());
    else setText(value);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
        {label}
      </span>
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-input px-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <ColorSwatch
          label={`Pick ${label.toLowerCase()} color`}
          value={value}
          onChange={onChange}
          className="size-3.5 shrink-0 rounded-[3px]"
        />
        <input
          value={text}
          aria-label={`${label} hex value`}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
          }}
          className="w-full min-w-0 bg-transparent font-mono text-[length:calc(11px*var(--ui-font-scale,1))] uppercase text-foreground outline-none"
        />
      </div>
    </div>
  );
}

/**
 * Preset dots, a rainbow custom swatch opening the native picker and the hex
 * value as an editable field (design: sec-accent). The selected swatch wears a
 * ring in its own color; a non-preset value selects the custom swatch. With
 * `noneLabel` a leading dashed dot stands for "no color" (`null`), and an
 * emptied hex field commits it - used by project colors, which follow the
 * accent until one is picked.
 */
export function PresetColorPicker({
  presets,
  value,
  onChange,
  noun,
  noneLabel,
  customFallback,
}: {
  presets: { id: string; label: string; value: string }[];
  value: string | null;
  onChange: (hex: string | null) => void;
  /** Names the color in accessible labels: "Use the Blue {noun} color". */
  noun: string;
  noneLabel?: string;
  /** What the native picker opens on while the value is null (it needs a hex). */
  customFallback?: string;
}) {
  const [text, setText] = useState(value ?? '');
  // Sync the draft when the committed value changes externally (swatch, picker).
  useEffect(() => setText(value ?? ''), [value]);

  const isCustom = value !== null && !presets.some((preset) => preset.value === value);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed && noneLabel) {
      onChange(null);
      return;
    }
    const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (HEX_RE.test(candidate)) onChange(candidate.toLowerCase());
    else setText(value ?? '');
  }

  const dot =
    'flex size-6 items-center justify-center rounded-full border-[1.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40';

  return (
    <div className="flex shrink-0 items-center gap-2">
      {noneLabel && (
        <button
          type="button"
          title={noneLabel}
          aria-label={noneLabel}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={cn(
            dot,
            value === null
              ? 'border-foreground-muted'
              : 'border-transparent hover:border-border-strong',
          )}
        >
          <span className="size-4 rounded-full border border-dashed border-foreground-subtle" />
        </button>
      )}
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.label}
          aria-label={`Use the ${preset.label} ${noun} color`}
          aria-pressed={value === preset.value}
          onClick={() => onChange(preset.value)}
          className={cn(
            dot,
            value !== preset.value && 'border-transparent hover:border-border-strong',
          )}
          style={value === preset.value ? { borderColor: preset.value } : undefined}
        >
          <span className="size-4 rounded-full" style={{ backgroundColor: preset.value }} />
        </button>
      ))}
      <div className="h-4 w-px shrink-0 bg-border" />
      <label
        title="Custom color"
        className={cn(
          'relative flex size-6 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors focus-within:ring-2 focus-within:ring-ring/40',
          !isCustom && 'border-transparent hover:border-border-strong',
        )}
        style={isCustom && value ? { borderColor: value } : undefined}
      >
        <span
          className="size-4 rounded-full"
          style={{
            background:
              'conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)',
          }}
        />
        <input
          type="color"
          value={value ?? customFallback ?? presets[0]?.value ?? '#000000'}
          aria-label={`Pick a custom ${noun} color`}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        value={text}
        aria-label={`${noun[0].toUpperCase()}${noun.slice(1)} color hex value`}
        placeholder={noneLabel ? 'None' : undefined}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Inside a dialog form Enter would submit before the blur commits.
            e.preventDefault();
            commit(e.currentTarget.value);
          }
        }}
        className="h-7 w-[80px] rounded-md border border-border bg-input px-2 font-mono text-[length:calc(11px*var(--ui-font-scale,1))] uppercase text-foreground-muted outline-none transition-colors placeholder:normal-case placeholder:text-foreground-subtle focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}

export function Stepper({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  fill,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Grow to share the row evenly instead of the fixed 116px width. */
  fill?: boolean;
}) {
  // Round to the step's precision so 1.1 + 0.1 doesn't become 1.2000000000000002.
  const apply = (next: number) =>
    onChange(Math.min(max, Math.max(min, Math.round(next * 10) / 10)));

  return (
    <div className={cn('flex flex-col gap-1', fill ? 'min-w-0 flex-1' : 'w-[116px] shrink-0')}>
      <span className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
        {label}
      </span>
      <div className="flex h-8 items-center rounded-md border border-border bg-input px-1">
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => apply(value - step)}
          className="flex size-6 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40"
        >
          <Minus className="size-3" />
        </button>
        <span className="flex-1 text-center font-mono text-xs text-foreground">{display}</span>
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => apply(value + step)}
          className="flex size-6 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
}
