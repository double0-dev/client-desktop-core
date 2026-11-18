import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { updateHoverScrollSettings } from '@renderer/lib/settings/hover-scroll-settings';
import { HoverScrollText } from './hover-scroll-text';

/** jsdom lays nothing out - give the text box the widths a browser would. */
function size(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

/** jsdom has no Web Animations - record what would have played. */
const animate = vi.fn();
const cancel = vi.fn();
const setKeyframes = vi.fn();
const updateTiming = vi.fn();

beforeEach(() => {
  for (const f of [animate, cancel, setKeyframes, updateTiming]) f.mockClear();
  animate.mockImplementation(() => ({ cancel, effect: { setKeyframes, updateTiming } }));
  Element.prototype.animate = animate as unknown as Element['animate'];
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).animate;
});

function Row({ text }: { text: string }) {
  return (
    <div data-testid="row" data-hover-scroll-root>
      <HoverScrollText data-testid="text">{text}</HoverScrollText>
    </div>
  );
}

function renderRow(text = 'refactor-the-session-sidebar-row') {
  const view = render(<Row text={text} />);
  return { ...view, row: screen.getByTestId('row'), text: screen.getByTestId('text') };
}

describe('HoverScrollText', () => {
  it('starts sliding 150 ms into the hover, however long the text', () => {
    const { row, text } = renderRow();
    // A long name: 400px hidden is 10s of travel. The start must not scale
    // with it - a share of the pass made long names wait ~1.5s (the bug).
    size(text, 560, 160);
    expect(animate).not.toHaveBeenCalled();

    fireEvent.pointerEnter(row);
    expect(text.dataset.scrolling).toBe('');
    const [keyframes, timing] = animate.mock.calls[0];
    expect(timing).toMatchObject({ iterations: Infinity, direction: 'alternate' });
    // 600 ms rest + 10 s travel + 1.2 s rest.
    expect(timing.duration).toBe(11_800);
    // The start rest is skipped down to 150 ms by a negative delay.
    expect(timing.delay).toBe(150 - 600);
    expect(keyframes[1].offset * timing.duration).toBeCloseTo(600);
    expect(keyframes.at(-1).transform).toBe('translateX(-400px)');
  });

  it('never moves text that fits', () => {
    const { row, text } = renderRow('short');
    size(text, 160, 160);
    fireEvent.pointerEnter(row);
    expect(animate).not.toHaveBeenCalled();
    expect(text.dataset.scrolling).toBeUndefined();
  });

  it('stops and restores the ellipsis when the pointer leaves the row', () => {
    const { row, text } = renderRow();
    size(text, 240, 160);
    fireEvent.pointerEnter(row);
    fireEvent.pointerLeave(row);
    expect(cancel).toHaveBeenCalled();
    expect(text.dataset.scrolling).toBeUndefined();
  });

  it('retunes the running slide when the text changes mid-hover, without restarting it', () => {
    const { row, text, rerender } = renderRow('Running pnpm test');
    size(text, 240, 160);
    fireEvent.pointerEnter(row);
    expect(animate).toHaveBeenCalledTimes(1);

    // The activity line moved on to its next tool while hovered.
    size(text, 400, 160);
    act(() => rerender(<Row text="Editing src/renderer/src/components/a-much-longer-name.tsx" />));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(setKeyframes.mock.calls[0][0].at(-1).transform).toBe('translateX(-240px)');
    expect(updateTiming).toHaveBeenCalledWith({ duration: 600 + 6000 + 1200 });
  });

  it('holds still while Settings › General switches it off, and moves again once on', () => {
    updateHoverScrollSettings({ enabled: false });
    try {
      const { row, text } = renderRow();
      size(text, 240, 160);
      fireEvent.pointerEnter(row);
      expect(animate).not.toHaveBeenCalled();
      expect(text.dataset.scrolling).toBeUndefined();

      fireEvent.pointerLeave(row);
      updateHoverScrollSettings({ enabled: true });
      fireEvent.pointerEnter(row);
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      updateHoverScrollSettings({ enabled: true });
    }
  });

  it('holds still under reduced motion', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') })) as typeof matchMedia;
    try {
      const { row, text } = renderRow();
      size(text, 240, 160);
      fireEvent.pointerEnter(row);
      expect(animate).not.toHaveBeenCalled();
      expect(text.className).toContain('truncate');
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
