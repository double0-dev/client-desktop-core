import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOCUS_FLASH_ATTR,
  FOCUS_FLASH_MS,
  FOCUS_IN_ATTR,
  FOCUS_MODE_ATTR,
  endFocusFlash,
  findFocusItem,
  flashFocusFrame,
  focusPendingRegion,
  focusRegion,
  focusRegionPart,
  getFocusMode,
  holdSurfaceFocus,
  isSurfaceFocusHeld,
  plainArrowStep,
  regionInDirection,
  regionOf,
  requestRegionFocus,
  resetRegionFocus,
  setFocusIn,
  setFocusMode,
  stepFocusItem,
  takeRegionFocus,
  type RegionLayout,
} from '@renderer/lib/workspace/focus-regions';

/**
 * The ⇧⌘Arrow walk across the workspace's regions (`dock | explorer |
 * surface`), and the DOM conventions the panels share so the global handler
 * can move focus between them without knowing any panel's markup.
 */

const FULL: RegionLayout = {
  dock: ['projects', 'sessions', 'tabs'],
  explorer: true,
  drawer: false,
  bottom: false,
};

describe('regionInDirection', () => {
  it('leaves the surface leftwards into the explorer when it is open', () => {
    expect(regionInDirection(FULL, 'surface', 'left')).toBe('explorer');
  });

  it('skips a closed explorer and lands in the dock, preferring Sessions', () => {
    expect(
      regionInDirection(
        { dock: ['projects', 'sessions'], explorer: false, drawer: false, bottom: false },
        'surface',
        'left',
      ),
    ).toBe('sessions');
    // Sessions closed → the topmost open panel.
    expect(
      regionInDirection(
        { dock: ['projects', 'tabs'], explorer: false, drawer: false, bottom: false },
        'surface',
        'left',
      ),
    ).toBe('projects');
  });

  it('goes nowhere from the surface when no sidebar is open', () => {
    expect(
      regionInDirection(
        { dock: [], explorer: false, drawer: false, bottom: false },
        'surface',
        'left',
      ),
    ).toBeNull();
  });

  it('never leaves the surface up, nor down while the bottom panel is closed', () => {
    for (const d of ['up', 'down'] as const) {
      expect(regionInDirection(FULL, 'surface', d)).toBeNull();
    }
  });

  it('goes down from the surface into an open bottom panel, and back up', () => {
    const withBottom = { ...FULL, bottom: true };
    expect(regionInDirection(withBottom, 'surface', 'down')).toBe('bottom');
    expect(regionInDirection(withBottom, 'surface', 'up')).toBeNull();
    expect(regionInDirection(withBottom, 'bottom', 'up')).toBe('surface');
    // ←/→ inside the dock are its parts' (focusRegionPart), and nothing lies below.
    for (const d of ['left', 'right', 'down'] as const) {
      expect(regionInDirection(withBottom, 'bottom', d)).toBeNull();
    }
  });

  it('leaves the surface rightwards only into an open drawer, and comes back', () => {
    expect(regionInDirection(FULL, 'surface', 'right')).toBeNull();
    const withDrawer = { ...FULL, drawer: true };
    expect(regionInDirection(withDrawer, 'surface', 'right')).toBe('drawer');
    expect(regionInDirection(withDrawer, 'drawer', 'left')).toBe('surface');
    for (const d of ['right', 'up', 'down'] as const) {
      expect(regionInDirection(withDrawer, 'drawer', d)).toBeNull();
    }
  });

  it('walks explorer ↔ dock ↔ surface horizontally', () => {
    expect(regionInDirection(FULL, 'explorer', 'right')).toBe('surface');
    expect(regionInDirection(FULL, 'explorer', 'left')).toBe('sessions');
    expect(regionInDirection(FULL, 'sessions', 'right')).toBe('explorer');
    // With the explorer closed the dock's right neighbour is the surface itself.
    expect(
      regionInDirection(
        { ...FULL, explorer: false, drawer: false, bottom: false },
        'sessions',
        'right',
      ),
    ).toBe('surface');
    expect(regionInDirection(FULL, 'sessions', 'left')).toBeNull();
  });

  it('walks the open dock panels vertically, in stacking order, without wrapping', () => {
    expect(regionInDirection(FULL, 'projects', 'down')).toBe('sessions');
    expect(regionInDirection(FULL, 'sessions', 'down')).toBe('tabs');
    expect(regionInDirection(FULL, 'tabs', 'down')).toBeNull();
    expect(regionInDirection(FULL, 'sessions', 'up')).toBe('projects');
    expect(regionInDirection(FULL, 'projects', 'up')).toBeNull();
    // A closed panel in between is skipped - the list is the OPEN set.
    expect(regionInDirection({ ...FULL, dock: ['projects', 'tabs'] }, 'projects', 'down')).toBe(
      'tabs',
    );
  });

  it('has no vertical neighbours from the explorer, or from a panel that is no longer open', () => {
    expect(regionInDirection(FULL, 'explorer', 'up')).toBeNull();
    expect(regionInDirection({ ...FULL, dock: ['projects'] }, 'sessions', 'down')).toBeNull();
  });
});

describe('DOM conventions', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-focus-region="sessions">
        <div tabindex="0" data-focus-item data-focus-key="a">a</div>
        <button data-row-action>kebab</button>
        <div tabindex="0" data-focus-item data-focus-key="b" data-focus-current="true"><span>b</span></div>
        <div tabindex="0" data-focus-item data-focus-key='c"quoted'>c</div>
      </div>
      <div data-focus-region="projects"></div>
      <div id="terminal"><textarea></textarea></div>
    `;
  });

  it('regionOf resolves the enclosing region, and the surface for anything else', () => {
    expect(regionOf(document.querySelector('[data-focus-key="a"]'))).toBe('sessions');
    expect(regionOf(document.querySelector('[data-row-action]'))).toBe('sessions');
    expect(regionOf(document.querySelector('textarea'))).toBe('surface');
    expect(regionOf(document.body)).toBe('surface');
    expect(regionOf(null)).toBe('surface');
  });

  it('focusRegion lands on the current item, else the first, and reports a miss', () => {
    expect(focusRegion(document, 'sessions')).toBe(true);
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('b');
    document.querySelector('[data-focus-current]')!.removeAttribute('data-focus-current');
    expect(focusRegion(document, 'sessions')).toBe(true);
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('a');
    // Mounted but empty, and not mounted at all.
    expect(focusRegion(document, 'projects')).toBe(false);
    expect(focusRegion(document, 'explorer')).toBe(false);
  });

  it('focusRegion hands focus to the field inside an item that takes none itself', () => {
    document.body.innerHTML = `
      <div data-focus-region="bottom">
        <div data-focus-item data-focus-current="true"><textarea id="xterm"></textarea></div>
      </div>
    `;
    expect(focusRegion(document, 'bottom')).toBe(true);
    expect(document.activeElement?.id).toBe('xterm');
  });

  it('focusRegionPart moves between the side-by-side parts of a region', () => {
    document.body.innerHTML = `
      <div data-focus-region="bottom">
        <div data-focus-part="list">
          <div tabindex="0" data-focus-item data-focus-key="dev">dev</div>
          <div tabindex="0" data-focus-item data-focus-key="build" data-focus-current="true">build</div>
        </div>
        <div data-focus-part="terminal">
          <div data-focus-item style="display:none"><textarea id="other"></textarea></div>
          <div data-focus-item data-focus-current="true"><textarea id="shown"></textarea></div>
        </div>
      </div>
    `;
    const build = document.querySelector<HTMLElement>('[data-focus-key="build"]')!;
    build.focus();
    // → lands in the SELECTED command's terminal, not the first one mounted.
    expect(focusRegionPart(document, 'bottom', build, 'right')).toBe(true);
    expect(document.activeElement?.id).toBe('shown');
    expect(focusRegionPart(document, 'bottom', document.activeElement, 'right')).toBe(false);
    expect(focusRegionPart(document, 'bottom', document.activeElement, 'left')).toBe(true);
    expect(document.activeElement).toBe(build);
    expect(focusRegionPart(document, 'bottom', build, 'left')).toBe(false);
  });

  it('focusRegionPart stays put when the next part has nothing to focus', () => {
    document.body.innerHTML = `
      <div data-focus-region="bottom">
        <div data-focus-part="list"><div tabindex="0" data-focus-item>dev</div></div>
        <div data-focus-part="terminal"><p>Select a command, then press Run</p></div>
      </div>
    `;
    const row = document.querySelector<HTMLElement>('[data-focus-item]')!;
    row.focus();
    expect(focusRegionPart(document, 'bottom', row, 'right')).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it('stepFocusItem walks items in DOM order, skipping non-items, without wrapping', () => {
    const region = document.querySelector('[data-focus-region="sessions"]')!;
    const a = document.querySelector('[data-focus-key="a"]')!;
    const b = document.querySelector('[data-focus-key="b"]')!;
    expect(stepFocusItem(region, a, 1)).toBe(b);
    expect(stepFocusItem(region, b, -1)).toBe(a);
    expect(stepFocusItem(region, a, -1)).toBeNull();
    // From a descendant of an item (the row's inner label), the row counts.
    expect(stepFocusItem(region, b.firstElementChild!, 1)?.getAttribute('data-focus-key')).toBe(
      'c"quoted',
    );
    // From something that is not inside an item: the list's first / last.
    const kebab = document.querySelector('[data-row-action]')!;
    expect(stepFocusItem(region, kebab, 1)).toBe(a);
  });

  it('plainArrowStep steps on a bare ↑/↓ only, never with a modifier held', () => {
    const key = (k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: k, ...mods });
    expect(plainArrowStep(key('ArrowDown'))).toBe(1);
    expect(plainArrowStep(key('ArrowUp'))).toBe(-1);
    expect(plainArrowStep(key('ArrowLeft'))).toBeNull();
    expect(plainArrowStep(key('Enter'))).toBeNull();
    // ⇧⌘↑/↓ is the section walk: the global handler has already moved focus to
    // the panel above/below, and a Sessions list that stepped on it as well
    // switched the session instead of leaving the panel.
    expect(plainArrowStep(key('ArrowUp', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(plainArrowStep(key('ArrowDown', { ctrlKey: true, shiftKey: true }))).toBeNull();
    for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(plainArrowStep(key('ArrowDown', { [mod]: true }))).toBeNull();
    }
  });

  it('findFocusItem matches keys by value, so ids with quotes or slashes are fine', () => {
    const region = document.querySelector('[data-focus-region="sessions"]')!;
    expect(findFocusItem(region, 'c"quoted')?.textContent).toBe('c');
    expect(findFocusItem(region, 'nope')).toBeNull();
  });
});

describe('re-focus hand-off and the surface hold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRegionFocus();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetRegionFocus();
  });

  it('holds the surface while a request is pending and briefly after it is taken', () => {
    expect(isSurfaceFocusHeld()).toBe(false);
    requestRegionFocus('sessions', 's2');
    expect(isSurfaceFocusHeld()).toBe(true);
    // A second request replaces the first (the user kept arrowing).
    requestRegionFocus('sessions', 's3');
    expect(takeRegionFocus()).toEqual({ region: 'sessions', key: 's3' });
    expect(takeRegionFocus()).toBeNull();
    // The hold outlasts the take so the switched-in view's deferred focus
    // effects (rAF, ResizeObserver) still stand down…
    expect(isSurfaceFocusHeld()).toBe(true);
    vi.advanceTimersByTime(900);
    // …but not for long, so clicking into the terminal right after behaves.
    expect(isSurfaceFocusHeld()).toBe(false);
  });

  it('expires a request no view ever consumed', () => {
    requestRegionFocus('projects', 'p1');
    vi.advanceTimersByTime(3_100);
    expect(isSurfaceFocusHeld()).toBe(false);
    expect(takeRegionFocus()).toBeNull();
  });

  it('holdSurfaceFocus holds without filing a request', () => {
    holdSurfaceFocus();
    expect(isSurfaceFocusHeld()).toBe(true);
    expect(takeRegionFocus()).toBeNull();
    vi.advanceTimersByTime(900);
    expect(isSurfaceFocusHeld()).toBe(false);
  });

  it('focusPendingRegion focuses the requested row a frame later, inside the given root only', () => {
    document.body.innerHTML = `
      <div id="hidden"><div data-focus-region="sessions"><div tabindex="0" data-focus-item data-focus-key="s2">x</div></div></div>
      <div id="view"><div data-focus-region="sessions"><div tabindex="0" data-focus-item data-focus-key="s2">y</div></div></div>
    `;
    // First pass: the frame never fires (cleaned up before it could).
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    requestRegionFocus('sessions', 's2');
    // StrictMode shape: the effect runs, is cleaned up before the frame, and
    // runs again - the second pass must still land (the request is claimed only
    // when the focus does).
    focusPendingRegion(document.getElementById('view'))();
    raf.mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    expect(document.activeElement).toBe(document.body);
    focusPendingRegion(document.getElementById('view'));
    expect(document.activeElement?.textContent).toBe('y');
    // Consumed: a later view activation does nothing.
    document.getElementById('view')!.querySelector<HTMLElement>('[data-focus-item]')!.blur();
    focusPendingRegion(document.getElementById('view'));
    expect(document.activeElement).toBe(document.body);
    vi.restoreAllMocks();
  });
});

describe('keyboard focus sitting in a sidebar region', () => {
  // The long-tail case of the hold: an editor tab whose Monaco finishes
  // loading a second after the session switch must not take the caret away
  // from the row the user arrowed onto - but a row focused by a mouse click
  // (pointer mode) still hands the terminal its focus, as it always has.
  beforeEach(() => {
    resetRegionFocus();
    document.documentElement.removeAttribute(FOCUS_MODE_ATTR);
    document.body.innerHTML = `
      <div data-focus-region="sessions"><div tabindex="0" data-focus-item data-focus-key="s1">s1</div></div>
      <div id="terminal"><textarea></textarea></div>
    `;
  });
  afterEach(() => {
    document.documentElement.removeAttribute(FOCUS_MODE_ATTR);
    resetRegionFocus();
  });

  it('tracks the focus mode from the last input: keyboard after a keydown, pointer after a pointerdown', () => {
    expect(getFocusMode()).toBe('pointer');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(getFocusMode()).toBe('keyboard');
    expect(document.documentElement.getAttribute(FOCUS_MODE_ATTR)).toBe('keyboard');
    window.dispatchEvent(new Event('pointerdown'));
    expect(getFocusMode()).toBe('pointer');
  });

  it('holds the surface while a sidebar row has focus in keyboard mode', () => {
    const row = document.querySelector<HTMLElement>('[data-focus-key="s1"]')!;
    setFocusMode('keyboard');
    row.focus();
    expect(isSurfaceFocusHeld()).toBe(true);
  });

  it('does not hold for a pointer-focused row, or for keyboard focus in the surface', () => {
    const row = document.querySelector<HTMLElement>('[data-focus-key="s1"]')!;
    setFocusMode('pointer');
    row.focus();
    expect(isSurfaceFocusHeld()).toBe(false);
    setFocusMode('keyboard');
    document.querySelector<HTMLElement>('textarea')!.focus();
    expect(isSurfaceFocusHeld()).toBe(false);
  });
});

describe('the focus-in stamp (drives the pane focus frame)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-focus-region="sessions"><div tabindex="0" data-focus-item data-focus-key="s1">s1</div></div>
      <div id="terminal"><textarea></textarea></div>
    `;
  });

  it('names the region focus is in, and the surface for the terminal', () => {
    document.querySelector<HTMLElement>('[data-focus-key="s1"]')!.focus();
    expect(document.documentElement.getAttribute(FOCUS_IN_ATTR)).toBe('sessions');
    document.querySelector<HTMLElement>('textarea')!.focus();
    expect(document.documentElement.getAttribute(FOCUS_IN_ATTR)).toBe('surface');
  });

  it('keeps the last region when focus is simply lost (a view swap), so the new pane does not blink', () => {
    // A keyboard session switch hides the focused row's view: focus falls to
    // <body> for a frame before the new view's row takes it. Re-stamping
    // "surface" there lit the new pane's frame for that frame - a blink.
    document.querySelector<HTMLElement>('[data-focus-key="s1"]')!.focus();
    (document.activeElement as HTMLElement).blur();
    expect(document.documentElement.getAttribute(FOCUS_IN_ATTR)).toBe('sessions');
    // An explicit "nothing focusable in the surface" hand-off still counts.
    setFocusIn(null);
    expect(document.documentElement.getAttribute(FOCUS_IN_ATTR)).toBe('surface');
  });
});

describe('the focus flash (lights the focus frame after ⇧⌘Arrow)', () => {
  const flashing = (): boolean => document.documentElement.hasAttribute(FOCUS_FLASH_ATTR);

  beforeEach(() => {
    vi.useFakeTimers();
    endFocusFlash();
  });
  afterEach(() => {
    endFocusFlash();
    vi.useRealTimers();
  });

  it('shows the frame for three seconds after a press, then lets it go', () => {
    expect(flashing()).toBe(false);
    flashFocusFrame();
    expect(flashing()).toBe(true);
    vi.advanceTimersByTime(FOCUS_FLASH_MS - 1);
    expect(flashing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(flashing()).toBe(false);
  });

  it('restarts the clock on every press, so a walk across sections keeps the last one framed', () => {
    // Without the restart the first press's timer would end the flash 3 s
    // after the walk began, taking the frame off the section just reached.
    flashFocusFrame();
    vi.advanceTimersByTime(2_000);
    flashFocusFrame();
    vi.advanceTimersByTime(2_000);
    expect(flashing()).toBe(true);
    vi.advanceTimersByTime(FOCUS_FLASH_MS - 2_000);
    expect(flashing()).toBe(false);
  });

  it('ends at once on a pointerdown - a click needs no frame to find its target', () => {
    flashFocusFrame();
    window.dispatchEvent(new Event('pointerdown'));
    expect(flashing()).toBe(false);
    // The cancelled timer must not strike a later flash early.
    vi.advanceTimersByTime(1_000);
    flashFocusFrame();
    vi.advanceTimersByTime(FOCUS_FLASH_MS - 1);
    expect(flashing()).toBe(true);
  });

  it('is not set by ordinary typing', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(flashing()).toBe(false);
  });
});
