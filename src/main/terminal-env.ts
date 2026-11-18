/**
 * The environment every pty is spawned with. Pure (no Electron) so the rule
 * is testable; terminal.ts applies it at the single spawn site.
 *
 * A pty inherits the app's own environment, and that depends on how the app
 * was launched: `pnpm dev` from an editor terminal carries `COLORTERM`,
 * `TERM_PROGRAM=vscode` and a UTF-8 `LANG`; the installed app launched from
 * the Finder carries none of them (12 variables in total, 2026-09-16). Programs
 * size their colours to that: under `TERM=xterm-color` with no `COLORTERM`,
 * Claude Code drops to the 16 ANSI colours (`\x1b[40m` black bar, `\x1b[97m`
 * text) and the light-theme rewrite in lib/terminal/restyle.ts, which knows
 * only its truecolor palette, matches nothing - the black user bar on a light
 * theme. xterm.js renders truecolor, so every pty says so, whoever launched
 * the app, and identifies the app rather than the editor that started it.
 * The same env asks Claude Code's fullscreen renderer for full repaints -
 * see the comment at the assignment.
 */

import { envPath, setEnvPath } from './env-path';

/**
 * `dir` first on the env's PATH - under the spelling the env has (`Path` on
 * Windows), never as a second variable beside it (env-path.ts).
 */
export function withDirOnPath(
  env: Record<string, string>,
  dir: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const rest = envPath(env, platform);
  const sep = platform === 'win32' ? ';' : ':';
  return setEnvPath({ ...env }, rest ? `${dir}${sep}${rest}` : dir, platform);
}

/** What node-pty sets `TERM` to (its `name` option overrides the env). */
export const PTY_TERM = 'xterm-256color';

/**
 * A UTF-8 locale for shells started with none. macOS always has en_US.UTF-8;
 * a minimal Linux (Ubuntu server, WSL, a container) has only C.UTF-8, built
 * into glibc, and en_US there made every shell warn "setlocale: cannot change
 * locale" and lose UTF-8 (2026-10-29).
 */
function fallbackLang(platform: NodeJS.Platform): string {
  return platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8';
}

/**
 * The variables the APP contributes to every pty, whatever the host's own
 * environment holds - the overlay a launch plan carries (launch-plan.ts).
 */
export function terminalOverlay(appVersion: string): Record<string, string> {
  return {
    TERM: PTY_TERM,
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'double0',
    TERM_PROGRAM_VERSION: appVersion,
    // Claude Code's fullscreen renderer sends only the cells that changed since
    // its last frame. Once the terminal's content has drifted from that model,
    // fragments of earlier frames survive wherever the new frame is blank -
    // stale spinner glyphs in the gutter, a reply line interleaved with the text
    // that stood there before - and nothing repaints them until the next resize
    // (seen after switching sessions, 2026-09-16). This is the knob Claude Code
    // documents for exactly that (fullscreen docs, "Stale or misplaced text";
    // its own default under Windows Terminal): every frame rewrites every cell.
    // Costs output volume and slows its spinner animations to ~2 fps; xterm.js
    // parses it without effort. Only Claude Code reads it.
    CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
  };
}

/** `base` with the app's overlay on top and a UTF-8 locale when it has none. */
export function applyTerminalEnv(
  base: Record<string, string | undefined>,
  overlay: Record<string, string>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // An app started from inside a double0 tab inherits that tab's launch
    // variables (start command, capture file, session record, marker folder):
    // every shell of the new app would report into the OLD tab's files. The
    // app sets its own per terminal; none is ever the app's configuration.
    if (typeof value === 'string' && !/^DOUBLE0_/i.test(key)) env[key] = value;
  }
  Object.assign(env, overlay);
  // Only when nothing locale-shaped is set: a user's LC_ALL / LC_CTYPE choice
  // stays. Windows shells take their code page from the console, not from LANG.
  if (platform !== 'win32' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
    env.LANG = fallbackLang(platform);
  }
  return env;
}

/**
 * `applyTerminalEnv` over the app's own overlay - the whole rule in one call.
 * A spawn applies the same two pieces separately (the overlay rides in the
 * launch plan, launch-materialize.ts applies it on the host); this is their
 * composition, and what terminal-env.test.ts pins.
 */
export function ptyEnv(
  base: Record<string, string | undefined>,
  opts: { appVersion: string; platform: NodeJS.Platform },
): Record<string, string> {
  return applyTerminalEnv(base, terminalOverlay(opts.appVersion), opts.platform);
}
