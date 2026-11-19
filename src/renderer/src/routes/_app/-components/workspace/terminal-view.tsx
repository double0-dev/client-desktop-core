import { useContext, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { cn } from '@renderer/lib/utils';
import {
  acquireTerminal,
  attachWebglRenderer,
  disposePooledTerminal,
  getPooledTerminal,
  installAdaptiveSmoothScroll,
  installPasteOverride,
  reconcileTerminalGrid,
  releaseWebglRenderer,
  type PooledTerminal,
} from '@renderer/lib/terminal/pool';
import { takeOneShotCommand } from '@renderer/lib/session/setup';
import {
  noteTerminalUserInput,
  suppressTerminalActivity,
} from '@renderer/lib/terminal/activity-gate';
import { createTerminalRestyler } from '@renderer/lib/terminal/restyle';
import { noteInputKeys } from '@renderer/lib/terminal/inputs';
import { awaitRepaint, holdFrame } from '@renderer/lib/terminal/frame-hold';
import { captureFrame } from '@renderer/lib/terminal/frame-snapshot';
import { getTerminalSettings } from '@renderer/lib/settings/terminal-settings';
import { isSurfaceFocusHeld } from '@renderer/lib/workspace/focus-regions';
import { useTerminalFind } from '@renderer/lib/terminal/find';
import { setFileLinkContext } from '@renderer/lib/terminal/file-links';
import { requestEditorReveal } from '@renderer/lib/workspace/editor-reveal';
import { WorkspaceLayoutContext } from '@renderer/lib/workspace/layout-context';
import { TerminalFindBar } from '@renderer/routes/_app/-components/workspace/terminal-find-bar';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import {
  noteTerminalViewMounted,
  useReattachGeneration,
  useTerminalUnreachable,
} from '@renderer/lib/session/unreachable';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { isWindows } from '@renderer/lib/settings/keyboard-shortcuts';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import {
  EXPLORER_DRAG_MIME,
  acceptsTerminalDrag,
  droppedPathsText,
  terminalDragKind,
  terminalDropPaths,
} from '@renderer/lib/terminal/file-drop';
import {
  claimOnInteraction,
  holdFollowedGrid,
  resizePty,
} from '@renderer/lib/terminal/shared-grid';

/**
 * Backpressure watermarks (UTF-16 units ≈ bytes for typical output). xterm
 * buffers `write()` data without bound, so a shell blasting output (`cat` on a
 * big file) would balloon memory and freeze the UI. Past HIGH we pause the PTY
 * in main - the shell blocks on its own stdout - and resume once xterm has
 * parsed back down to LOW.
 */
const FLOW_HIGH_WATERMARK = 512 * 1024;
const FLOW_LOW_WATERMARK = 128 * 1024;

/**
 * How long a pane must hold still before a plain shell's PTY learns the new
 * size. A divider or window drag fires a resize every pointer frame; what
 * follows the pane during it depends on the screen:
 * - a plain shell (normal buffer) reflows live - the xterm refits every frame,
 *   its scrollback rewrapping to the pane - and its PTY gets ONE SIGWINCH once
 *   the size has held still this long, so the prompt isn't redrawn per frame;
 * - a full-screen TUI (alternate buffer) can't be rewrapped - its screen is
 *   the program's to draw - so it is resized for real all through the drag,
 *   one step at a time: each step holds the current frame, SIGWINCHes the
 *   program and shows its repaint whole once it has landed, and the next step
 *   starts only then (see resizeTui in TerminalView). It tracks the pane as
 *   fast as the program can redraw, never strobing its clear+redraw - which
 *   is what a SIGWINCH per pointer frame used to do.
 *
 * The first resize after a quiet spell refits at once - a one-shot change (a
 * panel or dock toggle, fullscreen) never waits.
 */
const FIT_SETTLE_MS = 150;

/**
 * Fit a pooled xterm to its laid-out container and push that grid to the PTY.
 * No-op (false) for a container without a size - a hidden tab, or a pane whose
 * rect hasn't been measured yet. The resize SIGWINCHes the shell → a TUI
 * repaints; that repaint is our doing (a reveal / pane resize), not the agent
 * working, so it's gated out of session-status.
 */
function fitToContainer(
  ptyId: string,
  pooled: PooledTerminal,
  container: HTMLElement,
  opts: {
    holdRepaint?: boolean;
    /** Leave the PTY alone when the grid didn't change (a drag's in-cell frames). */
    skipUnchanged?: boolean;
    /** Called once the resize is done - for a held one, once the hold lifts. */
    onSettled?: () => void;
  } = {},
): boolean {
  if (container.clientWidth === 0 || container.clientHeight === 0) {
    opts.onSettled?.();
    return false;
  }
  const { term } = pooled;
  // Another computer sizes this terminal (a shared host): hold its grid, send
  // nothing - only a claim refits to the pane (shared-grid.ts).
  if (holdFollowedGrid(ptyId, term)) {
    opts.onSettled?.();
    return true;
  }
  // A pane resize under a full-screen TUI (holdRepaint - never the mount /
  // create path, whose PTY resize must go out before `create` so an adopt
  // replays at the fitted grid) is swapped in whole - see heldResize.
  if (opts.holdRepaint && isAltScreen(term)) {
    const next = pooled.fit.proposeDimensions();
    if (next && (next.cols !== term.cols || next.rows !== term.rows)) {
      void heldResize(ptyId, pooled, container, opts.onSettled);
      return true;
    }
  }
  const before = { cols: term.cols, rows: term.rows };
  try {
    pooled.fit.fit();
  } catch {
    // Element may be detached mid-layout.
  }
  const changed = term.cols !== before.cols || term.rows !== before.rows;
  if (!changed && opts.skipUnchanged) {
    opts.onSettled?.();
    return true;
  }
  suppressTerminalActivity(ptyId);
  resizePty(ptyId, term.cols, term.rows);
  opts.onSettled?.();
  return true;
}

/**
 * Resize a full-screen TUI so the user sees its last whole frame and then its
 * next one, nothing between. The program answers the SIGWINCH by clearing and
 * redrawing, and until then xterm can only show the old screen clipped or
 * padded to the new size (diff rows' full-width backgrounds jumping short and
 * back). So: freeze the current frame as an image over the terminal
 * (captureFrame), refit and SIGWINCH under a frame hold, and once the repaint
 * has landed, lift the hold and fade the image into the new frame.
 *
 * Without an image (no canvas to copy) the old screen at the new size shows
 * while the program repaints - drawn first, then held, so the clear never
 * shows. Settled (`onSettled`) once the repaint is on screen: the lift parsed,
 * then the frame xterm draws it in - a refit before that would clear the
 * canvas under a still-active hold and blank it until the next lift.
 */
async function heldResize(
  ptyId: string,
  pooled: PooledTerminal,
  container: HTMLElement,
  onSettled?: () => void,
): Promise<void> {
  const { term } = pooled;
  const host = container.parentElement;
  const overlay = host ? await captureFrame(term, host) : null;
  if (!overlay) {
    // A refit inside a frame callback blanks the canvas for a frame - leave
    // the one the capture attempt may have run in.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (container.clientWidth === 0 || container.clientHeight === 0) {
    clearTuiAnchor(term, container);
    overlay?.swapOut();
    onSettled?.();
    return;
  }
  try {
    pooled.fit.fit();
  } catch {
    // Element may be detached mid-layout.
  }
  // The refit grid starts at the box's top: the shifted old frame is done -
  // the copy (if any) shows it from here.
  clearTuiAnchor(term, container);
  if (!overlay) await new Promise((resolve) => requestAnimationFrame(resolve));
  const hold = holdFrame(term);
  // The hold is a write of our own: let it parse before the resize, so the
  // repaint wait below hears the PROGRAM's answer, not our hold. Counted from
  // our write, a program slower than the quiet window (40 ms) had its
  // half-drawn screen shown - the very state the copy is there to hide.
  await new Promise<void>((resolve) => term.write('', resolve));
  suppressTerminalActivity(ptyId);
  resizePty(ptyId, term.cols, term.rows);
  await awaitRepaint(term);
  hold.release(() => {
    // The copy leaves in the frame xterm draws the repaint in - a cut, not a
    // crossfade (two layouts of the same text faded together read doubled).
    if (overlay) overlay.swapOut(() => setTimeout(() => onSettled?.(), 0));
    else requestAnimationFrame(() => setTimeout(() => onSettled?.(), 0));
  });
}

/**
 * A full-screen agent TUI draws from the bottom (input box, status line), so
 * when its pane changes height the old frame is moved to sit on the new
 * bottom edge until the program has repainted - instead of being clipped
 * there (the input box vanishes when a dock opens) or left with a gap under it.
 * Runs in the ResizeObserver callback, before the browser paints the new
 * layout; the held resize lifts it once the xterm is refit (heldResize). Only
 * the box clips while it is shifted - the slot's padding stays clear.
 */
function anchorTuiFrame(pooled: PooledTerminal, container: HTMLElement): void {
  const { term } = pooled;
  const el = term.element;
  if (!el || !isAltScreen(term) || term.rows === 0) return;
  const next = pooled.fit.proposeDimensions();
  const screen = el.querySelector<HTMLElement>('.xterm-screen');
  if (!next || !screen) return;
  const dy = Math.round(((next.rows - term.rows) * screen.offsetHeight) / term.rows);
  el.style.transform = dy ? `translateY(${dy}px)` : '';
  container.style.clipPath = dy ? 'inset(0)' : '';
}

function clearTuiAnchor(term: PooledTerminal['term'], container: HTMLElement): void {
  if (term.element) term.element.style.transform = '';
  container.style.clipPath = '';
}

/** Refit the xterm alone, leaving the PTY on its grid - see FIT_SETTLE_MS. */
function reflowToContainer(pooled: PooledTerminal, container: HTMLElement, ptyId?: string): void {
  if (container.clientWidth === 0 || container.clientHeight === 0) return;
  if (ptyId && holdFollowedGrid(ptyId, pooled.term)) return;
  try {
    pooled.fit.fit();
  } catch {
    // Element may be detached mid-layout.
  }
}

function isAltScreen(term: PooledTerminal['term']): boolean {
  return term.buffer.active.type === 'alternate';
}

/**
 * Displays a single live terminal bound to a stable `ptyId`.
 *
 * The xterm instance and its PTY are owned by the module-level pool (see
 * `terminal-pool.ts`), NOT this component's mount. The view/IO wiring is keyed
 * ONLY on `[ptyId, hasBridge]` so a changing `cwd` can never tear down a live
 * shell's input/output listeners (which would freeze it). The shell is spawned
 * by a separate effect once the working dir is known; `create` is idempotent in
 * main, so re-running it is harmless.
 *
 * The durable shell is killed only via `disposePooledTerminal` from the tab-close
 * path - so splits, moves, and StrictMode's dev remount never kill it.
 */
export function TerminalView({
  ptyId,
  cwd,
  active = true,
  className,
  initialCommand,
}: {
  /** Stable PTY id, owned by the tab model. */
  ptyId: string;
  /** Working directory; `null` = home, `undefined` = not resolved yet (wait). */
  cwd?: string | null;
  /** Whether this terminal's tab is the active one in its (active) pane. */
  active?: boolean;
  className?: string;
  /** Command to auto-run once when this terminal's shell first spawns (e.g. `claude`). */
  initialCommand?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const findRequest = useTerminalFind(ptyId);
  // File links open in THIS view's workspace (its window), resolved against the
  // terminal's folder. No workspace (none mounted around it) = no file links.
  const workspace = useContext(WorkspaceLayoutContext);
  const openFile = workspace?.openFile;
  const openBrowser = workspace?.openBrowser;
  const layoutRef = useRef(workspace?.layout);
  // The server chip is the browser's (Pro, a private plan › M5).
  const ServerChip = rendererExtension().browser?.TerminalChip;
  layoutRef.current = workspace?.layout;
  useEffect(() => {
    if (!openFile || cwd === undefined) return;
    return setFileLinkContext(ptyId, {
      cwd,
      open: (path, position) => {
        if (position) requestEditorReveal(path, position);
        openFile(path);
      },
      openUrl:
        openBrowser &&
        ((url) =>
          rendererExtension().browser?.openPreviewBeside(
            openBrowser,
            layoutRef.current,
            ptyId,
            url,
          )),
    });
  }, [ptyId, cwd, openFile, openBrowser]);
  // Dev servers this terminal announces (the chip, the hold-+ menu). A
  // terminal on a remote host announces its servers' local forwards (main ›
  // hosts/port-forward.ts), so every surface opens a URL this machine reaches.
  useEffect(() => {
    rendererExtension().browser?.trackServers([ptyId]);
  }, [ptyId]);
  // The PTY bridge only exists in the Electron renderer (preload). In a plain
  // browser (dev at localhost) fall back to a notice instead of crashing.
  const hasBridge = typeof window !== 'undefined' && !!window.api?.terminal;
  const ready = cwd !== undefined;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Read inside the spawn effect without making it a dependency - the command is
  // stable per tab, and main ignores it on re-create anyway.
  const initialCommandRef = useRef(initialCommand);
  initialCommandRef.current = initialCommand;
  // Read the latest `active` inside the long-lived ResizeObserver closure.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Remote terminals (a private plan › 9.4): the host's
  // state, and a generation bumped when it comes back - the IO effect then
  // rebuilds the xterm so the next create replays what it missed.
  const unreachable = useTerminalUnreachable(ptyId);
  const generation = useReattachGeneration(ptyId);
  const attachedGeneration = useRef(generation);
  const hostLabel = useHosts().find((h) => h.id === unreachable?.hostId)?.label ?? 'The server';
  useEffect(() => noteTerminalViewMounted(ptyId), [ptyId]);

  // View + IO wiring. Keyed only on [ptyId, hasBridge] - NOT cwd/ready - so a
  // flickering working dir can never dispose the input/output listeners and
  // freeze a live shell.
  useEffect(() => {
    if (!hasBridge) return;
    const container = containerRef.current;
    if (!container) return;

    const api = window.api!.terminal;
    // Back from unreachable: this xterm missed output - a fresh one replays.
    if (attachedGeneration.current !== generation) {
      attachedGeneration.current = generation;
      disposePooledTerminal(ptyId, false);
    }
    const pooled = acquireTerminal(ptyId);
    const { term } = pooled;

    // Attach (or reparent) the durable xterm DOM into this mount's container.
    if (!pooled.opened) {
      term.open(container);
      pooled.opened = true;
      // Element exists only after open(); wire device-adaptive smooth scrolling
      // (trackpad tracks 1:1, wheel mouse glides) onto it once.
      installAdaptiveSmoothScroll(pooled);
      // An image pasted on Windows reaches the agent as its image-paste key.
      installPasteOverride(ptyId, pooled);
    } else if (term.element && term.element.parentElement !== container) {
      container.appendChild(term.element);
    }

    // Only fit/focus when actually on-screen with a real size. A pane that was
    // just split off renders at 0×0 until its rect is measured; treating that as
    // "not visible" keeps us from collapsing the shell or focusing a hidden node.
    const isVisible = (): boolean => container.clientWidth > 0 && container.clientHeight > 0;
    const applyFit = (): void => {
      fitToContainer(ptyId, pooled, container);
    };
    // A pane resize: a full-screen TUI's repaint is swapped in whole.
    const applyResizeFit = (): void => {
      fitToContainer(ptyId, pooled, container, { holdRepaint: true });
    };
    // A full-screen TUI follows a drag one held resize at a time: while one
    // repaint is in flight, later frames only mark the size dirty, and the
    // latest size goes out when it lands (see FIT_SETTLE_MS). Starting a step
    // per pointer frame instead would keep the frame held for the whole drag.
    let tuiResizing = false;
    let tuiDirty = false;
    const resizeTui = (): void => {
      if (tuiResizing) {
        tuiDirty = true;
        return;
      }
      tuiResizing = true;
      tuiDirty = false;
      fitToContainer(ptyId, pooled, container, {
        holdRepaint: true,
        skipUnchanged: true,
        onSettled: () => {
          tuiResizing = false;
          if (tuiDirty && !disposed) resizeTui();
        },
      });
    };
    let disposed = false;

    let pendingWriteChars = 0;
    let flowPaused = false;
    // Rewrites Claude Code's dark-theme truecolor styling (user bar, code
    // colors, diff backgrounds) for light themes (see terminal-restyle).
    // Covers live output AND main's adoption replay - both
    // arrive through this listener. May hold back a chunk-final partial escape
    // sequence, so flow accounting uses the transformed length.
    const restyle = createTerminalRestyler();
    const offData = api.onData(ptyId, (raw, replaySize) => {
      // A scrollback replay from re-adopting a live shell carries the PTY's grid
      // at adopt time. A HIDDEN tab's fresh xterm (still at the construction
      // default 80×24 - fit can't run without a laid-out container) is sized to
      // it before the write, or the replay renders garbled; its reveal refits.
      // A tab that is already laid out keeps its fitted grid: the PTY has been
      // (or is being) resized to it, so the program's repaint for THAT grid is
      // on its way behind the replay - sizing the xterm back to the adopt-time
      // grid would parse that repaint on the wrong grid, and the refit after
      // the replay would then leave it garbled for good (the grids agree, so
      // nothing ever repaints again). `parsedAt` records the grid the replay
      // is parsed on, for the repaint check once it has rendered. Also gate
      // the burst out of session-status: it's our re-attach, not the agent
      // working.
      let parsedAt: { cols: number; rows: number } | undefined;
      if (replaySize) {
        suppressTerminalActivity(ptyId);
        const { cols, rows } = replaySize;
        if (cols > 0 && rows > 0 && !isVisible() && (term.cols !== cols || term.rows !== rows)) {
          try {
            term.resize(cols, rows);
          } catch {
            // Disposed mid-adopt - the exit path cleans up.
          }
        }
        parsedAt = { cols: term.cols, rows: term.rows };
      }
      const data = restyle(raw);
      if (!data) {
        // An empty replay (fresh shell, no scrollback yet) still needs the grid
        // reconciled - the xterm may just have been sized to the PTY's
        // adopt-time grid, which a refit that landed while the replay was in
        // flight may have already superseded.
        if (parsedAt) reconcileTerminalGrid(ptyId, { repaintFrom: parsedAt });
        return;
      }
      pendingWriteChars += data.length;
      if (!flowPaused && pendingWriteChars > FLOW_HIGH_WATERMARK) {
        flowPaused = true;
        api.pause(ptyId);
      }
      try {
        term.write(data, () => {
          pendingWriteChars -= data.length;
          if (flowPaused && pendingWriteChars <= FLOW_LOW_WATERMARK) {
            flowPaused = false;
            api.resume(ptyId);
          }
          // The replay has rendered: refit to the container, and if that is a
          // different grid from the one the replay was parsed on, make the
          // program repaint for it (see reconcileTerminalGrid).
          if (parsedAt) reconcileTerminalGrid(ptyId, { repaintFrom: parsedAt });
        });
      } catch {
        // Term may have been disposed between a kill and this mount's cleanup.
      }
    });
    const offExit = api.onExit(ptyId, (code) => {
      try {
        term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
      } catch {
        // Ignore writes to a disposed terminal.
      }
    });
    // Any refit that changes the grid (a reveal, a plain shell, the pool's
    // reconcile) lays the xterm out from the top again - a bottom-anchored
    // frame (anchorTuiFrame) never outlives it.
    const anchorSub = term.onResize(() => clearTuiAnchor(term, container));
    const inputSub = term.onData((data) => {
      // Typed into a terminal another computer was sizing (a shared remote
      // host): it is this window's again - refit to the pane, as a claim.
      claimOnInteraction(ptyId, data, applyFit);
      // Feed the commit-keystroke tracker (Enter/digit/Esc = the user answering
      // a blocked agent) so session-status knows when a needs-input verdict may
      // clear - see terminal-activity-gate.
      noteTerminalUserInput(ptyId, data);
      // The Inputs list reads a line off the screen at Enter - before the
      // keystroke reaches the program, which may clear or redraw that line.
      noteInputKeys(ptyId, term, data);
      api.write(ptyId, data);
    });

    // Focus on the hidden→visible edge: the moment a (just-split or just-shown)
    // active terminal gains a real size, move the caret in. The WebGL renderer
    // rides the same edges - attached only while visible, so 10+ pooled
    // terminals never exhaust Chromium's WebGL context cap (see terminal-pool).
    let wasVisible = isVisible();
    if (wasVisible) {
      attachWebglRenderer(pooled);
      applyFit();
      if (activeRef.current && !isSurfaceFocusHeld()) term.focus();
    }

    // Focusing the terminal sends a focus report (`ESC[I`) to a TUI that tracks
    // focus, which it may answer with a redraw - again our doing, not the agent
    // working. Gate that output too, covering both our own term.focus() and the
    // user clicking straight into the terminal (xterm focuses on mousedown).
    const onFocusIn = (): void => suppressTerminalActivity(ptyId);
    container.addEventListener('focusin', onFocusIn);
    // A click into the terminal is the user too (spec 14): the next refit
    // claims the grid on a host another computer shares.
    const onPointerDown = (): void => claimOnInteraction(ptyId, null, applyFit);
    container.addEventListener('mousedown', onPointerDown);

    // Switching macOS apps blurs/refocuses the window: xterm sends focus-out /
    // focus-in reports (`ESC[O`/`ESC[I`) to the pty, and a TUI that tracks
    // focus (Claude Code dims its input box) answers each with a redraw. That's
    // the window manager's doing, not the agent working - gate it like our own
    // focus/resize so an app switch can't flip a waiting session's status.
    const onWindowBlur = (): void => suppressTerminalActivity(ptyId);
    const onWindowFocus = (): void => {
      suppressTerminalActivity(ptyId);
      // Coming back to the app is when a diverged grid gets noticed ("the input
      // box is broken again"), and nothing else refits at that edge - verify
      // that the xterm and its shell still agree (see reconcileTerminalGrid).
      reconcileTerminalGrid(ptyId);
    };
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('blur', onWindowBlur);

    // Resizes are coalesced into one pass per burst - run as a task, never in
    // a frame callback: a refit resizes xterm's canvas, which clears it, and
    // xterm redraws on its next animation frame. From a task that frame comes
    // before the browser paints; from inside a frame (a rAF or ResizeObserver
    // callback) the paint lands first and shows the cleared canvas - a blink
    // per refit, every frame of a drag.
    let pass: ReturnType<typeof setTimeout> | undefined;
    let fitSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastResizeAt = 0;
    const resizeObserver = new ResizeObserver(() => {
      // A visible TUI's old frame moves to the new bottom edge in this very
      // frame; the refit (in the pass below, after the paint) follows.
      if (wasVisible && isVisible()) anchorTuiFrame(pooled, container);
      else clearTuiAnchor(term, container);
      clearTimeout(pass);
      pass = setTimeout(() => {
        const visibleNow = isVisible();
        // Hiding RELEASES the renderer (keeps its canvas + last frame) rather
        // than detaching it: the retained bitmap is what paints the reveal
        // frame when this tab comes back, instead of a blank-background blink
        // while xterm's paused render service catches up. The pool's LRU cap
        // reclaims GPU contexts when too many terminals hold one.
        if (visibleNow && !wasVisible) attachWebglRenderer(pooled);
        else if (!visibleNow && wasVisible) releaseWebglRenderer(pooled);
        // A hidden↔shown edge refits NOW - a revealed tab must not sit on a
        // stale grid for even a beat - and so does the first resize after a
        // quiet spell (a panel toggle, the start of a drag). Within a run of
        // resizes the PTY waits for the size to settle, so a drag delivers one
        // SIGWINCH instead of a clear+redraw strobe per pointer frame, while a
        // plain shell's xterm reflows live (see FIT_SETTLE_MS).
        clearTimeout(fitSettleTimer);
        const now = performance.now();
        const quiet = now - lastResizeAt > FIT_SETTLE_MS;
        lastResizeAt = now;
        if (visibleNow !== wasVisible) applyFit();
        else if (visibleNow && isAltScreen(term)) resizeTui();
        else if (visibleNow && quiet) applyResizeFit();
        else {
          if (visibleNow) reflowToContainer(pooled, container, ptyId);
          fitSettleTimer = setTimeout(applyResizeFit, FIT_SETTLE_MS);
        }
        if (visibleNow && !wasVisible) {
          if (activeRef.current && !isSurfaceFocusHeld()) term.focus();
          // A tab that was hidden could have missed a push (its shell was still
          // spawning, or it changed hands) - the refit above only fixes that if
          // the grid it lands on differs from the xterm's. Verify against the
          // PTY itself now that this tab is on screen again.
          reconcileTerminalGrid(ptyId);
        }
        wasVisible = visibleNow;
      });
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      clearTimeout(pass);
      clearTimeout(fitSettleTimer);
      resizeObserver.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('blur', onWindowBlur);
      inputSub.dispose();
      anchorSub.dispose();
      clearTuiAnchor(term, container);
      offData();
      offExit();
      // This mount's data listener is gone, so its write queue will never drain
      // an un-pause - release the PTY for whoever re-attaches.
      if (flowPaused) api.resume(ptyId);
      // Release (not detach) on unmount: keeping the addon preserves the last
      // frame across remounts (layout moves, session switches, StrictMode), so
      // the terminal reappears with content instead of blinking. The pool's
      // LRU cap bounds how many GPU contexts unmounted terminals can pin.
      releaseWebglRenderer(pooled);
      // Durable xterm + PTY are intentionally left alive (see terminal-pool.ts).
    };
  }, [ptyId, hasBridge, generation]);

  // Spawn the shell once the working dir is resolved. Idempotent in main (no-op
  // if the id already exists), so a cwd change just re-calls it harmlessly - it
  // never disposes a running shell.
  useEffect(() => {
    if (!hasBridge || !ready) return;
    const api = window.api!.terminal;
    const send = (): void => {
      const pooled = getPooledTerminal(ptyId);
      const term = pooled?.term;
      // A brand-new xterm may be re-attaching to a shell that's already running
      // (session revisited after eviction, page reload): mark the shell so the
      // create below takes the adopt path and replays its scrollback - without
      // this, a same-window create skips the replay and the tab comes back blank
      // (or garbles as live TUI output lands on an empty screen). One-shot per
      // pooled xterm; main ignores the mark when the id doesn't exist yet.
      if (pooled?.needsReplayRequest) {
        pooled.needsReplayRequest = false;
        api.requestReplay(ptyId);
      }
      api.create({
        id: ptyId,
        cwd: cwdRef.current ?? null,
        cols: term?.cols ?? 80,
        rows: term?.rows ?? 24,
        // A worktree setup tab's one-shot command (run once on first spawn) takes
        // precedence; it lives only in memory, so a relaunch falls back to the
        // tab's own startup command (none, for a plain setup shell).
        initialCommand: takeOneShotCommand(ptyId) ?? initialCommandRef.current,
        // Main reads it at spawn only; an adopt ignores it.
        shellIntegration: getTerminalSettings().shellIntegration,
      });
    };
    // A slot that hasn't been measured yet - a window or pane on its first
    // commit paints its terminals at 0×0 until the pane rects land - would hand
    // main the xterm's construction-default grid, and an adopt would then
    // replay (and jiggle the shell) at the wrong size. Wait a frame: the rects
    // are in by then, so the slot can be fitted and the PTY told first. A tab
    // that is genuinely hidden is still 0×0 then and creates as before.
    const container = containerRef.current;
    if (container && container.clientWidth === 0 && container.clientHeight === 0) {
      const raf = requestAnimationFrame(() => {
        const pooled = getPooledTerminal(ptyId);
        const now = containerRef.current;
        if (pooled && now) fitToContainer(ptyId, pooled, now);
        send();
      });
      return () => cancelAnimationFrame(raf);
    }
    send();
    return undefined;
  }, [ptyId, hasBridge, ready, generation]);

  // Focus when this becomes the active tab and is already visible (tab/pane
  // switch). Hidden→visible is handled by the ResizeObserver above.
  useEffect(() => {
    if (!active || !hasBridge) return;
    const pooled = getPooledTerminal(ptyId);
    if (!pooled) return;
    // Defer a frame so a just-revealed (display:none→block) terminal has been
    // laid out; refit (it may have been 0×0 while hidden) THEN focus. Focusing an
    // xterm mid-reveal makes it blur itself, so we wait for it to settle.
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
      // If the caret is already inside this terminal (e.g. the user just clicked
      // into it, and xterm focused itself on mousedown), leave it alone -
      // re-asserting focus + refit on an already-focused xterm is what makes it
      // blur itself. Only drive focus when it isn't here yet (tab/pane switch).
      const el = pooled.term.element;
      if (el && el.contains(document.activeElement)) return;
      // Refit through the reconcile, never a bare fit: a fit that changes the
      // grid without telling main leaves the shell drawing at the old size for
      // good (nothing refits again - the container's size didn't change).
      reconcileTerminalGrid(ptyId);
      // A sidebar region is being keyboard-navigated (the session/tab was
      // picked with ↑/↓ there): the refit still happens, but the caret stays
      // in the sidebar - see lib/workspace/focus-regions.ts.
      if (isSurfaceFocusHeld()) return;
      pooled.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, ptyId, hasBridge]);

  // Files dropped onto the terminal (explorer rows or the OS's file manager)
  // type their paths at the cursor, as a paste. The host is the terminal's
  // folder's: a host's shell takes the host explorer's paths only.
  const [dropping, setDropping] = useState(false);
  const terminalHost = (): string | null => (cwd ? currentHostOfPath(cwd) : null);
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!acceptsTerminalDrag(terminalDragKind(e.dataTransfer?.types), terminalHost())) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setDropping(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    setDropping(false);
    const host = terminalHost();
    if (!acceptsTerminalDrag(terminalDragKind(e.dataTransfer?.types), host)) return;
    e.preventDefault();
    const pathOf = window.api?.files?.pathOf;
    const paths = terminalDropPaths(
      {
        explorer: e.dataTransfer.getData(EXPLORER_DRAG_MIME),
        osPaths: pathOf ? Array.from(e.dataTransfer.files, (f) => pathOf(f)) : [],
      },
      host,
    );
    const pooled = getPooledTerminal(ptyId);
    if (!paths || !pooled) return;
    // A host's shell is POSIX whatever this computer runs.
    const text = droppedPathsText(paths, isWindows && host === null ? 'windows' : 'posix');
    pooled.term.paste(text);
    pooled.term.focus();
  };

  if (!hasBridge) {
    return (
      <div
        className={cn(
          'flex items-center justify-center p-6 text-center font-mono text-xs text-foreground-muted',
          className,
        )}
      >
        Terminal runs in the double0 desktop app.
      </div>
    );
  }

  // The xterm attaches to the inner element; the wrapper carries the find bar
  // over it (absolutely placed, so it never changes the terminal's grid).
  return (
    <div
      className={cn('relative', className)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div ref={containerRef} className="size-full" />
      {dropping && (
        <div
          data-testid="terminal-drop-target"
          className="pointer-events-none absolute inset-0 z-10 rounded-sm bg-primary/10 ring-2 ring-inset ring-primary"
        />
      )}
      {unreachable && (
        <div
          data-testid="terminal-unreachable"
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/60"
        >
          <span className="rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-muted shadow-sm">
            {hostLabel} is unreachable - reconnecting…
          </span>
        </div>
      )}
      {findRequest && <TerminalFindBar ptyId={ptyId} request={findRequest} />}
      {!findRequest && openBrowser && ServerChip && (
        <SlotBoundary name="terminal-chip">
          <ServerChip
            ptyId={ptyId}
            onOpen={(url) =>
              rendererExtension().browser?.openPreviewBeside(
                openBrowser,
                layoutRef.current,
                ptyId,
                url,
              )
            }
          />
        </SlotBoundary>
      )}
    </div>
  );
}
