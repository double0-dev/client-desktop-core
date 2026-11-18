import { describe, expect, it } from 'vitest';
import { computeDropTarget } from '@renderer/lib/workspace/use-tab-drag';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';

/**
 * `computeDropTarget` is the hit-test behind the whole tab drag engine: where a
 * released tab lands (reorder in a strip, move into a pane, or split it). jsdom
 * has no layout, so every element's rect is stubbed explicitly - which is also
 * what lets these tests describe exact geometry.
 */

type Box = { left: number; top: number; width: number; height: number };

const asDomRect = (b: Box): DOMRect =>
  ({
    x: b.left,
    y: b.top,
    left: b.left,
    top: b.top,
    right: b.left + b.width,
    bottom: b.top + b.height,
    width: b.width,
    height: b.height,
    toJSON: () => ({}),
  }) as DOMRect;

function stub(el: HTMLElement, box: Box): HTMLElement {
  el.getBoundingClientRect = () => asDomRect(box);
  return el;
}

/** The workspace body, optionally holding tab strips with tabs. */
function makeContainer(opts: {
  base?: Box;
  strips?: { paneId: string; box: Box; tabs: Box[] }[];
}): HTMLElement {
  const container = document.createElement('div');
  stub(container, opts.base ?? { left: 0, top: 0, width: 1000, height: 800 });
  for (const strip of opts.strips ?? []) {
    const el = document.createElement('div');
    el.setAttribute('data-strip-pane', strip.paneId);
    stub(el, strip.box);
    strip.tabs.forEach((tab, i) => {
      const tabEl = document.createElement('div');
      tabEl.setAttribute('data-tab-id', `t${i}`);
      stub(tabEl, tab);
      el.appendChild(tabEl);
    });
    container.appendChild(el);
  }
  document.body.appendChild(container);
  return container;
}

const paneRects = (entries: Record<string, PaneRect>): Map<string, PaneRect> =>
  new Map(Object.entries(entries));

// A single 800×600 pane body sitting below a 36px strip.
const PANE: PaneRect = { x: 0, y: 36, width: 800, height: 600 };

describe('no target', () => {
  it('returns null without a container', () => {
    expect(computeDropTarget(null, paneRects({ p1: PANE }), 100, 100)).toBeNull();
  });

  it('returns null when the point is outside every pane and strip', () => {
    const container = makeContainer({});
    expect(computeDropTarget(container, paneRects({ p1: PANE }), 900, 700)).toBeNull();
  });

  it('ignores a strip that has not been laid out yet', () => {
    // A zero-sized strip is a strip that has not measured; it must not swallow
    // the drop.
    const container = makeContainer({
      strips: [{ paneId: 'p1', box: { left: 0, top: 0, width: 0, height: 0 }, tabs: [] }],
    });
    const target = computeDropTarget(container, paneRects({ p1: PANE }), 400, 300);
    expect(target?.kind).toBe('pane');
  });
});

describe('pane zones', () => {
  const container = (): HTMLElement => makeContainer({});
  const hit = (cx: number, cy: number) =>
    computeDropTarget(container(), paneRects({ p1: PANE }), cx, cy);

  it('drops into the pane from the middle', () => {
    expect(hit(400, 336)).toEqual({ kind: 'pane', paneId: 'p1', rect: PANE });
  });

  it('splits left near the left edge', () => {
    expect(hit(5, 336)).toMatchObject({ kind: 'split', paneId: 'p1', edge: 'left' });
  });

  it('splits right near the right edge', () => {
    expect(hit(795, 336)).toMatchObject({ kind: 'split', edge: 'right' });
  });

  it('splits top near the top edge', () => {
    expect(hit(400, 41)).toMatchObject({ kind: 'split', edge: 'top' });
  });

  it('splits bottom near the bottom edge', () => {
    expect(hit(400, 631)).toMatchObject({ kind: 'split', edge: 'bottom' });
  });

  it('picks the nearest edge in a corner', () => {
    // 10px from the left, 20px from the top → left wins.
    expect(hit(10, 56)).toMatchObject({ edge: 'left' });
    expect(hit(30, 41)).toMatchObject({ edge: 'top' });
  });

  it('carries the pane rect so the indicator can be drawn', () => {
    expect(hit(5, 336)).toMatchObject({ rect: PANE });
  });
});

describe('the edge band', () => {
  // 30% of each axis (left/right from the width, top/bottom from the height),
  // floored at 24px, never capped.
  it('splits a wide pane from its outer 30%, not only at the very edge', () => {
    // The bug: the band came from the SHORTER side and was capped at 80px, so on
    // a wide pane "open side by side" needed the cursor in the last 80px - right
    // next to the window edge, where the drag tears off instead.
    const rects = paneRects({ p1: { x: 0, y: 0, width: 1400, height: 800 } });
    const c = makeContainer({});
    // bandX = 1400 * 0.3 = 420 → the right split starts 420px from the edge.
    expect(computeDropTarget(c, rects, 1000, 400)).toMatchObject({ kind: 'split', edge: 'right' });
    expect(computeDropTarget(c, rects, 979, 400)).toMatchObject({ kind: 'pane' });
    expect(computeDropTarget(c, rects, 981, 400)).toMatchObject({ kind: 'split', edge: 'right' });
  });

  it('sizes each axis from its own length', () => {
    const rects = paneRects({ p1: { x: 0, y: 0, width: 1000, height: 300 } });
    const c = makeContainer({});
    // bandX = 1000 * 0.3 = 300, bandY = 300 * 0.3 = 90.
    expect(computeDropTarget(c, rects, 299, 150)).toMatchObject({ kind: 'split', edge: 'left' });
    expect(computeDropTarget(c, rects, 301, 150)).toMatchObject({ kind: 'pane' });
    expect(computeDropTarget(c, rects, 500, 89)).toMatchObject({ kind: 'split', edge: 'top' });
    expect(computeDropTarget(c, rects, 500, 91)).toMatchObject({ kind: 'pane' });
  });

  it('judges a corner proportionally on a non-square pane', () => {
    const rects = paneRects({ p1: { x: 0, y: 0, width: 1000, height: 300 } });
    const c = makeContainer({});
    // 150px from the left is half of bandX (300); 60px from the top is two
    // thirds of bandY (90). Left is proportionally nearer although top is
    // nearer in pixels.
    expect(computeDropTarget(c, rects, 150, 60)).toMatchObject({ kind: 'split', edge: 'left' });
  });

  it('never goes below the 24px floor on a tiny pane', () => {
    const rects = paneRects({ p1: { x: 0, y: 0, width: 40, height: 40 } });
    const c = makeContainer({});
    // 40 * 0.3 = 12 → floored to 24. Half the pane is 20 < 24, so even the dead
    // centre falls inside an edge band and there is no "drop into pane" zone.
    expect(computeDropTarget(c, rects, 20, 20)).toMatchObject({ kind: 'split' });
  });

  it('leaves a pane zone as soon as the pane is bigger than twice the floor', () => {
    const rects = paneRects({ p1: { x: 0, y: 0, width: 60, height: 60 } });
    const c = makeContainer({});
    // Centre is 30px from each edge, past the 24px floor.
    expect(computeDropTarget(c, rects, 30, 30)).toMatchObject({ kind: 'pane' });
  });

  it('keeps scaling on a huge pane', () => {
    const rects = paneRects({ p1: { x: 0, y: 0, width: 4000, height: 3000 } });
    const c = makeContainer({});
    // 4000 * 0.3 = 1200 - no fixed ceiling.
    expect(computeDropTarget(c, rects, 1199, 1500)).toMatchObject({ kind: 'split' });
    expect(computeDropTarget(c, rects, 1201, 1500)).toMatchObject({ kind: 'pane' });
  });
});

describe('tab strips take priority over pane bodies', () => {
  const strip = { left: 0, top: 0, width: 800, height: 36 };
  const tabs = [
    { left: 0, top: 0, width: 100, height: 36 },
    { left: 100, top: 0, width: 100, height: 36 },
    { left: 200, top: 0, width: 100, height: 36 },
  ];
  const build = (): HTMLElement => makeContainer({ strips: [{ paneId: 'p1', box: strip, tabs }] });

  const index = (cx: number, cy = 18): number => {
    const t = computeDropTarget(build(), paneRects({ p1: PANE }), cx, cy);
    if (t?.kind !== 'strip') throw new Error(`expected a strip target, got ${t?.kind}`);
    return t.index;
  };

  it('resolves a strip hit even though a pane also covers the point', () => {
    const overlapping = paneRects({ p1: { x: 0, y: 0, width: 800, height: 600 } });
    expect(computeDropTarget(build(), overlapping, 50, 18)?.kind).toBe('strip');
  });

  it('inserts before the first tab on its leading half', () => {
    expect(index(10)).toBe(0);
  });

  it('inserts after a tab once the cursor passes its midpoint', () => {
    expect(index(49)).toBe(0);
    expect(index(51)).toBe(1);
  });

  it('counts every tab the cursor is past', () => {
    expect(index(151)).toBe(2);
    expect(index(251)).toBe(3);
  });

  it('inserts at the end past the last tab', () => {
    expect(index(700)).toBe(3);
  });

  it('reports the pane the strip belongs to', () => {
    const t = computeDropTarget(build(), paneRects({ p1: PANE }), 50, 18);
    expect(t).toMatchObject({ kind: 'strip', paneId: 'p1' });
  });
});

describe('the caret the indicator draws', () => {
  const strip = { left: 0, top: 0, width: 800, height: 36 };
  const tabs = [
    { left: 0, top: 0, width: 100, height: 36 },
    { left: 100, top: 0, width: 100, height: 36 },
  ];
  const caretAt = (cx: number, base?: Box) => {
    const container = makeContainer({ base, strips: [{ paneId: 'p1', box: strip, tabs }] });
    const t = computeDropTarget(container, paneRects({ p1: PANE }), cx, 18);
    if (t?.kind !== 'strip') throw new Error('expected a strip target');
    return t.caret;
  };

  it('sits on the leading edge of the tab it would insert before', () => {
    expect(caretAt(10)).toEqual({ x: 0, y: 0, h: 36 });
    expect(caretAt(110)).toEqual({ x: 100, y: 0, h: 36 });
  });

  it('sits on the trailing edge of the last tab when appending', () => {
    expect(caretAt(700)).toEqual({ x: 200, y: 0, h: 36 });
  });

  it('is relative to the container, not the viewport', () => {
    // The workspace body is offset inside the window; the drag layer draws in
    // the body's own coordinate space.
    expect(caretAt(10, { left: 40, top: 20, width: 1000, height: 800 })).toEqual({
      x: -40,
      y: -20,
      h: 36,
    });
  });

  it('falls back to the strip’s leading edge when the strip is empty', () => {
    const container = makeContainer({
      strips: [{ paneId: 'p1', box: { left: 12, top: 4, width: 800, height: 60 }, tabs: [] }],
    });
    const t = computeDropTarget(container, paneRects({ p1: PANE }), 100, 20);
    expect(t).toMatchObject({ kind: 'strip', index: 0 });
    // Capped at one row tall rather than the whole (multi-row) strip height.
    expect(t?.kind === 'strip' && t.caret).toEqual({ x: 12, y: 4, h: 36 });
  });
});

describe('multi-row strips', () => {
  // Two rows of two tabs each: row 0 at y 0–36, row 1 at y 36–72.
  const strip = { left: 0, top: 0, width: 220, height: 72 };
  const tabs = [
    { left: 0, top: 0, width: 100, height: 36 },
    { left: 100, top: 0, width: 100, height: 36 },
    { left: 0, top: 36, width: 100, height: 36 },
    { left: 100, top: 36, width: 100, height: 36 },
  ];
  const build = (): HTMLElement => makeContainer({ strips: [{ paneId: 'p1', box: strip, tabs }] });
  const target = (cx: number, cy: number) => {
    const t = computeDropTarget(build(), paneRects({ p1: PANE }), cx, cy);
    if (t?.kind !== 'strip') throw new Error('expected a strip target');
    return t;
  };

  it('counts a whole row above the cursor as "before"', () => {
    // Cursor on row 1, left half → both row-0 tabs precede it.
    expect(target(10, 54).index).toBe(2);
  });

  it('applies the midpoint rule within the cursor’s own row', () => {
    // Row 0's two tabs always count (2), then within row 1: past t2's midpoint
    // (50) but before t3's (150) → 3; past both → 4.
    expect(target(120, 54).index).toBe(3);
    expect(target(151, 54).index).toBe(4);
  });

  it('stops at a row entirely below the cursor', () => {
    expect(target(10, 18).index).toBe(0);
    expect(target(151, 18).index).toBe(2);
  });

  it('puts the caret on the cursor’s row', () => {
    expect(target(10, 54).caret.y).toBe(36);
    expect(target(10, 18).caret.y).toBe(0);
  });
});

describe('the per-gesture strip-rect cache', () => {
  const strip = { left: 0, top: 0, width: 800, height: 36 };
  const tabs = [
    { left: 0, top: 0, width: 100, height: 36 },
    { left: 100, top: 0, width: 100, height: 36 },
  ];

  it('captures the strip’s tab rects on first use', () => {
    const cache = new Map<string, DOMRect[]>();
    const container = makeContainer({ strips: [{ paneId: 'p1', box: strip, tabs }] });
    computeDropTarget(container, paneRects({ p1: PANE }), 50, 18, cache);
    expect(cache.get('p1')).toHaveLength(2);
  });

  it('keeps using the captured rects while the strip slides its tabs apart', () => {
    // A local drag transforms the strip's tabs to preview the gap. Re-measuring
    // would feed that gap back into the index and make it oscillate.
    const cache = new Map<string, DOMRect[]>();
    const container = makeContainer({ strips: [{ paneId: 'p1', box: strip, tabs }] });
    const first = computeDropTarget(container, paneRects({ p1: PANE }), 150, 18, cache);

    // The DOM now reports shifted rects (the gap opened)…
    const tabEls = container.querySelectorAll<HTMLElement>('[data-tab-id]');
    stub(tabEls[0], { left: 0, top: 0, width: 100, height: 36 });
    stub(tabEls[1], { left: 300, top: 0, width: 100, height: 36 });

    // …but the cached rects still decide.
    const second = computeDropTarget(container, paneRects({ p1: PANE }), 150, 18, cache);
    expect(second).toEqual(first);
  });

  it('re-measures every call when no cache is passed', () => {
    // The cross-window preview path passes nothing; its strips never transform.
    const container = makeContainer({ strips: [{ paneId: 'p1', box: strip, tabs }] });
    const before = computeDropTarget(container, paneRects({ p1: PANE }), 150, 18);
    expect(before).toMatchObject({ index: 2 });

    const tabEls = container.querySelectorAll<HTMLElement>('[data-tab-id]');
    stub(tabEls[1], { left: 300, top: 0, width: 100, height: 36 });

    const after = computeDropTarget(container, paneRects({ p1: PANE }), 150, 18);
    expect(after).toMatchObject({ index: 1 });
  });
});
