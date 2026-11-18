import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaneRects } from '@renderer/lib/workspace/use-pane-rects';

/**
 * `usePaneRects` is the seam that positions every terminal over its pane. jsdom
 * has no layout, so the container's and each slot's rects are stubbed - which is
 * exactly what lets these tests feed in the fractional geometry a percentage
 * split produces.
 */

type Box = { left: number; top: number; width: number; height: number };

function stub(el: HTMLElement, box: Box): HTMLElement {
  el.getBoundingClientRect = () =>
    ({
      x: box.left,
      y: box.top,
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function mount(containerBox: Box, slots: Record<string, Box>) {
  const container = stub(document.createElement('div'), containerBox);
  const containerRef = { current: container };
  const hook = renderHook(({ key }: { key: string }) => usePaneRects(containerRef, key), {
    initialProps: { key: '' },
  });
  const els: Record<string, HTMLElement> = {};
  act(() => {
    for (const [id, box] of Object.entries(slots)) {
      els[id] = stub(document.createElement('div'), box);
      hook.result.current.registerPane(id)(els[id]);
    }
  });
  // A structural-key change measures synchronously (layout effect) - the same
  // path a real split takes - so no RAF is needed to read the rects back.
  const remeasure = (key = Object.keys(slots).sort().join(',')): void => {
    hook.rerender({ key });
  };
  remeasure();
  return { hook, els, container, remeasure, rects: () => hook.result.current.rects };
}

describe('usePaneRects', () => {
  // A 50/50 split of a 1193px-wide body (4px divider) puts the second pane at
  // x=598.37. The terminal layer positions a WebGL canvas at that x, and a
  // canvas on a sub-pixel offset is resampled by the compositor into blurred
  // text - only the first pane (x=0) stayed crisp. Rects must be whole pixels.
  it('snaps fractional pane geometry to whole pixels', () => {
    const { rects } = mount(
      { left: 120.5, top: 0, width: 1193, height: 800 },
      {
        p1: { left: 120.5, top: 36.25, width: 594.37, height: 763.75 },
        p2: { left: 718.87, top: 36.25, width: 594.63, height: 763.75 },
      },
    );
    expect(rects().get('p1')).toEqual({ x: 0, y: 36, width: 594, height: 764 });
    expect(rects().get('p2')).toEqual({ x: 598, y: 36, width: 595, height: 764 });
  });

  // Snapping the edges (not x and width independently) is what keeps neighbours
  // consistent: the two panes above end/start exactly one divider apart, and
  // the last pane's right edge still lands on the container's.
  it('snaps edges so neighbouring panes neither overlap nor gap', () => {
    const { rects } = mount(
      { left: 0, top: 0, width: 1000, height: 600 },
      {
        p1: { left: 0, top: 0, width: 331.6, height: 600 },
        p2: { left: 335.6, top: 0, width: 331.6, height: 600 },
        p3: { left: 671.2, top: 0, width: 328.8, height: 600 },
      },
    );
    const [a, b, c] = ['p1', 'p2', 'p3'].map((id) => rects().get(id)!);
    for (const r of [a, b, c]) {
      expect(Number.isInteger(r.x) && Number.isInteger(r.width)).toBe(true);
    }
    expect(b.x - (a.x + a.width)).toBe(4);
    expect(c.x - (b.x + b.width)).toBe(4);
    expect(c.x + c.width).toBe(1000);
  });

  // Percentage layouts jitter by fractions of a pixel between measurements; a
  // change that rounds to the same rect must keep the object's identity so the
  // memoized terminal slots (keyed on rect identity) don't re-render for it.
  it('keeps a rect identity-stable across sub-pixel jitter', () => {
    const { hook, els, remeasure, rects } = mount(
      { left: 0, top: 0, width: 1000, height: 600 },
      { p1: { left: 0, top: 0, width: 594.37, height: 600 } },
    );
    const before = rects().get('p1');
    const versionBefore = hook.result.current.version;
    stub(els.p1, { left: 0, top: 0, width: 594.45, height: 600 });
    remeasure('p1,'); // a different key re-runs the measure pass
    expect(rects().get('p1')).toBe(before);
    expect(hook.result.current.version).toBe(versionBefore);

    stub(els.p1, { left: 0, top: 0, width: 595.2, height: 600 });
    remeasure('p1,,');
    expect(rects().get('p1')).toEqual({ x: 0, y: 0, width: 595, height: 600 });
    expect(hook.result.current.version).toBe(versionBefore + 1);
  });

  describe('when the observer reports a resize', () => {
    /** The hook's ResizeObserver callback, fired by hand with the targets that changed. */
    let report: ((entries: Array<{ target: Element }>) => void) | null = null;
    afterEach(() => {
      vi.unstubAllGlobals();
      report = null;
    });
    const stubObserver = (): void => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: (entries: Array<{ target: Element }>) => void) {
            report = cb;
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );
    };

    // A dock opening under the panes shrinks the body. Measured on the next
    // frame and rendered after that, the terminals sat clipped under the
    // dock's edge for two painted frames.
    it('measures and renders a body resize before the frame paints', () => {
      stubObserver();
      const raf = vi.spyOn(window, 'requestAnimationFrame');
      const { hook, els, container, rects } = mount(
        { left: 0, top: 0, width: 1000, height: 800 },
        { a: { left: 0, top: 0, width: 1000, height: 800 } },
      );
      raf.mockClear();
      const version = hook.result.current.version;
      stub(els.a, { left: 0, top: 0, width: 1000, height: 500 });
      // The body (the observed container) is among the entries: rendered now,
      // inside the observer callback, with no frame waited for.
      act(() => report?.([{ target: container }]));
      expect(rects().get('a')?.height).toBe(500);
      expect(hook.result.current.version).toBe(version + 1);
      expect(raf).not.toHaveBeenCalled();
    });

    it('measures a slot-only change (a divider drag) on the next frame, once', async () => {
      stubObserver();
      const { hook, els, rects } = mount(
        { left: 0, top: 0, width: 1000, height: 800 },
        { a: { left: 0, top: 0, width: 600, height: 800 } },
      );
      stub(els.a, { left: 0, top: 0, width: 580, height: 800 });
      act(() => report?.([{ target: els.a }]));
      expect(rects().get('a')?.width).toBe(600);
      stub(els.a, { left: 0, top: 0, width: 560, height: 800 });
      act(() => report?.([{ target: els.a }]));
      await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
      expect(rects().get('a')?.width).toBe(560);
      expect(hook.result.current.rects.get('a')?.width).toBe(560);
    });
  });
});
