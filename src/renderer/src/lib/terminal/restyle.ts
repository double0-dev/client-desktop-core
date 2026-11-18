import { resolveTerminalTheme } from '@renderer/lib/settings/terminal-settings';
import { isDarkColor } from '@renderer/lib/utils';

/**
 * Rewrites Claude Code's hardcoded truecolor SGRs to sit on the terminal theme.
 *
 * Claude Code paints its TUI with truecolor escapes from its built-in dark
 * theme (all values captured from real sessions, CC v2.1.220): the submitted
 * user-message bar (bg #373737, hovered #464646), Monokai syntax highlighting
 * in code previews (plain text #F8F8F2 - invisible on white), status accents,
 * and dark diff backgrounds. Truecolor bypasses the terminal palette entirely,
 * so no `ITheme` can restyle it. The fix: rewrite those exact escape sequences
 * in the PTY byte stream before they reach xterm.
 *
 * Claude Code has its OWN light and dark palettes and picks one per terminal
 * tone (theme "auto"): at startup it queries the background with `OSC 11 ; ? BEL`
 * and, given truecolor, paints that tone's truecolor palette. It re-detects ONLY
 * when the terminal pushes a DECSET-2031 colour-scheme notification
 * (`CSI ? 997 ; 1 n` dark / `; 2 n` light) - it does not re-query on resize or
 * focus. xterm.js answers OSC 11 from its `ITheme` but never emits the 2031
 * push, so a terminal-theme flip while `claude` runs is invisible to it: it
 * keeps painting the OLD tone's palette on the new background (verified against
 * CC v2.1.278 with scripts/probe-claude-theme.py). pool.ts reports every flip
 * to main, which sends the 2031 push to each pty that enabled it; an eager pty
 * whose startup query reached no xterm (CC waits on its dark fallback and
 * ignores pushes meanwhile) is answered by the adopt replay instead - see
 * `adopt` in main/terminal.ts. This rewrite is the fallback for whatever CC
 * paints in the wrong tone anyway (cells baked before its switch, a CC build
 * without 2031, theme "dark"/"light" pinned against the app).
 *
 * The user bar is rewritten under every theme, because CC's shades are fixed
 * per palette while the background under them is not: CC's dark-mode bar
 * (#373737) reads as a near-black block on a light theme and barely off a dark
 * one; its light-mode bar (#f0f0f0) reads as a white block on a dark theme.
 * Both bars, both states, are re-derived from the theme background - see
 * `USER_BAR_MIX` / `USER_BAR_MIX_ON_DARK` - and the message text with them.
 *
 * The rest of the rewrite is per theme: on a LIGHT theme CC's dark palette is
 * illegible, so light foregrounds map to dark equivalents of the same hue and
 * dark diff backgrounds to pastels; on a DARK theme CC's light palette is
 * illegible, so it is mirrored the other way (dark-on-light foregrounds to
 * light, light diff pastels to CC's own dark diff backgrounds). Foregrounds are
 * only rewritten while the stream's current SGR background is the theme
 * default - text painted over an app-drawn OPPOSITE-tone background (e.g. the
 * "Jump to bottom" pill, or a colored chip) keeps its color.
 *
 * Truecolor is baked into cells at write time, but Claude Code repaints its
 * visible rows on scroll/resize, so styling self-corrects shortly after a
 * flip. If a Claude Code update changes its palette, the rewrite silently stops
 * matching and the stock colors return - graceful degradation. (Palettes
 * re-verified against CC v2.1.278: dark bar 55;55;55 / 70;70;70, light bar
 * 240;240;240 / 252;252;252 - the `userMessageBackground[Hover]` theme keys -
 * and the light diff colors from its diff renderer, both read off the binary.)
 *
 * The whole rewrite presumes the pty advertises truecolor - main's
 * terminal-env.ts sets COLORTERM/TERM for every pty. Without that (the
 * installed app launched from the Finder inherits neither) Claude Code drops
 * to the 16 ANSI colours - `\x1b[40m` bar, `\x1b[97m` text - and nothing
 * here matches: the black user bar on a light theme (2026-09-16).
 */

type Rgb = readonly [number, number, number];

/**
 * Claude Code's user-message bar backgrounds → how far to pull the terminal
 * background toward black (light themes) or white (dark themes) in their place.
 *
 * The two ends are not symmetric on purpose. A faint dark tint on white is easy
 * to see, while the same distance in near-black greys is barely perceptible -
 * CC's own #373737 on a black terminal is what "the message I typed is hard to
 * find" looks like. So dark themes take a much larger step. Hover is one notch
 * past resting either way: enough to say "the mouse is here", not a fill.
 */
const USER_BAR_MIX = new Map<string, number>([
  ['55;55;55', 0.08], // resting bar (CC dark palette)
  ['70;70;70', 0.15], // hovered bar (CC dark palette)
]);
/**
 * On a dark theme both CC palettes need lifting off the background: the
 * dark-mode bar (55/70) sits barely above it, the light-mode bar (240/252) is a
 * white block. Both map to the SAME derived shade so the bar looks identical
 * whichever palette CC is painting - the whole point is that the flip is
 * invisible to the user.
 */
const USER_BAR_MIX_ON_DARK = new Map<string, number>([
  ['55;55;55', 0.3], // resting bar (CC dark palette)
  ['70;70;70', 0.42], // hovered bar (CC dark palette)
  ['240;240;240', 0.3], // resting bar (CC light palette)
  ['252;252;252', 0.42], // hovered bar (CC light palette)
]);

/**
 * The message text CC paints on that bar. In its dark palette that is #505050
 * (80;80;80), chosen against #373737 and already only 1.55:1 there; in its
 * light palette the message is black (0;0;0), which on the lifted dark bar would
 * vanish. Both are re-derived from the theme background on a dark theme, far
 * enough up to clear both bar states. Light themes leave the dark-palette text:
 * #505050 on the tinted bar is dark-on-light and reads fine.
 */
const USER_BAR_FG_KEYS_ON_DARK = ['80;80;80', '0;0;0'];
const USER_BAR_FG_MIX_ON_DARK = 0.75;

/**
 * Dark-theme foregrounds → legible-on-light replacements (same hue, darker).
 * Keys are the `R;G;B` of the truecolor SGR as Claude Code emits it.
 */
const FG_REMAP = new Map<string, Rgb>([
  ['255;255;255', [51, 51, 51]], // theme text (also the user-bar message)
  ['177;185;249', [70, 79, 187]], // periwinkle - file paths / inline code refs
  ['248;248;242', [56, 58, 66]], // Monokai fg - plain code text
  ['249;38;114', [194, 24, 91]], // Monokai pink - keywords
  ['230;219;116', [139, 118, 20]], // Monokai yellow - strings
  ['102;217;239', [7, 121, 163]], // Monokai cyan - types/builtins
  ['166;226;46', [85, 132, 0]], // Monokai green - functions
  ['190;132;255', [124, 58, 237]], // Monokai purple - numbers/constants
  ['253;151;31', [180, 83, 0]], // Monokai orange - params/literals
  ['80;200;80', [40, 130, 55]], // diff-added line
  ['56;166;96', [40, 130, 55]], // added-count green (+N)
  ['78;186;101', [40, 130, 55]], // success green
  ['179;89;107', [158, 44, 68]], // removed-count red (-N)
  ['220;90;90', [178, 45, 45]], // error red
  ['255;193;7', [154, 103, 0]], // warning yellow
]);

/** Dark diff backgrounds → light pastels (word emphasis a step deeper). */
const BG_REMAP = new Map<string, Rgb>([
  ['2;40;0', [223, 240, 216]], // diff added line
  ['61;1;0', [248, 222, 222]], // diff removed line
  ['4;71;0', [178, 226, 165]], // diff added word emphasis
  ['92;2;0', [246, 198, 198]], // diff removed word emphasis
  ['38;79;120', [180, 213, 255]], // mouse selection (CC paints its own)
]);

/**
 * The mirror of `FG_REMAP` for a DARK theme showing Claude Code's LIGHT palette:
 * its dark-on-light foregrounds → CC's own dark-palette equivalents (same hue,
 * light). Keys are the `R;G;B` CC's light palette emits (captured from
 * v2.1.278). Only these exact values are touched, so a CC that is correctly in
 * its dark palette on a dark theme (255;255;255 text, 248;248;242 code, …) is
 * left alone - none of those are keys here.
 */
const FG_REMAP_ON_DARK = new Map<string, Rgb>([
  ['0;0;0', [255, 255, 255]], // theme text / inverse black
  ['51;51;51', [248, 248, 242]], // light diff foreground / punctuation
  ['87;105;247', [177, 185, 249]], // periwinkle - file paths / permission / suggestion
  ['167;29;93', [249, 38, 114]], // keyword / operator
  ['0;134;179', [102, 217, 239]], // types / built-ins / numbers / attrs
  ['24;54;145', [230, 219, 116]], // strings / regexp
  ['121;93;163', [166, 226, 46]], // titles / functions
  ['150;152;150', [117, 113, 94]], // comments / meta
  ['36;138;61', [80, 200, 80]], // diff-added decoration (+)
  ['207;34;46', [220, 90, 90]], // diff-removed decoration (-)
  ['47;157;68', [56, 166, 96]], // added-count / word green (+N)
  ['209;69;75', [179, 89, 107]], // removed-count / word red (-N)
  ['44;122;57', [78, 186, 101]], // success green
  ['171;43;63', [255, 107, 128]], // error red
  ['150;108;30', [255, 193, 7]], // warning yellow
]);

/** Light diff backgrounds → CC's own dark diff backgrounds (word a step deeper). */
const BG_REMAP_ON_DARK = new Map<string, Rgb>([
  ['220;255;220', [2, 40, 0]], // diff added line
  ['255;220;220', [61, 1, 0]], // diff removed line
  ['178;255;178', [4, 71, 0]], // diff added word emphasis
  ['255;199;199', [92, 2, 0]], // diff removed word emphasis
  // Mouse selection - full-screen CC captures the mouse and paints its own
  // highlight. Left light, its text (lightened on the dark default) read as
  // white on pale blue (2026-09-23).
  ['180;213;255', [38, 79, 120]],
]);

const ESC = String.fromCharCode(27);
/** Any complete SGR sequence. */
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
/** A chunk-final incomplete escape: bare ESC or an unterminated CSI body. */
const PARTIAL_TAIL_RE = new RegExp(`${ESC}(?:\\[[0-9;]*)?$`);
/** Never hold back more than this - bounds the carry on garbage streams. */
const MAX_HELD = 32;

/** Same weights/threshold as `isDarkColor`, on raw channel values. */
function isDarkRgb(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** Rough darkness of an indexed (256-color) background. */
function isDarkAnsi256(n: number): boolean {
  if (n < 16) return n !== 7 && n !== 15;
  if (n >= 232) {
    const v = 8 + 10 * (n - 232);
    return isDarkRgb(v, v, v);
  }
  const q = n - 16;
  const ramp = [0, 95, 135, 175, 215, 255];
  const at = (d: number): number => ramp[Math.floor(q / d) % 6];
  return isDarkRgb(at(36), at(6), at(1));
}

/** The theme's background, or null when the restyle has nothing to derive from. */
function themeBackground(): string | null {
  return resolveTerminalTheme().background ?? null;
}

/**
 * "Transparent gray" user-bar background: the theme background pulled `mix` of
 * the way to black on a light theme or to white on a dark one, so the bar reads
 * as a tint of the terminal rather than a block laid over it.
 */
function overlayGray(themeBg: string, mix: number, onDark: boolean): Rgb {
  const n = /^#[0-9a-f]{6}$/i.test(themeBg) ? parseInt(themeBg.slice(1), 16) : 0xfafafa;
  const target = onDark ? 255 : 0;
  const at = (shift: number): number => {
    const c = (n >> shift) & 0xff;
    return Math.round(c + (target - c) * mix);
  };
  return [at(16), at(8), at(0)];
}

/**
 * Per-terminal stateful chunk transform for the PTY→xterm write path. The PTY
 * chunks arbitrarily, so a chunk ending mid-sequence is held back (bounded,
 * unrenderable by xterm anyway) and re-examined when the next chunk arrives.
 */
export function createTerminalRestyler(
  background: () => string | null = themeBackground,
): (chunk: string) => string {
  let carry = '';
  // Tone of the stream's current SGR background. Initialised (and reset on
  // SGR 0/49) to the theme default: on a light theme the default is light, on a
  // dark theme it is dark. Foregrounds are only remapped while the background is
  // the theme's own tone - text over an app-drawn OPPOSITE-tone background (the
  // "Jump to bottom" pill on light, a colored chip on dark) keeps its color.
  let curBgDark = false;
  // The theme tone decides which of CC's two palettes is the illegible one:
  // on a light theme its dark palette is remapped, on a dark theme its light
  // palette. The user bar is remapped under both.
  let onDarkTheme = false;
  // Whether the stream is painting inside a rewritten user bar - scopes the
  // message-text rewrite to the bar rather than to that grey anywhere.
  let onUserBar = false;
  let barBgs = new Map<string, Rgb>();
  let barFgs = new Map<string, Rgb>();
  let barBgsFor = '';

  const rewriteSgr = (seq: string, rawParams: string): string => {
    const parts =
      rawParams === '' ? [0] : rawParams.split(';').map((p) => (p === '' ? 0 : Number(p)));
    const out: number[] = [];
    let changed = false;
    let i = 0;
    while (i < parts.length) {
      const p = parts[i];
      if ((p === 38 || p === 48) && parts[i + 1] === 2 && i + 4 < parts.length) {
        const [r, g, b] = [parts[i + 2], parts[i + 3], parts[i + 4]];
        const key = `${r};${g};${b}`;
        const bar = p === 48 ? barBgs.get(key) : undefined;
        const mapped =
          p === 48
            ? (bar ?? (onDarkTheme ? BG_REMAP_ON_DARK.get(key) : BG_REMAP.get(key)))
            : onDarkTheme
              ? // Dark theme: lift CC's bar text on the bar, else remap its light
                // palette while the bg is the (dark) default - text on an
                // app-drawn light bg keeps its color.
                onUserBar
                ? barFgs.get(key)
                : curBgDark
                  ? FG_REMAP_ON_DARK.get(key)
                  : undefined
              : // Light theme: remap CC's dark palette while the bg is the
                // (light) default - text on an app-drawn dark bg keeps its color
                // (the light user bar is a light bg, so FG_REMAP darkens it too).
                curBgDark
                ? undefined
                : FG_REMAP.get(key);
        if (p === 48) {
          onUserBar = bar !== undefined;
          // Track the tone actually written, so text on a rewritten background
          // is judged against what it will land on, not CC's original shade.
          curBgDark = isDarkRgb(...(mapped ?? [r, g, b]));
        }
        if (mapped) changed = true;
        out.push(p, 2, ...(mapped ?? [r, g, b]));
        i += 5;
        continue;
      }
      if ((p === 38 || p === 48) && parts[i + 1] === 5 && i + 2 < parts.length) {
        if (p === 48) {
          onUserBar = false;
          curBgDark = isDarkAnsi256(parts[i + 2]);
        }
        out.push(p, 5, parts[i + 2]);
        i += 3;
        continue;
      }
      if (p === 38 || p === 48) return seq; // malformed extended color - leave whole sequence alone
      // SGR 0 (reset) / 49 (default bg) return to the theme's own background tone.
      if (p === 0 || p === 49) {
        onUserBar = false;
        curBgDark = onDarkTheme;
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        onUserBar = false;
        curBgDark = p !== 47 && p !== 107;
      }
      out.push(p);
      i += 1;
    }
    return changed ? `\x1b[${out.join(';')}m` : seq;
  };

  return (chunk) => {
    const s = carry + chunk;
    carry = '';
    const themeBg = background();
    if (themeBg === null) return s;
    if (themeBg !== barBgsFor) {
      barBgsFor = themeBg;
      onDarkTheme = isDarkColor(themeBg);
      // A theme flip is a fresh reset point for the streaming bg tone.
      curBgDark = onDarkTheme;
      barBgs = new Map(
        [...(onDarkTheme ? USER_BAR_MIX_ON_DARK : USER_BAR_MIX)].map(
          ([key, mix]) => [key, overlayGray(themeBg, mix, onDarkTheme)] as const,
        ),
      );
      barFgs = onDarkTheme
        ? new Map(
            USER_BAR_FG_KEYS_ON_DARK.map(
              (key) => [key, overlayGray(themeBg, USER_BAR_FG_MIX_ON_DARK, true)] as const,
            ),
          )
        : new Map();
    }
    let out = s.replace(SGR_RE, rewriteSgr);
    const tail = PARTIAL_TAIL_RE.exec(out);
    if (tail && tail[0].length <= MAX_HELD) {
      carry = tail[0];
      out = out.slice(0, out.length - tail[0].length);
    }
    return out;
  };
}
