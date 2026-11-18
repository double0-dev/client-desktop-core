// Shared formatting helpers used across the workspace's lists and dialogs.

// Electric-synced rows arrive with timestamps as ISO strings (the zod schema
// types them as Date but values aren't coerced), so always normalise here.
export function ms(date: Date | string): number {
  return new Date(date).getTime();
}

// `now` defaults to the current time, but pass a value from `useNow()` so the
// rendered string stays live (re-computes on each shared tick) instead of
// freezing at first render.
export function relativeShort(date: Date | string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms(date)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// One formatter instance - Intl.DateTimeFormat construction is expensive.
const exactFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Exact local timestamp - "12 Jun 2026, 14:32" (locale-shaped) - for places
 * that need the real moment, not an age (commit metadata). */
export function exactDateTime(date: Date | string | number): string {
  return exactFmt.format(typeof date === 'number' ? date : ms(date));
}

export function initialsOf(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Project avatar/chip colour. A project with no colour of its own follows the
// app accent: `--primary` / `--primary-foreground` are already per mode, so the
// chip tracks a theme or accent change with no re-render. A set colour carries
// the design's dark olive ink when it is light enough that white would wash out
// (the moss green, amber, teal), white otherwise.
const AVATAR_INK = '#1f2d0c';

export function projectIconStyle(color: string | null): {
  backgroundColor: string;
  color: string;
} {
  if (!color) return { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' };
  return { backgroundColor: color, color: relativeLuminance(color) > 0.4 ? AVATAR_INK : '#ffffff' };
}

/** WCAG relative luminance of a `#rrggbb` colour (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
