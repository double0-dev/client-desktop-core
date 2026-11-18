import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The app window's last size, position and maximized / full-screen flags,
 * persisted at `<userData>/window-state.json` so a relaunch reopens the window
 * where it was.
 *
 * Main saves on every move/resize (debounced) rather than only on close: a
 * killed or crashed process never runs its close handlers, and the window
 * should still come back at the size it had. Writes go through a temp file +
 * rename so a kill mid-write can't leave half a JSON behind (a corrupt file
 * falls back to the defaults anyway).
 *
 * Only the full app window is tracked; torn-off session / tab windows are sized
 * from the drag that created them.
 *
 * Pure node (displays are passed in) so it is unit-tested without Electron;
 * every write is best-effort.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type WindowState = {
  /** The normal (un-maximized, windowed) bounds. */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
};

export const WINDOW_STATE_FILE = 'window-state.json';

/**
 * How much of the window must overlap a display's work area for the saved
 * position to be trusted - enough of the title bar to grab and drag it back.
 */
const MIN_VISIBLE = 100;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Decode the file's content; `null` for missing, corrupt or nonsensical data. */
export function parseWindowState(raw: string | null | undefined): WindowState | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const b = record.bounds as Record<string, unknown> | null | undefined;
  if (!b || typeof b !== 'object') return null;
  if (![b.x, b.y, b.width, b.height].every(isFiniteNumber)) return null;
  if ((b.width as number) <= 0 || (b.height as number) <= 0) return null;
  return {
    bounds: {
      x: Math.round(b.x as number),
      y: Math.round(b.y as number),
      width: Math.round(b.width as number),
      height: Math.round(b.height as number),
    },
    maximized: record.maximized === true,
    fullScreen: record.fullScreen === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * Fit saved bounds onto the displays that exist now. The size is clamped to
 * the window's minimum and to the work area it lands on; a position that is no
 * longer reachable (its monitor was unplugged, the resolution shrank) is
 * dropped - `x`/`y` come back undefined and the OS centres the window on the
 * primary display (`workAreas[0]`).
 */
export function fitWindowBounds(
  bounds: Rect,
  workAreas: Rect[],
  min: { width: number; height: number },
): { x?: number; y?: number; width: number; height: number } {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(bounds, area);
    if (
      o.width >= Math.min(MIN_VISIBLE, bounds.width) &&
      o.height >= Math.min(MIN_VISIBLE, bounds.height)
    ) {
      const a = o.width * o.height;
      if (a > bestArea) {
        best = area;
        bestArea = a;
      }
    }
  }
  const target = best ?? workAreas[0];
  const clampSize = (v: number, lo: number, hi: number | undefined): number =>
    Math.max(lo, hi != null ? Math.min(v, hi) : v);
  const width = clampSize(bounds.width, min.width, target?.width);
  const height = clampSize(bounds.height, min.height, target?.height);
  if (!best) return { width, height };
  // Keep the window inside the work area it mostly sits on (a resize clamp
  // above can otherwise leave it hanging off an edge).
  const x = Math.min(Math.max(bounds.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(bounds.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/** The persisted state, or `null` when there is none worth using. */
export function readWindowState(path: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Best-effort atomic write; a failure is swallowed (see the module comment). */
export function writeWindowState(path: string, state: WindowState): boolean {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
