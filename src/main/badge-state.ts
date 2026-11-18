/**
 * The pure half of the dock/taskbar status dot (badge.ts wires it to Electron):
 * which dot a set of session counts earns, the words that go with it, and the
 * pixels of a dot - all free of Electron so they can be unit-tested.
 *
 * The badge is the app-level roll-up of the in-app session status dot, in the
 * dot's own two colours: green while any session is running, amber while any
 * is waiting on you, nothing when everything is parked. Amber wins over green -
 * the badge is a "come back to the app" cue, and blocked work is the more
 * urgent reason to.
 */

export type BadgeKind = 'needs-input' | 'running';

export interface BadgeCounts {
  /** Sessions whose status is `needs-input` - an agent blocked on the user. */
  needsInput: number;
  /** Sessions whose status is `active` - an agent working. */
  running: number;
}

export const NO_BADGE: BadgeCounts = { needsInput: 0, running: 0 };

/** Which dot (if any) the counts earn. */
export function badgeKind(counts: BadgeCounts): BadgeKind | null {
  if (counts.needsInput > 0) return 'needs-input';
  if (counts.running > 0) return 'running';
  return null;
}

/** Accessible label for the taskbar overlay: what the dot means, with its count. */
export function badgeDescription(counts: BadgeCounts): string {
  const kind = badgeKind(counts);
  if (!kind) return '';
  const n = kind === 'needs-input' ? counts.needsInput : counts.running;
  const sessions = `${n} session${n === 1 ? '' : 's'}`;
  return kind === 'needs-input' ? `${sessions} waiting for input` : `${sessions} running`;
}

export function sameCounts(a: BadgeCounts, b: BadgeCounts): boolean {
  return a.needsInput === b.needsInput && a.running === b.running;
}

/**
 * Counts from a `GROUP BY status` of the live statuses. The driver hands
 * `count()` back as a string (Postgres bigint), hence the `Number()`; statuses
 * the badge doesn't track are ignored.
 */
export function countsFromStatusRows(
  rows: ReadonlyArray<{ status: string; n: number | string }>,
): BadgeCounts {
  const counts = { ...NO_BADGE };
  for (const row of rows) {
    if (row.status === 'needs-input') counts.needsInput += Number(row.n);
    else if (row.status === 'active') counts.running += Number(row.n);
  }
  return counts;
}

export type Rgb = readonly [red: number, green: number, blue: number];

/**
 * The dark-theme `--warning` / `--success` tokens - the colours the in-app
 * status dot wears. The icon is dark, so the dark palette sits right on it and
 * stays legible over a light dock too.
 */
export const BADGE_COLORS: Record<BadgeKind, Rgb> = {
  'needs-input': [0xfb, 0xbf, 0x24],
  running: [0x34, 0xd3, 0x99],
};

export interface Disc {
  cx: number;
  cy: number;
  radius: number;
  color: Rgb;
}

/**
 * Alpha-over a solid disc with a soft one-pixel edge onto a premultiplied BGRA
 * bitmap, in place - the layout `nativeImage.toBitmap()` returns and
 * `createFromBitmap` expects. Pixels outside the disc are left untouched, and
 * the disc is clipped to the bitmap.
 */
export function paintDisc(buf: Buffer, width: number, height: number, disc: Disc): void {
  const { cx, cy, radius } = disc;
  const [red, green, blue] = disc.color;
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    if (y < 0 || y >= height) continue;
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      if (x < 0 || x >= width) continue;
      // Coverage 1 inside, ramping to 0 across the boundary.
      const coverage = Math.max(0, Math.min(1, radius - Math.hypot(x - cx, y - cy) + 0.5));
      if (coverage === 0) continue;
      const i = (y * width + x) * 4;
      const keep = 1 - coverage;
      buf[i] = Math.round(blue * coverage + buf[i] * keep);
      buf[i + 1] = Math.round(green * coverage + buf[i + 1] * keep);
      buf[i + 2] = Math.round(red * coverage + buf[i + 2] * keep);
      buf[i + 3] = Math.round(255 * coverage + buf[i + 3] * keep);
    }
  }
}

/**
 * A disc alone on a transparent square - the taskbar overlay icon. A hair of
 * padding keeps the soft edge inside the bitmap.
 */
export function discBitmap(size: number, color: Rgb): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  paintDisc(buf, size, size, { cx: center, cy: center, radius: size / 2 - 0.5, color });
  return buf;
}
