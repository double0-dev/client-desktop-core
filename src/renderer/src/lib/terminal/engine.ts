import type { Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';

import { getTerminalSettings, type TerminalEngine } from '@renderer/lib/settings/terminal-settings';

/**
 * Which terminal engine this window's terminals run on (Settings › Terminal ›
 * Renderer): xterm.js, or the Ghostty engine (ghostty-web - Ghostty's parser
 * compiled to WebAssembly, drawn on a canvas; experimental).
 *
 * Read ONCE, at boot: a live terminal cannot change engines, and two engines
 * side by side in one window would answer the same setting differently. A
 * change applies when the window reloads (the Settings row offers it). The
 * Ghostty engine is loaded only when chosen - its module and its WebAssembly
 * stay out of every xterm window - and a failed load falls back to xterm.js.
 */

const chosen: TerminalEngine =
  typeof window === 'undefined' ? 'xterm' : getTerminalSettings().engine;

export type GhosttyRuntime = {
  Terminal: typeof GhosttyTerminal;
  ghostty: Ghostty;
};

let runtime: GhosttyRuntime | null = null;
let preparing: Promise<void> | null = null;

/** The engine this window runs (the boot-time choice, xterm.js if Ghostty failed to load). */
export function terminalEngine(): TerminalEngine {
  return chosen === 'ghostty' && runtime ? 'ghostty' : 'xterm';
}

/** The engine the setting asked for at boot - differs from `terminalEngine()` only after a failed load. */
export function chosenTerminalEngine(): TerminalEngine {
  return chosen;
}

/** The loaded Ghostty engine, or null (not chosen, not loaded yet, or failed). */
export function ghosttyRuntime(): GhosttyRuntime | null {
  return runtime;
}

/**
 * Load the chosen engine before the first terminal is made (main.tsx awaits
 * it before the first render). Never rejects: a failure is logged and the
 * window runs xterm.js.
 */
export function prepareTerminalEngine(): Promise<void> {
  if (chosen !== 'ghostty') return Promise.resolve();
  preparing ??= (async () => {
    try {
      const [mod, wasm] = await Promise.all([
        import('ghostty-web'),
        // Loaded from the app's own origin: the module's built-in loader
        // fetches a data: URL, which the dev CSP's connect-src refuses.
        import('ghostty-web/ghostty-vt.wasm?url'),
      ]);
      const ghostty = await mod.Ghostty.load(wasm.default);
      runtime = { Terminal: mod.Terminal, ghostty };
    } catch (err) {
      console.warn('[terminal] the Ghostty engine failed to load - using xterm.js', err);
    }
  })();
  return preparing;
}
