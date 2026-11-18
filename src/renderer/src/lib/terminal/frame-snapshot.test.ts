import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { captureFrame } from '@renderer/lib/terminal/frame-snapshot';

/** A terminal element with a screen holding one canvas, and a render on request. */
function fakeTerm(opts: { canvas?: boolean; renders?: boolean } = {}) {
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  element.appendChild(screen);
  const canvas = document.createElement('canvas');
  if (opts.canvas !== false) screen.appendChild(canvas);
  let onRender: (() => void) | null = null;
  const term = {
    element,
    rows: 24,
    options: { theme: { background: '#101010' } },
    onRender: (cb: () => void) => {
      onRender = cb;
      return { dispose: () => (onRender = null) };
    },
    refresh: vi.fn(() => {
      // xterm renders on its next frame; the copy must happen in that render.
      if (opts.renders !== false) setTimeout(() => onRender?.(), 16);
    }),
  };
  return { term: term as unknown as Terminal, screen, canvas };
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

let drawImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('captureFrame', () => {
  it('gives up without a canvas to copy (the DOM renderer)', async () => {
    const { term } = fakeTerm({ canvas: false });
    await expect(captureFrame(term, document.createElement('div'))).resolves.toBeNull();
    expect(term.refresh).not.toHaveBeenCalled();
  });

  it('gives up when no render comes (a paused renderer)', async () => {
    const { term } = fakeTerm({ renders: false });
    const done = captureFrame(term, document.createElement('div'));
    await vi.advanceTimersByTimeAsync(50);
    await expect(done).resolves.toBeNull();
  });

  it('copies the screen inside the render it asked for and lays it over the terminal’s box, clipped', async () => {
    const { term, screen, canvas } = fakeTerm();
    // The slot (host, with its padding) holds the terminal's box, which holds xterm.
    const host = document.createElement('div');
    const box = document.createElement('div');
    host.appendChild(box);
    box.appendChild(term.element!);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(100, 50, 400, 300));
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(rect(108, 58, 384, 284));
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect(108, 58, 384, 280));
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(108, 58, 384, 280));

    const done = captureFrame(term, host);
    // Nothing is read before xterm has drawn: a WebGL canvas keeps no copy of
    // a frame once it has been shown.
    expect(drawImage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    const overlay = await done;

    expect(overlay).not.toBeNull();
    expect(drawImage).toHaveBeenCalledTimes(1);
    const clip = host.lastElementChild as HTMLElement;
    expect(clip.style.overflow).toBe('hidden');
    expect(clip.style.pointerEvents).toBe('none');
    // Clipped to the box, not the padded slot, and opaque in the terminal's
    // colour: nothing of the xterm being resized beneath shows around the copy.
    expect([clip.style.left, clip.style.top, clip.style.width, clip.style.height]).toEqual([
      '8px',
      '8px',
      '384px',
      '284px',
    ]);
    expect(clip.style.background).toBe('rgb(16, 16, 16)');
    const image = clip.firstElementChild as HTMLCanvasElement;
    expect(image.style.left).toBe('0px');
    expect(image.style.top).toBe('0px');
    expect(image.style.width).toBe('384px');
  });

  /** A copy laid over a 384×280 screen. */
  const capture = async () => {
    const made = fakeTerm();
    const host = document.createElement('div');
    vi.spyOn(made.screen, 'getBoundingClientRect').mockReturnValue(rect(108, 58, 384, 280));
    vi.spyOn(made.canvas, 'getBoundingClientRect').mockReturnValue(rect(108, 58, 384, 280));
    const done = captureFrame(made.term, host);
    await vi.advanceTimersByTimeAsync(16);
    return { ...made, host, overlay: await done };
  };

  it('cuts the copy away in the render that draws the frame beneath it - no fade', async () => {
    const { host, overlay } = await capture();
    const clip = host.lastElementChild as HTMLElement;
    const image = clip.firstElementChild as HTMLCanvasElement;
    const gone = vi.fn();

    overlay!.swapOut(gone);
    // Still up until xterm renders the frame beneath, and never half-transparent.
    expect(host.contains(clip)).toBe(true);
    expect(image.style.opacity).toBe('');
    expect(image.style.transition).toBe('');
    await vi.advanceTimersByTimeAsync(16);
    expect(host.contains(clip)).toBe(false);
    expect(gone).toHaveBeenCalledOnce();
  });

  it('cuts the copy away anyway when no render comes', async () => {
    const { term, host, overlay } = await capture();
    const clip = host.lastElementChild as HTMLElement;
    vi.mocked(term.refresh).mockImplementation(() => undefined);

    overlay!.swapOut();
    await vi.advanceTimersByTimeAsync(99);
    expect(host.contains(clip)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.contains(clip)).toBe(false);
  });
});
