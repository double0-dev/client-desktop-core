import type { Terminal } from '@xterm/xterm';

/** A render that hasn't happened by then won't (a paused or hidden renderer). */
const CAPTURE_TIMEOUT_MS = 50;
/** The repaint's frame normally renders within one animation frame of the lift. */
const SWAP_TIMEOUT_MS = 100;

export type FrameOverlay = {
  /**
   * Drop the snapshot in the frame xterm draws the content under it: a cut,
   * never a crossfade - fading two different layouts of the same text into
   * each other shows both at once (rows doubled at different offsets).
   */
  swapOut: (onGone?: () => void) => void;
};

/**
 * Freeze what a terminal shows right now as an image laid over it, so the
 * xterm underneath can be resized and repainted out of sight - a full-screen
 * TUI's resize then shows its last whole frame and its next whole frame, never
 * the old screen clipped or padded to the new size in between (diff rows'
 * full-width backgrounds jumped short and back on every step of a drag).
 *
 * The WebGL canvas keeps no copy of its last frame once it has been shown, so
 * it is read in the same task it is drawn in: ask xterm for one render and copy
 * every canvas of its screen from its `onRender`. Resolves null when nothing
 * can be copied (no canvas - the DOM renderer - or no render in time); the
 * caller then resizes without a snapshot.
 *
 * `host` is the positioned element the terminal sits in; the image is clipped
 * to it, so a frame wider than a shrunk pane never paints over its neighbour.
 */
export function captureFrame(term: Terminal, host: HTMLElement): Promise<FrameOverlay | null> {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  const canvases = screen ? [...screen.querySelectorAll('canvas')] : [];
  if (!screen || canvases.length === 0) return Promise.resolve(null);
  const background = term.options.theme?.background ?? 'transparent';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (overlay: FrameOverlay | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      resolve(overlay);
    };
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
    const sub = term.onRender(() => finish(copyScreen(term, screen, canvases, host, background)));
    term.refresh(0, term.rows - 1);
  });
}

function copyScreen(
  term: Terminal,
  screen: HTMLElement,
  canvases: HTMLCanvasElement[],
  host: HTMLElement,
  background: string,
): FrameOverlay | null {
  const screenRect = screen.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  // The copy is clipped to the terminal's own box, not the padded slot: a
  // frame shifted to the pane's bottom edge (anchorTuiFrame) must not spill
  // into the padding above it.
  const boxRect = (term.element?.parentElement ?? host).getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const image = document.createElement('canvas');
  image.width = Math.round(screenRect.width * dpr);
  image.height = Math.round(screenRect.height * dpr);
  const ctx = image.getContext('2d');
  if (!ctx) return null;
  try {
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      ctx.drawImage(
        canvas,
        (rect.left - screenRect.left) * dpr,
        (rect.top - screenRect.top) * dpr,
        rect.width * dpr,
        rect.height * dpr,
      );
    }
  } catch {
    return null; // a lost context or a tainted canvas - resize without one
  }
  Object.assign(image.style, {
    position: 'absolute',
    left: `${screenRect.left - boxRect.left}px`,
    top: `${screenRect.top - boxRect.top}px`,
    width: `${screenRect.width}px`,
    height: `${screenRect.height}px`,
  });
  // Opaque in the terminal's own colour: where the copy doesn't reach (it may
  // be anchored to the bottom of a taller pane - anchorTuiFrame) nothing of
  // the xterm being resized underneath shows through.
  const clip = document.createElement('div');
  Object.assign(clip.style, {
    position: 'absolute',
    left: `${boxRect.left - hostRect.left}px`,
    top: `${boxRect.top - hostRect.top}px`,
    width: `${boxRect.width}px`,
    height: `${boxRect.height}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '1',
    background,
  });
  clip.appendChild(image);
  host.appendChild(clip);
  let swapping = false;
  return {
    swapOut: (onGone) => {
      if (swapping) return;
      swapping = true;
      let done = false;
      const remove = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.dispose();
        clip.remove();
        onGone?.();
      };
      // onRender runs inside xterm's animation frame, before the browser
      // paints it: the copy leaves in the very frame the new content arrives.
      const sub = term.onRender(remove);
      const timer = setTimeout(remove, SWAP_TIMEOUT_MS);
      term.refresh(0, term.rows - 1);
    },
  };
}
