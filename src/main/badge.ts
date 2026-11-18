import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { count, inArray } from 'drizzle-orm';
import { getDb } from './db/client';
import { agentSessions } from './db/schema';
import { APP_ICON_PATH } from './app-icon';
import {
  BADGE_COLORS,
  NO_BADGE,
  badgeDescription,
  badgeKind,
  countsFromStatusRows,
  discBitmap,
  paintDisc,
  sameCounts,
  type BadgeCounts,
  type BadgeKind,
} from './badge-state';

/**
 * Dock / taskbar status dot: the app-level roll-up of the in-app session status
 * dot, in its two colours - green while any session is running (`active`),
 * amber while any is waiting on you (`needs-input`; amber wins), cleared once
 * everything is parked. The rules and the pixels live in badge-state.ts; this
 * file only reads the DB and talks to Electron.
 *
 * The counts are derived here in main (the sole DB writer) rather than in a
 * renderer, so they stay a single global truth no matter how many windows are
 * open - `db/ipc.ts` calls `refreshSessionBadge()` after every agent_sessions
 * mutation, and startup seeds it once.
 *
 * Per platform:
 *  - macOS: the dot composited onto the dock icon (`app.dock.setIcon`) - the
 *    system badge (`setBadge`) is a fixed oversized red pill with white text,
 *    so we draw our own instead.
 *  - Windows: the dot as a taskbar-button overlay (`win.setOverlayIcon`),
 *    applied to every window and re-applied when a new window opens.
 *  - Linux: `app.setBadgeCount` with the WAITING count only - a launcher badge
 *    is a number, and a "3" for three working agents would read as three
 *    alerts. Honored by Unity-style launchers, a no-op elsewhere.
 */

let current: BadgeCounts = NO_BADGE;

const overlayIcons = new Map<BadgeKind, NativeImage>();

/** A filled disc in the state's colour, generated so we ship no extra asset.
 * Built at 2× for a crisp taskbar overlay on high-DPI displays. */
function getOverlayIcon(kind: BadgeKind): NativeImage {
  let icon = overlayIcons.get(kind);
  if (!icon) {
    const size = 32;
    const scaleFactor = 2;
    icon = nativeImage.createFromBitmap(discBitmap(size, BADGE_COLORS[kind]), {
      width: size,
      height: size,
      scaleFactor,
    });
    overlayIcons.set(kind, icon);
  }
  return icon;
}

type DockIcons = { plain: NativeImage } & Record<BadgeKind, NativeImage>;
let dockIcons: DockIcons | null | undefined;

/** macOS dock icons: the plain app icon plus one copy per state with the dot
 * drawn onto the top-right corner. Built once; `undefined` = not yet tried,
 * `null` = icon file unavailable (fall back to the system badge). */
function getDockIcons(): DockIcons | null {
  if (dockIcons !== undefined) return dockIcons;
  const plain = nativeImage.createFromPath(APP_ICON_PATH);
  if (plain.isEmpty()) {
    dockIcons = null;
    return dockIcons;
  }
  const { width, height } = plain.getSize();
  const dotted = (kind: BadgeKind): NativeImage => {
    const buf = Buffer.from(plain.toBitmap());
    // Overlapping the squircle's top-right corner like a system badge, but at
    // ~24% of the icon width - noticeably smaller than the system pill.
    paintDisc(buf, width, height, {
      cx: width * 0.82,
      cy: height * 0.18,
      radius: width * 0.12,
      color: BADGE_COLORS[kind],
    });
    return nativeImage.createFromBitmap(buf, { width, height });
  };
  dockIcons = { plain, 'needs-input': dotted('needs-input'), running: dotted('running') };
  return dockIcons;
}

function applyOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const kind = badgeKind(current);
  win.setOverlayIcon(kind ? getOverlayIcon(kind) : null, badgeDescription(current));
}

function applyBadge(): void {
  const kind = badgeKind(current);
  if (process.platform === 'darwin') {
    const icons = getDockIcons();
    if (icons) {
      app.dock?.setIcon(kind ? icons[kind] : icons.plain);
    } else {
      // Icon asset unreadable - the oversized system pill beats no cue at all,
      // but it is red, so only a session waiting on you earns it.
      app.dock?.setBadge(current.needsInput > 0 ? '●' : '');
    }
  } else if (process.platform === 'win32') {
    for (const win of BrowserWindow.getAllWindows()) applyOverlay(win);
  } else {
    // Unity-style launchers honor this; other desktops silently ignore it.
    try {
      app.setBadgeCount(current.needsInput);
    } catch {
      // Badge counts aren't supported on this desktop environment.
    }
  }
}

/** Give a freshly-created window the current overlay (Windows only - macOS/Linux
 * badges are app-global and already set). */
export function applyBadgeToWindow(win: BrowserWindow): void {
  if (process.platform === 'win32') applyOverlay(win);
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Recompute the badge from the DB (debounced - status flips can arrive in
 * bursts). Safe to call fire-and-forget from anywhere in main. */
export function refreshSessionBadge(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void recompute();
  }, 150);
}

async function recompute(): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ status: agentSessions.status, n: count() })
      .from(agentSessions)
      .where(inArray(agentSessions.status, ['needs-input', 'active']))
      .groupBy(agentSessions.status);
    const next = countsFromStatusRows(rows);
    if (sameCounts(next, current)) return;
    current = next;
    applyBadge();
  } catch {
    // A transient DB error just leaves the badge as-is until the next change.
  }
}
