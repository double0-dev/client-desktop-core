import type { DockStackPanelId } from '@renderer/lib/workspace/dock-state';
import type { FocusDirection } from '@renderer/lib/workspace/layout';

/**
 * Keyboard focus regions of the workspace (design: `Label/Keyboard focus`).
 *
 * The focus-direction shortcuts (⇧⌘Arrow) walk the workspace spatially: the
 * split panes and tabs of the surface first (see `paneInDirection` /
 * `tabInDirection` in layout.ts), and past their edges the sidebar regions -
 * the dock's stacked panels (projects / sessions / tabs, top→bottom), the
 * file explorer, and a drawer right of the surface, laid out left→right as
 * `dock | explorer | surface | drawer`, with the bottom panel under the
 * surface. Inside a region, plain ↑/↓ step through its items (a session, a
 * project, a file row, a command).
 *
 * This module is the pure half: which region lies in a direction, and the DOM
 * conventions the panels share so the global handler can move focus without
 * knowing any panel's internals -
 *
 * - a region root carries `data-focus-region="<region>"`;
 * - each focusable item inside carries `data-focus-item` + `data-focus-key`
 *   (the session / project id, file path, tab id);
 * - the region's "current" item - the one focus lands on when the region is
 *   entered - carries `data-focus-current="true"`; failing that, the first item.
 *   An item that is not focusable itself (a terminal's wrapper) hands focus to
 *   the first text field inside it (xterm's textarea);
 * - a region split side by side (a bottom panel: list | terminal) marks
 *   each side `data-focus-part`; ⇧⌘←/→ inside it move between the parts.
 *
 * It also owns the one-shot re-focus hand-off for panels whose selection swaps
 * the whole view (picking another session or project mounts a different
 * `WorkspaceView`, so the focused row is gone): the panel files a request
 * before navigating, and the newly-active view consumes it after mount. While
 * such a request is pending (and briefly after), the surface must not auto-
 * focus its terminal/editor, or it would yank focus back out of the sidebar
 * the user is arrowing through - `isSurfaceFocusHeld` is that guard.
 */

export type FocusRegion = DockStackPanelId | 'explorer' | 'surface' | 'drawer' | 'bottom';

export type RegionLayout = {
  /** The open dock panels, top→bottom (the chrome's `openPanels`). */
  dock: DockStackPanelId[];
  /** Whether the file-explorer sidebar is shown. */
  explorer: boolean;
  /** Whether a drawer (right of the surface) is open. */
  drawer: boolean;
  /** Whether the bottom panel (under the surface) is open. */
  bottom: boolean;
};

/** The dock panel focus enters first from the right: Sessions when open (the
 * panel you're most likely reaching for), else the topmost open one. */
function preferredDockPanel(dock: DockStackPanelId[]): FocusRegion | null {
  if (dock.includes('sessions')) return 'sessions';
  return dock[0] ?? null;
}

/**
 * The region focus moves to from `from` in `direction`, or null when nothing
 * lies that way (the caller then leaves focus where it is). Column order is
 * `dock | explorer | surface | drawer`; within the dock, ↑/↓ walk the open
 * panels; ↓ from the surface enters the bottom panel and ↑ leaves it. Called
 * for the surface only after its own panes/tabs have been exhausted; ←/→
 * inside the bottom panel are its parts' (`focusRegionPart`).
 */
export function regionInDirection(
  regions: RegionLayout,
  from: FocusRegion,
  direction: FocusDirection,
): FocusRegion | null {
  if (from === 'surface') {
    if (direction === 'left')
      return regions.explorer ? 'explorer' : preferredDockPanel(regions.dock);
    if (direction === 'right') return regions.drawer ? 'drawer' : null;
    if (direction === 'down') return regions.bottom ? 'bottom' : null;
    return null;
  }
  if (from === 'bottom') {
    return direction === 'up' ? 'surface' : null;
  }
  if (from === 'drawer') {
    return direction === 'left' ? 'surface' : null;
  }
  if (from === 'explorer') {
    if (direction === 'right') return 'surface';
    if (direction === 'left') return preferredDockPanel(regions.dock);
    return null;
  }
  // A dock panel.
  if (direction === 'right') return regions.explorer ? 'explorer' : 'surface';
  if (direction === 'left') return null;
  const i = regions.dock.indexOf(from);
  if (i < 0) return null;
  return regions.dock[direction === 'up' ? i - 1 : i + 1] ?? null;
}

// ---------------------------------------------------------------------------
// DOM conventions
// ---------------------------------------------------------------------------

export const FOCUS_REGION_ATTR = 'data-focus-region';

/** The region the focused element sits in; anything outside a marked region
 * (the terminals, an editor, nothing focused at all) counts as the surface. */
export function regionOf(el: Element | null): FocusRegion {
  const root = el?.closest(`[${FOCUS_REGION_ATTR}]`);
  return (root?.getAttribute(FOCUS_REGION_ATTR) as FocusRegion | null) ?? 'surface';
}

/** Focus a region's current (else first) item inside `root`; false when the
 * region isn't mounted there or has nothing to focus. */
export function focusRegion(root: ParentNode, region: FocusRegion): boolean {
  const container = root.querySelector(`[${FOCUS_REGION_ATTR}="${region}"]`);
  if (!container) return false;
  const target =
    container.querySelector<HTMLElement>('[data-focus-current="true"]') ??
    container.querySelector<HTMLElement>('[data-focus-item]');
  return target != null && focusItem(target);
}

/** Focus `el`, or - when it is a wrapper that takes no focus (a terminal's
 * slot) - the first text field inside it. */
function focusItem(el: HTMLElement): boolean {
  if (el.tabIndex >= 0 || el.matches('button, input, textarea, select, [tabindex]')) {
    el.focus();
    return true;
  }
  const field = el.querySelector<HTMLElement>('textarea, input');
  if (!field) return false;
  field.focus();
  return true;
}

/**
 * ⇧⌘←/→ inside a region split into side-by-side parts (`data-focus-part`):
 * focus the current (else first) item of the part `direction` of the one
 * holding `from`. False at either end, or when that part has nothing to focus
 * (a command with no terminal open).
 */
export function focusRegionPart(
  root: ParentNode,
  region: FocusRegion,
  from: Element | null,
  direction: 'left' | 'right',
): boolean {
  const container = root.querySelector(`[${FOCUS_REGION_ATTR}="${region}"]`);
  if (!container) return false;
  const parts = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-part]'));
  const i = parts.findIndex((p) => from != null && p.contains(from));
  if (i < 0) return false;
  const part = parts[direction === 'left' ? i - 1 : i + 1];
  if (!part) return false;
  const target =
    part.querySelector<HTMLElement>('[data-focus-current="true"]') ??
    part.querySelector<HTMLElement>('[data-focus-item]');
  return target != null && focusItem(target);
}

/**
 * The focusable item `delta` steps (±1) from `from` in `container`, in DOM
 * order - what plain ↑/↓ move to inside a region. Null at either end, so the
 * list never wraps (a wrap would make holding ↓ cycle through session views).
 */
export function stepFocusItem(
  container: Element,
  from: Element,
  delta: 1 | -1,
): HTMLElement | null {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-item]'));
  const current = from.closest<HTMLElement>('[data-focus-item]');
  const i = current ? items.indexOf(current) : -1;
  if (i < 0) return items[delta > 0 ? 0 : items.length - 1] ?? null;
  return items[i + delta] ?? null;
}

/**
 * The step a key press asks a list for: +1 for a plain ↓, -1 for a plain ↑,
 * null for anything else - including ↑/↓ with a modifier held. The Sessions
 * and Projects lists step on this, because ⇧⌘↑/↓ from one of their rows is
 * the section walk: the global handler (capture phase) has already moved focus
 * to the panel above/below when the same event bubbles into the list, and
 * stepping there too switched the session (or project) instead of leaving the
 * panel.
 */
export function plainArrowStep(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 1 | -1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === 'ArrowDown') return 1;
  if (e.key === 'ArrowUp') return -1;
  return null;
}

/** The item keyed `key` inside `container` (an id or path - matched by value,
 * never interpolated into a selector, so any string is safe). */
export function findFocusItem(container: ParentNode, key: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>('[data-focus-key]')) {
    if (el.getAttribute('data-focus-key') === key) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-focus hand-off across a view swap + the surface auto-focus hold
// ---------------------------------------------------------------------------

/** How long the surface stands down after a sidebar focus request / hand-off:
 * long enough to outlast the switched-in view's own focus effects (a rAF, then
 * a ResizeObserver tick on the hidden→visible edge), short enough that a click
 * into the terminal right after still behaves. */
const HOLD_MS = 800;
/** An unconsumed request expires - a navigation that never lands must not
 * re-focus a row on some later, unrelated view swap. */
const REQUEST_TTL_MS = 3_000;

type Pending = { region: FocusRegion; key: string; at: number };

let pending: Pending | null = null;
let holdUntil = 0;

function livePending(now: number): Pending | null {
  if (pending && now - pending.at > REQUEST_TTL_MS) pending = null;
  return pending;
}

/** Ask the next view to activate to put focus on `key` in `region` - filed by
 * a panel right before it navigates away from the current view. */
export function requestRegionFocus(region: FocusRegion, key: string): void {
  const now = Date.now();
  pending = { region, key, at: now };
  holdUntil = now + HOLD_MS;
}

/** Keep the surface from auto-focusing for a moment (a selection made from a
 * sidebar that doesn't swap views - the vertical Tabs panel picking a tab). */
export function holdSurfaceFocus(): void {
  holdUntil = Date.now() + HOLD_MS;
}

// ---------------------------------------------------------------------------
// Focus mode: was the last input the keyboard or the pointer?
// ---------------------------------------------------------------------------

/**
 * Set on <html> from the last input event: `keyboard` after a keydown,
 * `pointer` after a pointerdown. It drives the `kbd-focus` / `kbd-focus-within`
 * / `region-kbd-focus` Tailwind variants (globals.css) - the row ring and the
 * panel-header tint - and the surface hold below. Chrome's own `:focus-visible`
 * heuristic isn't dependable for the programmatic `.focus()` calls the region
 * navigation makes (a row focused after a view swap sometimes got no visible
 * state at all), so the app tracks the mode itself.
 */
export const FOCUS_MODE_ATTR = 'data-focus-mode';
export type FocusMode = 'keyboard' | 'pointer';

export function setFocusMode(mode: FocusMode): void {
  if (typeof document === 'undefined') return;
  if (document.documentElement.getAttribute(FOCUS_MODE_ATTR) !== mode) {
    document.documentElement.setAttribute(FOCUS_MODE_ATTR, mode);
  }
}

export function getFocusMode(): FocusMode {
  if (typeof document === 'undefined') return 'pointer';
  return document.documentElement.getAttribute(FOCUS_MODE_ATTR) === 'keyboard'
    ? 'keyboard'
    : 'pointer';
}

/**
 * Where focus currently sits, as a region id on <html> - the `focus-in-surface`
 * variant (globals.css) reads it to light the active pane's focus frame only
 * while the surface actually holds focus. Sidebar sections light theirs with
 * plain `:focus-within`; the pane can't, because its terminals/editors live in
 * sibling layers, not inside the pane element.
 */
export const FOCUS_IN_ATTR = 'data-focus-in';

/** Record where focus is (null = nothing focused → the surface). */
export function setFocusIn(el: Element | null): void {
  if (typeof document === 'undefined') return;
  const region = regionOf(el);
  if (document.documentElement.getAttribute(FOCUS_IN_ATTR) !== region) {
    document.documentElement.setAttribute(FOCUS_IN_ATTR, region);
  }
}

/**
 * Set on <html> by a focus-direction shortcut (⇧⌘Arrow) and cleared
 * `FOCUS_FLASH_MS` later, or at once by a pointerdown. The focus frame
 * (globals.css) lights only while it is set: a section is outlined for a few
 * seconds after the keyboard moves to it, never while you simply work in it
 * and never after a click (user decision 2026-09-22). Every press restarts
 * the clock, so a walk across several sections keeps the frame on the last.
 */
export const FOCUS_FLASH_ATTR = 'data-focus-flash';
export const FOCUS_FLASH_MS = 3_000;

let flashTimer: ReturnType<typeof setTimeout> | null = null;

export function flashFocusFrame(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(FOCUS_FLASH_ATTR, '');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(endFocusFlash, FOCUS_FLASH_MS);
}

export function endFocusFlash(): void {
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = null;
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute(FOCUS_FLASH_ATTR);
}

// Capture-phase so it runs before any handler that focuses something in
// response to the same event (the ↑/↓ handlers, the shortcut handler).
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => setFocusMode('keyboard'), true);
  window.addEventListener(
    'pointerdown',
    () => {
      setFocusMode('pointer');
      endFocusFlash();
    },
    true,
  );
  // focusout fires before the next element takes focus (activeElement is
  // already <body>): use its relatedTarget so the stamp never flickers through
  // "surface" between two sidebar rows. A focus loss with NO successor (the
  // focused row's view was just hidden by a session/project switch; focus
  // falls to <body> until the new view's row takes it a frame later) leaves
  // the stamp as it was: the new view renders fresh, so its pane frame would
  // otherwise light up for that frame - a visible blink on every switch.
  window.addEventListener('focusin', (e) => setFocusIn(e.target as Element | null), true);
  window.addEventListener(
    'focusout',
    (e) => {
      if (e.relatedTarget) setFocusIn(e.relatedTarget as Element);
    },
    true,
  );
  setFocusIn(document.activeElement);
}

/**
 * Keyboard focus sits in a sidebar region right now - what separates "the
 * user arrowed onto this row" (hold the surface) from "the user clicked this
 * row" (a click focuses it too, but the terminal is still meant to take over,
 * as it always has).
 */
function keyboardFocusInSidebar(): boolean {
  if (typeof document === 'undefined' || getFocusMode() !== 'keyboard') return false;
  const el = document.activeElement;
  return !!el && regionOf(el) !== 'surface';
}

/**
 * Whether the surface's terminal/editor must NOT take focus right now: a
 * sidebar hand-off is pending or just landed, or keyboard focus is (visibly)
 * in a sidebar region (keyboard focus mode). The timed hold covers the moments
 * in between - focus on `body` while the views swap; the region check covers the long tail, e.g.
 * an editor tab whose Monaco finishes loading a second later and would
 * otherwise take the caret away from the row. Consulted by every automatic
 * focus path in the surface; explicit focus (⇧⌘→ back into it) ignores it.
 */
export function isSurfaceFocusHeld(): boolean {
  const now = Date.now();
  return livePending(now) != null || now < holdUntil || keyboardFocusInSidebar();
}

/** The pending request (if any), left in place. */
export function peekRegionFocus(): { region: FocusRegion; key: string } | null {
  const req = livePending(Date.now());
  return req ? { region: req.region, key: req.key } : null;
}

/** Claim the pending request (if any), starting the post-landing hold. */
export function takeRegionFocus(): { region: FocusRegion; key: string } | null {
  const now = Date.now();
  const req = livePending(now);
  if (!req) return null;
  pending = null;
  holdUntil = now + HOLD_MS;
  return { region: req.region, key: req.key };
}

/**
 * The consuming side, for a view that just became active: focus the pending
 * request's row inside `root`. Deferred a frame so it runs after the surface's
 * own (held-back) focus effects, which also defer a frame and were registered
 * earlier in the same commit. Returns a cancel for cleanup.
 *
 * The request is only claimed once the focus actually lands: under StrictMode
 * a mount effect runs → cleans up → runs again, and claiming eagerly let the
 * first pass consume the request while its cleanup cancelled the frame - the
 * second pass then found nothing, and focus fell to `body` on every keyboard
 * session switch in dev. A row that isn't in this view (another view's turn)
 * leaves the request for it.
 */
export function focusPendingRegion(root: ParentNode | null): () => void {
  const req = peekRegionFocus();
  if (!req || !root) return () => {};
  const raf = requestAnimationFrame(() => {
    const container = root.querySelector(`[${FOCUS_REGION_ATTR}="${req.region}"]`);
    const el = container ? findFocusItem(container, req.key) : null;
    if (!el) return;
    // Still the same request? (A newer one supersedes it.)
    const live = peekRegionFocus();
    if (!live || live.region !== req.region || live.key !== req.key) return;
    takeRegionFocus();
    el.focus();
  });
  return () => cancelAnimationFrame(raf);
}

/** Test seam: forget any pending request / hold. */
export function resetRegionFocus(): void {
  pending = null;
  holdUntil = 0;
}
