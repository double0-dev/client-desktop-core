import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';

import { ghosttyRuntime, terminalEngine } from '@renderer/lib/terminal/engine';
import { GhosttyXterm, type GhosttyInner } from '@renderer/lib/terminal/ghostty/ghostty-xterm';

import { subscribeTheme } from '@renderer/lib/settings/theme';
import { suppressTerminalActivity } from '@renderer/lib/terminal/activity-gate';
import { attachInputTracking, forgetInputs } from '@renderer/lib/terminal/inputs';
import {
  closeTerminalFind,
  FIND_HIGHLIGHT_LIMIT,
  openTerminalFind,
} from '@renderer/lib/terminal/find';
import { createOsc8LinkHandler, createWebLinksAddon } from '@renderer/lib/terminal/links';
import { createFileLinkProvider, forgetTerminalCwd } from '@renderer/lib/terminal/file-links';
import {
  getKeymap,
  isLinux,
  isMac,
  isWindows,
  matchCombo,
} from '@renderer/lib/settings/keyboard-shortcuts';
import { terminalClipboardKey, terminalPasteOverride } from '@renderer/lib/terminal/clipboard-keys';
import { terminalLineEditSequence } from '@renderer/lib/terminal/line-edit-keys';
import { clearTerminal } from '@renderer/lib/terminal/clear';
import {
  getTerminalSettings,
  resolveTerminalFontCss,
  resolveTerminalTheme,
  subscribeTerminalSettings,
} from '@renderer/lib/settings/terminal-settings';
import { isDarkColor } from '@renderer/lib/utils';
import {
  followsOther,
  forgetSharedGrid,
  holdFollowedGrid,
  resizePty,
  startSharedGridFeed,
} from '@renderer/lib/terminal/shared-grid';

/**
 * Module-level pool of live xterm instances, keyed by stable `ptyId`.
 *
 * The xterm.js instance and its PTY are owned here, NOT by the React component
 * that displays them. That decoupling is what lets the split layout move a tab
 * between panes (and survive React StrictMode's dev remount) without tearing
 * down the shell: the `TerminalView` mount reparents the pooled DOM into its
 * container instead of recreating the terminal. A terminal lives until
 * `disposePooledTerminal(ptyId)` is called explicitly from the tab-close path.
 */

/** What the pool needs of a fit addon - xterm's, or the Ghostty engine's. */
export type TerminalFit = Pick<FitAddon, 'fit' | 'proposeDimensions'>;
/** What the find bar needs of a search addon - xterm's, or the Ghostty engine's. */
export type TerminalSearch = Pick<
  SearchAddon,
  'findNext' | 'findPrevious' | 'clearDecorations' | 'onDidChangeResults'
>;

export type PooledTerminal = {
  /**
   * xterm.js, or a Ghostty engine terminal behind the same API (Settings ›
   * Terminal › Renderer, lib/terminal/ghostty/ghostty-xterm.ts).
   */
  term: Terminal;
  fit: TerminalFit;
  /** Find in terminal (the find bar in TerminalView drives it). */
  search: TerminalSearch;
  /** A Ghostty engine terminal: it draws its own canvas - no WebGL renderer. */
  ghostty?: boolean;
  /** Whether term.open() has run yet (xterm can only attach to a container once). */
  opened: boolean;
  /**
   * Set at construction, consumed by the view's first spawn: a brand-new xterm
   * may be re-attaching to a shell that is ALREADY running (session revisited
   * after eviction, page reload) - the view then asks main to replay the
   * scrollback, since a same-window `create` otherwise skips it and the tab
   * would come back blank. See TerminalView's spawn effect.
   */
  needsReplayRequest?: boolean;
  /** Whether the device-adaptive wheel listener is installed (once per element). */
  adaptiveScroll?: boolean;
  /** Whether the Windows image-paste listener is installed (once per element). */
  pasteOverride?: boolean;
  /** GPU renderer; kept attached across hides so its last frame survives -
   * reclaimed by the LRU cap, not by visibility (see attachWebglRenderer). */
  webgl?: WebglAddon;
  /** Whether this terminal is currently on-screen (attach/release edges). */
  webglVisible?: boolean;
  /** LRU recency: when this terminal was last shown (monotonic tick). */
  webglStamp?: number;
};

const pool = new Map<string, PooledTerminal>();

// A terminal another computer sizes (a shared remote host, spec 14): main's
// word on its grid fits the pooled xterm, never the pty (shared-grid.ts).
startSharedGridFeed((ptyId) => pool.get(ptyId)?.term);

/**
 * Scroll-animation length for a discrete mouse-wheel notch (ms). Applied only to
 * line-delta (wheel-mouse) scrolls; trackpad/Magic Mouse scrolls run at 0 so
 * they track the fingers 1:1 - see `installAdaptiveSmoothScroll`.
 */
const WHEEL_SMOOTH_SCROLL_MS = 120;

/**
 * How long to wait after a wake/unlock before handing terminals a fresh WebGL
 * context. At the wake event itself the GPU process may still be re-initializing,
 * so a context created then paints solid black; the DOM renderer covers the gap
 * until the GPU is really back (see redrawAllTerminals).
 */
const WEBGL_REATTACH_AFTER_WAKE_MS = 500;

/**
 * How long after a wake/unlock before every terminal's glyph texture atlas is
 * cleared and re-rasterized. The atlas built at the re-attach point
 * (WEBGL_REATTACH_AFTER_WAKE_MS) can rasterize/upload while the GPU is still
 * re-initializing - the pages land blank with no error and no context-loss
 * event, and the atlas's cache map then claims every glyph is drawn, so
 * terminals paint background + cursor only (white in light mode, black in
 * dark) until some new output happens to add an uncached glyph. By this much
 * later the GPU is really back, so a forced re-rasterization sticks.
 */
const ATLAS_RECLEAR_AFTER_WAKE_MS = 3000;

/**
 * How long the PTY sits one row short during a tone-flip repaint jiggle before
 * its real size is restored. Long enough that the TUI observes two distinct
 * SIGWINCHes - Node (and thus Claude Code) only emits a resize event when the
 * queried size actually changed, so a coalesced shrink+restore would go
 * entirely unseen and nothing would repaint.
 */
const TONE_FLIP_JIGGLE_MS = 80;

/** Tone of the current terminal theme - pinned when the first terminal spawns. */
let lastToneDark: boolean | undefined;
/** The tone last reported to main (`terminal:setTone`); avoids repeat pushes. */
let reportedToneDark: boolean | undefined;

/**
 * Tell main the current terminal tone so it can nudge every program that reads
 * light/dark (DECSET 2031, e.g. Claude Code under theme "auto") to re-detect -
 * the flip case xterm.js can't deliver. Sent once at startup (so main pushes
 * the right tone on adopt) and on every flip, never on an unrelated settings
 * change.
 */
function reportTone(dark: boolean): void {
  if (dark === reportedToneDark) return;
  reportedToneDark = dark;
  window.api?.terminal.setTone?.(dark);
}

/**
 * Windows' text pointer is an inverting cursor, and over xterm's GPU canvas on
 * a light terminal it vanished (2026-10-29). `data-terminal-light-pointer` on
 * `<html>` swaps in an outlined I-beam of our own (globals.css). Windows only:
 * the macOS / Linux I-beams stay visible on a light background.
 */
function markLightTerminalPointer(dark: boolean): void {
  if (!isWindows || typeof document === 'undefined') return;
  document.documentElement.toggleAttribute('data-terminal-light-pointer', !dark);
}

/**
 * Repaint every TUI when the terminal theme crosses dark↔light. Re-tinting
 * xterm's `ITheme` recolors palette-indexed cells instantly, but truecolor
 * styling (Claude Code's user bar / code colors - see terminal-restyle) is
 * baked into cells at write time and only changes when the program re-emits
 * it. A theme flip is invisible to a PTY, so those cells kept the old mode's
 * colors until the next output. Jiggling the PTY size (rows−1, then back)
 * delivers a SIGWINCH pair that makes full-screen TUIs redraw every visible
 * row - and the redraw streams through the restyler in the new mode. The
 * restore reads live xterm dims, so a pane resize landing mid-jiggle wins.
 * Suppressed from session-status like every other induced redraw.
 *
 * A cross-tone flip is ALSO reported to main (`reportTone`), which pushes the
 * colour-scheme notification to Claude Code and the like so they switch palette
 * rather than repaint the stale one - the jiggle alone makes them redraw, but in
 * the tone they still believe they are in.
 */
function repaintTuisOnToneFlip(themeBackground: string | undefined): void {
  const dark = isDarkColor(themeBackground ?? '#0d0d0d');
  const flipped = lastToneDark !== undefined && dark !== lastToneDark;
  lastToneDark = dark;
  reportTone(dark);
  markLightTerminalPointer(dark);
  if (!flipped) return;
  // A terminal another computer sizes is never jiggled from here: its rows-1
  // step would reach the shared pty (shared-grid.ts).
  for (const [ptyId, pooled] of pool) {
    if (!pooled.opened || followsOther(ptyId)) continue;
    suppressTerminalActivity(ptyId);
    resizePty(ptyId, pooled.term.cols, Math.max(1, pooled.term.rows - 1));
  }
  setTimeout(() => {
    for (const [ptyId, pooled] of pool) {
      if (!pooled.opened || followsOther(ptyId)) continue;
      suppressTerminalActivity(ptyId);
      resizePty(ptyId, pooled.term.cols, pooled.term.rows);
    }
  }, TONE_FLIP_JIGGLE_MS);
}

// Re-apply appearance settings to every live terminal the moment they change in
// the Settings dialog. Font changes alter the cell grid, so refit and tell the
// PTY about the new cols/rows - otherwise the shell keeps wrapping at the old
// width until the next container resize.
subscribeTerminalSettings((settings) => {
  const theme = resolveTerminalTheme(settings);
  const fontFamily = resolveTerminalFontCss(settings);
  for (const [ptyId, pooled] of pool) {
    pooled.term.options.theme = theme;
    pooled.term.options.fontFamily = fontFamily;
    pooled.term.options.fontSize = settings.fontSize;
    pooled.term.options.lineHeight = settings.lineHeight;
    pooled.term.options.scrollback = settings.scrollback;
    pooled.term.options.scrollSensitivity = settings.scrollSpeed;
    if (!pooled.opened) continue;
    if (holdFollowedGrid(ptyId, pooled.term)) continue;
    try {
      pooled.fit.fit();
      resizePty(ptyId, pooled.term.cols, pooled.term.rows);
    } catch {
      // Element may be detached (hidden tab) - it refits on next reveal.
    }
  }
  repaintTuisOnToneFlip(theme.background);
});

// Toggling the app's light/dark appearance flips the "auto" terminal theme.
// Re-tint every live terminal - colors only, no cell-grid change, so no
// refit is needed (unlike the font/scrollback path above). Baked truecolor
// styling can't be re-tinted though: a cross-tone flip also jiggles the PTYs
// so TUIs repaint in the new mode (see repaintTuisOnToneFlip).
subscribeTheme(() => {
  const theme = resolveTerminalTheme(getTerminalSettings());
  for (const [, pooled] of pool) {
    pooled.term.options.theme = theme;
  }
  repaintTuisOnToneFlip(theme.background);
});

// Report the current tone to main once at startup, before any eager/restored
// conversation pty is adopted - the subscriptions above only fire on a CHANGE,
// so without this main would not learn a light app's tone until the first flip.
if (typeof window !== 'undefined') {
  const dark = isDarkColor(resolveTerminalTheme(getTerminalSettings()).background ?? '#0d0d0d');
  reportTone(dark);
  markLightTerminalPointer(dark);
}

export function acquireTerminal(ptyId: string): PooledTerminal {
  let pooled = pool.get(ptyId);
  if (!pooled) {
    const settings = getTerminalSettings();
    const theme = resolveTerminalTheme(settings);
    lastToneDark ??= isDarkColor(theme.background ?? '#0d0d0d');
    const engine = createGhosttyTerminal(settings, theme);
    const term = engine
      ? (engine as unknown as Terminal)
      : new Terminal({
          cursorBlink: true,
          fontFamily: resolveTerminalFontCss(settings),
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
          scrollback: settings.scrollback,
          // Wheel/trackpad scroll distance multiplier (xterm defaults to a sluggish
          // 1). Scales both scrollback scrolling and wheel-forwarding into TUIs.
          scrollSensitivity: settings.scrollSpeed,
          // Animate wheel/keyboard scrolls instead of jumping whole lines. Only
          // cheap with the WebGL renderer attached - which every visible terminal
          // gets (see attachWebglRenderer). This is the wheel-mouse value; the
          // per-event handler drops it to 0 for trackpad input (see
          // installAdaptiveSmoothScroll) so momentum scrolls don't lag the fingers.
          smoothScrollDuration: WHEEL_SMOOTH_SCROLL_MS,
          theme,
          allowProposedApi: true,
        });
    let fit: TerminalFit;
    let search: TerminalSearch;
    if (engine) {
      fit = engine.fitAddon;
      search = engine.search;
    } else {
      const xtermFit = new FitAddon();
      term.loadAddon(xtermFit);
      const xtermSearch = new SearchAddon({ highlightLimit: FIND_HIGHLIGHT_LIMIT });
      term.loadAddon(xtermSearch);
      fit = xtermFit;
      search = xtermSearch;
    }
    // Clickable links: plain URLs in the output and OSC 8 hyperlinks, both on
    // ⌘-click / Ctrl-click only (see lib/terminal/links.ts).
    term.loadAddon(createWebLinksAddon(term, ptyId));
    term.options.linkHandler = createOsc8LinkHandler(term, ptyId);
    // File paths that exist open in an editor tab (see lib/terminal/file-links.ts).
    term.registerLinkProvider(createFileLinkProvider(ptyId, term));

    // Shift+Enter → insert a newline instead of submitting. A PTY can't tell
    // Shift+Enter from plain Enter - xterm emits a carriage return (\r, 0x0d) for
    // both - so the foreground program runs the command either way. We intercept
    // the keystroke and send a lone line feed (\n, 0x0a, i.e. Ctrl+J) instead:
    // \r = submit, \n = newline is the convention TUIs like Claude Code use
    // (Claude maps \n to `chat:newline`), and it needs no terminal-side config.
    term.attachCustomKeyEventHandler((event) => {
      // Find in terminal (rebindable, Settings › Keyboard shortcuts › Terminal):
      // caught here rather than by the workspace handler, so it opens the bar
      // of the terminal that has focus - in a torn-off window too - and never
      // reaches the shell.
      if (matchCombo(event, getKeymap()['terminal-find'])) {
        if (event.type === 'keydown') openTerminalFind(ptyId, term.getSelection());
        event.preventDefault();
        return false;
      }
      // Clear terminal (⌘K, rebindable): the xterm's own screen + scrollback,
      // never a byte to the shell (see clear.ts).
      if (matchCombo(event, getKeymap()['terminal-clear'])) {
        if (event.type === 'keydown') clearTerminal(term);
        event.preventDefault();
        return false;
      }
      // Clipboard keys off macOS (see clipboard-keys.ts): a paste key goes to
      // the browser, whose native paste reaches xterm's textarea - no
      // preventDefault. A copy key is written here: Chromium binds nothing to
      // Ctrl+Shift+C.
      const clip = terminalClipboardKey(event, {
        windows: isWindows,
        linux: isLinux,
        hasSelection: term.hasSelection(),
      });
      if (clip === 'paste') return false;
      if (clip === 'copy') {
        event.preventDefault();
        const text = term.getSelection();
        if (event.type === 'keydown' && text) void navigator.clipboard?.writeText(text);
        return false;
      }
      // ⌘⌫ / ⌘← / ⌘→ on macOS (see line-edit-keys.ts): the readline control
      // byte for "delete to line start" / "line start" / "line end".
      const lineEdit = terminalLineEditSequence(event, { mac: isMac });
      if (lineEdit) {
        event.preventDefault();
        if (event.type === 'keydown') window.api?.terminal.write(ptyId, lineEdit);
        return false;
      }
      if (
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (event.type === 'keydown') window.api?.terminal.write(ptyId, '\n');
        return false; // suppress xterm's default \r for every phase of this key
      }
      return true;
    });

    // The Inputs list: position tags in the stream become markers here.
    attachInputTracking(ptyId, term);

    pooled = { term, fit, search, ghostty: !!engine, opened: false, needsReplayRequest: true };
    pool.set(ptyId, pooled);
  }
  return pooled;
}

/** A Ghostty engine terminal when this window runs that engine, else null (xterm.js). */
function createGhosttyTerminal(
  settings: ReturnType<typeof getTerminalSettings>,
  theme: ReturnType<typeof resolveTerminalTheme>,
): GhosttyXterm | null {
  const runtime = terminalEngine() === 'ghostty' ? ghosttyRuntime() : null;
  if (!runtime) return null;
  return new GhosttyXterm(
    {
      theme,
      fontFamily: resolveTerminalFontCss(settings),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      scrollback: settings.scrollback,
      scrollSensitivity: settings.scrollSpeed,
      smoothScrollDuration: WHEEL_SMOOTH_SCROLL_MS,
    },
    (options) =>
      new runtime.Terminal({ ...options, ghostty: runtime.ghostty }) as unknown as GhosttyInner,
  );
}

export function getPooledTerminal(ptyId: string): PooledTerminal | undefined {
  return pool.get(ptyId);
}

/**
 * The text of every pooled terminal's active buffer, keyed by ptyId. The
 * screen is a canvas, so a script checking what a terminal shows (the
 * marketing demo's identity scan, lib/demo-hooks.ts) cannot read the DOM.
 */
export function pooledTerminalTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ptyId, { term }] of pool) {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++)
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    out[ptyId] = lines.join('\n');
  }
  return out;
}

/**
 * Make smooth scrolling adapt to the input device. xterm animates every scroll
 * over `smoothScrollDuration` - which turns a wheel-mouse's discrete line notches
 * into a pleasant glide, but layers a 120 ms eased tween on top of a trackpad's
 * own pixel-precise momentum, so the content chases the fingers and settles late
 * (the "rubber-band" lag). The browser tags each wheel event with its granularity:
 * DOM_DELTA_PIXEL for trackpad/Magic Mouse, DOM_DELTA_LINE for a wheel mouse. We
 * read it per event and turn the animation off for pixel input (native 1:1
 * tracking - the OS momentum already makes it smooth) and back on for line input.
 *
 * The listener is capture-phase on the terminal root, so it runs before xterm's
 * viewport handler on the descendant scroll element, and setting `term.options`
 * applies synchronously - so the right duration is in effect by the time xterm
 * consumes the same event. Attached once on the durable element (it survives the
 * reparenting a split/move does), guarded to only write on an actual change.
 */
export function installAdaptiveSmoothScroll(pooled: PooledTerminal): void {
  const el = pooled.term.element;
  if (!el || pooled.adaptiveScroll) return;
  pooled.adaptiveScroll = true;
  let current = WHEEL_SMOOTH_SCROLL_MS;
  el.addEventListener(
    'wheel',
    (event) => {
      const wanted = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 0 : WHEEL_SMOOTH_SCROLL_MS;
      if (wanted === current) return;
      current = wanted;
      pooled.term.options.smoothScrollDuration = wanted;
    },
    { capture: true, passive: true },
  );
}

/**
 * An image pasted into a terminal on Windows (see clipboard-keys.ts): a
 * clipboard with an image and no text sends Claude Code's image-paste key
 * instead of xterm's empty text paste. Capture phase on the durable element,
 * so it runs before xterm's own handler on the textarea; attached once.
 */
export function installPasteOverride(ptyId: string, pooled: PooledTerminal): void {
  const el = pooled.term.element;
  if (!el || pooled.pasteOverride) return;
  pooled.pasteOverride = true;
  el.addEventListener(
    'paste',
    (event) => {
      const types = Array.from(event.clipboardData?.types ?? []);
      const data = terminalPasteOverride(types, { windows: isWindows });
      if (data === null) return;
      event.preventDefault();
      event.stopPropagation();
      window.api?.terminal.write(ptyId, data);
    },
    { capture: true },
  );
}

/**
 * Cap on live WebGL contexts across the pool. Chromium allows ~16 per page and
 * each attached addon holds one, so hidden terminals can't all keep theirs -
 * but detaching the addon the moment a tab hides destroys its canvas, and the
 * canvas bitmap is the ONLY thing that paints on the reveal frame: xterm's
 * render service is paused at display:none (IntersectionObserver) and only
 * unpauses asynchronously after the reveal has painted, so a detached-on-hide
 * terminal comes back as blank background for a few frames - the tab-switch
 * blink. Keeping the addon (and its last frame) on hidden terminals up to this
 * cap makes a reveal paint the previous content instantly; only terminals
 * evicted by the cap pay the one-time blank reveal.
 */
const MAX_WEBGL_CONTEXTS = 8;

/** Monotonic tick for webglStamp - recency without wall-clock reads. */
let webglClock = 0;

/**
 * Reclaim GPU contexts once the pool holds more than the cap: detach the
 * least-recently-shown HIDDEN terminals until back at the cap. Visible
 * terminals are never evicted - if visible panes alone exceed the cap, context
 * creation fails on its own and those terminals fall back to the DOM renderer.
 */
function evictWebglOverCap(): void {
  const attached = [...pool.values()].filter((p) => p.webgl);
  let excess = attached.length - MAX_WEBGL_CONTEXTS;
  if (excess <= 0) return;
  const hidden = attached
    .filter((p) => !p.webglVisible)
    .sort((a, b) => (a.webglStamp ?? 0) - (b.webglStamp ?? 0));
  for (const p of hidden) {
    if (excess <= 0) break;
    detachWebglRenderer(p);
    excess--;
  }
}

/**
 * Attach the WebGL renderer to a terminal being shown (`TerminalView` calls
 * this on the hidden→visible edge). Idempotent: a terminal whose addon survived
 * its last hide (see MAX_WEBGL_CONTEXTS) just gets its recency bumped, and its
 * retained canvas paints the reveal frame with the previous content.
 */
export function attachWebglRenderer(pooled: PooledTerminal): void {
  pooled.webglVisible = true;
  pooled.webglStamp = ++webglClock;
  if (!pooled.webgl && pooled.opened && !pooled.ghostty) {
    try {
      const webgl = new WebglAddon();
      // A lost GPU context (driver reset, context-limit eviction, sleep/wake) leaves
      // the addon's canvas painting solid black - dispose it so xterm falls back to
      // the DOM renderer, then force a repaint: the fallback renderer only draws
      // rows as they change, so without this the terminal stays black until the next
      // reveal/resize. The next hidden→visible edge retries WebGL.
      webgl.onContextLoss(() => {
        detachWebglRenderer(pooled);
        repaint(pooled);
      });
      pooled.term.loadAddon(webgl);
      pooled.webgl = webgl;
    } catch {
      // WebGL unavailable (GPU blocklist, headless) - the DOM renderer remains.
    }
  }
  evictWebglOverCap();
}

/**
 * Mark a terminal hidden (visible→hidden edge, or its mount unwinding) WITHOUT
 * destroying its renderer: the addon's canvas keeps the last painted frame, so
 * the next reveal shows content immediately instead of blinking through blank
 * background. The cap eviction reclaims the GPU context later if the pool
 * grows past MAX_WEBGL_CONTEXTS.
 */
export function releaseWebglRenderer(pooled: PooledTerminal): void {
  pooled.webglVisible = false;
  evictWebglOverCap();
}

/** Force xterm to redraw its whole viewport from the buffer (both renderers). */
function repaint(pooled: PooledTerminal): void {
  try {
    pooled.term.refresh(0, pooled.term.rows - 1);
  } catch {
    // Element detached mid-layout - it repaints on next reveal.
  }
}

/**
 * Recover every live terminal's rendering after the machine wakes from sleep (or
 * the screen unlocks). A sleep or GPU-process reset can silently lose the WebGL
 * context under xterm - the canvas then paints solid black - and the
 * `webglcontextlost` event that would normally trigger recovery isn't reliably
 * delivered across sleep, so xterm's own fallback never kicks in.
 *
 * Two phases, because the GPU isn't ready at the instant the OS reports wake:
 *  1. Immediately drop every (possibly-dead) GPU renderer and repaint from the
 *     buffer via the DOM renderer. That renderer is CPU-only, so it paints even
 *     while the GPU is still re-initializing - this is what un-sticks the black
 *     terminal, guaranteed.
 *  2. After a short delay, hand each on-screen terminal a fresh WebGL context and
 *     repaint again. Re-attaching in the same tick as the wake event (as this
 *     used to) hands back a context that's still cold and paints black - with no
 *     `webglcontextlost` to recover it - which is exactly what left the terminal
 *     stuck. Waiting lets the context be real; a context that's somehow still bad
 *     falls back via its onContextLoss handler or the next resume.
 *  3. Later still, clear every attached renderer's glyph texture atlas and
 *     repaint. Phase 2's fresh addon builds a fresh atlas (phase 1's detach
 *     disposed the shared one), but rasterizing/uploading its glyph pages that
 *     soon after wake can silently produce blank pages - the atlas cache then
 *     believes every glyph is drawn, so every terminal shows background + cursor
 *     and nothing else until new output adds an uncached glyph (which is why a
 *     single ^C used to un-blank ALL terminals: the atlas is shared per-config).
 *     clearTextureAtlas() drops the pages and cache maps, forcing on-demand
 *     re-rasterization on a GPU that has had ample time to come back.
 *
 * Wired to `system:resume` (see terminal-pool's module-level subscription below).
 */
export function redrawAllTerminals(): void {
  for (const pooled of pool.values()) {
    if (!pooled.opened) continue;
    detachWebglRenderer(pooled);
    repaint(pooled);
  }
  setTimeout(() => {
    for (const pooled of pool.values()) {
      if (!pooled.opened || pooled.webgl) continue;
      const el = pooled.term.element;
      const onScreen = !!el && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
      if (!onScreen) continue;
      attachWebglRenderer(pooled);
      repaint(pooled);
    }
  }, WEBGL_REATTACH_AFTER_WAKE_MS);
  setTimeout(() => {
    for (const pooled of pool.values()) {
      if (!pooled.opened || !pooled.webgl) continue;
      try {
        pooled.webgl.clearTextureAtlas();
      } catch {
        // Addon disposed mid-flight - the next attach builds a fresh atlas.
      }
      repaint(pooled);
    }
  }, ATLAS_RECLEAR_AFTER_WAKE_MS);
}

// Machine woke from sleep / screen unlocked: xterm's GPU canvases may be stranded
// black (see redrawAllTerminals). main broadcasts `system:resume` on the OS power
// event; re-cycle every window's terminal renderers when it arrives.
if (typeof window !== 'undefined') window.api?.system?.onResume(redrawAllTerminals);

export function detachWebglRenderer(pooled: PooledTerminal): void {
  const webgl = pooled.webgl;
  if (!webgl) return;
  pooled.webgl = undefined;
  try {
    webgl.dispose();
  } catch {
    // Already disposed with the terminal.
  }
}

/**
 * How long the PTY sits one row short during a reconcile jiggle before its real
 * size is restored - same trick and duration as the adopt / tone-flip jiggles:
 * two distinct SIGWINCHes, which is what makes a full-screen TUI redraw every
 * row rather than keep its garbled frame.
 */
const GRID_RECONCILE_JIGGLE_MS = 80;
const gridReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Verify - and heal - the invariant that a terminal's xterm grid and its PTY's
 * grid are the same.
 *
 * Every path that changes one is supposed to change the other, but a push can
 * still be lost (a shell still spawning, a window that no longer owns the
 * terminal, a fit that ran without telling main, two resizes crossing), and the
 * result is silent and PERMANENT: the container never resizes again, so nothing
 * refits, and the program keeps drawing frames sized for a grid the xterm
 * doesn't have - Claude Code's prompt box loses its borders and sheds fragments
 * of earlier frames. Rather than chase every race, this asks main for the PTY's
 * actual grid and forces agreement: the container is the authority, so refit the
 * xterm to it, then push that grid down and jiggle so the TUI repaints in full.
 *
 * Cheap enough to run on every reveal/focus (one IPC round trip, and only for
 * on-screen terminals); a no-op in the overwhelming majority of calls, where the
 * two already agree.
 */
/** Options for `reconcileTerminalGrid`. */
export type ReconcileGridOptions = {
  /**
   * The grid the terminal's content was just rendered for (a replay's
   * `replaySize`). If the refit lands anywhere else, the program is jiggled
   * into a full repaint even when the PTY already agrees: its last frame was
   * parsed at the other grid, and with the grids in agreement nothing else
   * would ever redraw it.
   */
  repaintFrom?: { cols: number; rows: number };
};

export function reconcileTerminalGrid(ptyId: string, opts: ReconcileGridOptions = {}): void {
  const pooled = pool.get(ptyId);
  if (!pooled?.opened) return;
  // The mount's container. A hidden tab (display:none) measures 0 and is skipped
  // - it can't fit against a laid-out box, and its reveal refits anyway.
  const container = pooled.term.element?.parentElement;
  if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
  // Another computer sizes it: the xterm keeps that grid - no refit, no
  // query, no jiggle of the shared pty (shared-grid.ts).
  if (holdFollowedGrid(ptyId, pooled.term)) return;
  const before = { cols: pooled.term.cols, rows: pooled.term.rows };
  try {
    pooled.fit.fit();
  } catch {
    return; // detached mid-layout - the next reveal refits
  }
  const { cols, rows } = pooled.term;
  const from = opts.repaintFrom;
  if (from && (from.cols !== cols || from.rows !== rows)) {
    jiggleTerminalGrid(ptyId);
    return;
  }
  // The refit moved the grid (a tab revealed after its pane changed size
  // while it was hidden): tell the pty now. A size query would race the
  // reveal's own push and be answered with the old size - a "divergence"
  // jiggled into two more SIGWINCHes, three repaints for one reveal.
  if (before.cols !== cols || before.rows !== rows) {
    suppressTerminalActivity(ptyId);
    resizePty(ptyId, cols, rows);
    return;
  }
  // A repaint jiggle is mid-flight: its restore pushes the live grid in a
  // moment, and its rows−1 step would only read as a divergence here - one
  // jiggle begetting the next, a SIGWINCH storm the TUI strobes through.
  if (gridReconcileTimers.has(ptyId)) return;
  const query = window.api?.terminal?.size?.(ptyId);
  if (!query) return;
  // A rejection here means the window is going away (or main is older than this
  // renderer, mid dev-reload) - the refit above still stands, so just stop.
  void query
    .catch(() => null)
    .then((size) => {
      // The terminal may have been disposed/replaced across the round trip.
      if (!size || pool.get(ptyId) !== pooled) return;
      // The grid moved on while we asked (a refit, a replay sizing the xterm):
      // whatever moved it pushed its own resize, so this answer is stale - a
      // reconcile against it would push a grid the container no longer has.
      if (pooled.term.cols !== cols || pooled.term.rows !== rows) return;
      if (gridReconcileTimers.has(ptyId)) return;
      if (size.cols === cols && size.rows === rows) return;
      console.warn(
        `[terminal] ${ptyId}: pty ${size.cols}×${size.rows} ≠ xterm ${cols}×${rows} - resyncing`,
      );
      jiggleTerminalGrid(ptyId);
    });
}

/**
 * Push the xterm's grid to the PTY as a rows−1 → rows pair: two real
 * SIGWINCHes (a same-size resize delivers none), so the foreground TUI
 * repaints every row instead of keeping a frame drawn for another grid. The
 * restore reads the live grid, so a refit landing mid-jiggle wins. Gated out
 * of session-status like every other induced redraw.
 */
function jiggleTerminalGrid(ptyId: string): void {
  const pooled = pool.get(ptyId);
  if (!pooled) return;
  // A follower never jiggles the shared pty; the claimant's jiggle is fine.
  if (followsOther(ptyId)) return;
  suppressTerminalActivity(ptyId);
  resizePty(ptyId, pooled.term.cols, Math.max(1, pooled.term.rows - 1));
  clearTimeout(gridReconcileTimers.get(ptyId));
  gridReconcileTimers.set(
    ptyId,
    setTimeout(() => {
      gridReconcileTimers.delete(ptyId);
      const cur = pool.get(ptyId);
      if (!cur || followsOther(ptyId)) return;
      suppressTerminalActivity(ptyId);
      resizePty(ptyId, cur.term.cols, cur.term.rows);
    }, GRID_RECONCILE_JIGGLE_MS),
  );
}

/**
 * Move the caret into a pooled terminal after a drag drop. Deferred one frame +
 * refit first: a dropped terminal has just been repositioned/resized into a new
 * pane, and focusing xterm mid-reflow makes it blur itself - fitting first lets
 * it settle so the caret sticks. The refit goes through the reconcile so the
 * dropped terminal's shell learns its new grid (a bare fit would leave the two
 * disagreeing for good).
 */
export function focusPooledTerminal(ptyId: string): void {
  const pooled = pool.get(ptyId);
  if (!pooled) return;
  requestAnimationFrame(() => {
    reconcileTerminalGrid(ptyId);
    pooled.term.focus();
  });
}

/**
 * Dispose a terminal's pooled xterm and evict it. By default also kills the PTY
 * in main (tab close). Pass `killPty: false` when the tab is moving to ANOTHER
 * window - the shell must keep running so the new window can adopt it. Call from
 * the close/move path, never a React unmount, so layout moves and StrictMode
 * remounts leave the shell alive.
 */
export function disposePooledTerminal(ptyId: string, killPty = true): void {
  clearTimeout(gridReconcileTimers.get(ptyId));
  gridReconcileTimers.delete(ptyId);
  if (killPty && typeof window !== 'undefined') window.api?.terminal.dispose(ptyId);
  // Closed, or moving to another window - which asks main for the list itself.
  forgetInputs(ptyId);
  closeTerminalFind(ptyId);
  if (killPty) {
    forgetTerminalCwd(ptyId);
    forgetSharedGrid(ptyId);
  }
  const pooled = pool.get(ptyId);
  if (pooled) {
    try {
      pooled.term.dispose();
    } catch {
      // Already gone.
    }
    pool.delete(ptyId);
  }
}
