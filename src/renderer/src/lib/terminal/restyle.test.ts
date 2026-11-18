import { describe, expect, it } from 'vitest';

import { createTerminalRestyler } from '@renderer/lib/terminal/restyle';

// Literals duplicated from terminal-restyle.ts on purpose - a drive-by edit to
// a constant should fail here, not silently change what gets rewritten.
const BAR = '\x1b[48;2;55;55;55m';
const HOVER_BAR = '\x1b[48;2;70;70;70m';
// #fafafa (Double0 Light background) under the 8% black overlay → 230.
const GRAY_BAR = '\x1b[48;2;230;230;230m';
// The same background under the deeper 15% hover overlay → 213.
const GRAY_HOVER_BAR = '\x1b[48;2;213;213;213m';
const WHITE = '\x1b[38;2;255;255;255m';
const DARK_TEXT = '\x1b[38;2;51;51;51m';

const light = (): string | null => '#fafafa';
// A pure-black theme background lifted 30% / 42% toward white (Double0 Dark
// itself is #0d0d0d; the fixture keeps the round numbers).
const dark = (): string | null => '#000000';
const LIFTED_BAR = '\x1b[48;2;77;77;77m';
const LIFTED_HOVER_BAR = '\x1b[48;2;107;107;107m';
// The message text CC paints on the bar, and its lift on a black background.
const BAR_TEXT = '\x1b[38;2;80;80;80m';
const LIFTED_BAR_TEXT = '\x1b[38;2;191;191;191m';
const off = (): string | null => null;

describe('createTerminalRestyler', () => {
  it('rewrites the user bar to a gray derived from the theme background', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle(`before${BAR}${WHITE}hi\x1b[49m after`)).toBe(
      `before${GRAY_BAR}${DARK_TEXT}hi\x1b[49m after`,
    );
    const onWhite = createTerminalRestyler(() => '#ffffff');
    expect(onWhite(BAR)).toBe('\x1b[48;2;235;235;235m');
  });

  it('tints the hovered user bar instead of letting it paint near-black', () => {
    // CC's hover background is #464646 - untouched it reads as a black block on
    // a light theme, which is the opposite of "the mouse is on this message".
    const restyle = createTerminalRestyler(light);
    expect(restyle(`${HOVER_BAR}${WHITE}msg`)).toBe(`${GRAY_HOVER_BAR}${DARK_TEXT}msg`);
  });

  it('keeps the hovered bar a visible step from the resting bar', () => {
    const restyle = createTerminalRestyler(light);
    const shade = (seq: string): number =>
      Number(/48;2;(\d+)/.exec(restyle(seq))?.[1] ?? Number.NaN);
    const resting = shade(BAR);
    const hovered = shade(HOVER_BAR);
    expect(hovered).toBeLessThan(resting);
    // Big enough to notice, small enough to stay a tint rather than a fill.
    expect(resting - hovered).toBeGreaterThanOrEqual(10);
    expect(hovered).toBeGreaterThan(180);
  });

  it('lifts the user bar clear of a dark theme background', () => {
    // CC's #373737 sits barely off a black terminal - the message you typed is
    // hard to pick out of the transcript. Both states move up, not down.
    const restyle = createTerminalRestyler(dark);
    expect(restyle(`${BAR}${WHITE}msg`)).toBe(`${LIFTED_BAR}${WHITE}msg`);
    expect(restyle(`${HOVER_BAR}${WHITE}msg`)).toBe(`${LIFTED_HOVER_BAR}${WHITE}msg`);
  });

  it('keeps a dark theme bar lighter than the shade Claude Code ships', () => {
    const restyle = createTerminalRestyler(dark);
    const shade = (seq: string): number =>
      Number(/48;2;(\d+)/.exec(restyle(seq))?.[1] ?? Number.NaN);
    expect(shade(BAR)).toBeGreaterThan(55); // CC's own resting #373737
    expect(shade(HOVER_BAR)).toBeGreaterThan(shade(BAR) + 10);
  });

  it('lifts the message text off the bar under a dark theme', () => {
    // The byte order CC actually emits (captured from a live session): bar
    // background, then the whole message line in #505050. Left alone that is
    // 1.55:1 on CC's own bar - and worse once the bar itself is lifted.
    const restyle = createTerminalRestyler(dark);
    expect(restyle(`${BAR}${BAR_TEXT}❯ selected commit is not saved`)).toBe(
      `${LIFTED_BAR}${LIFTED_BAR_TEXT}❯ selected commit is not saved`,
    );
  });

  it('keeps the message text clear of both bar states', () => {
    const restyle = createTerminalRestyler(dark);
    const shade = (re: RegExp, seq: string): number =>
      Number(re.exec(restyle(seq))?.[1] ?? Number.NaN);
    const text = shade(/38;2;(\d+)/, `${BAR}${BAR_TEXT}x`);
    expect(text - shade(/48;2;(\d+)/, BAR)).toBeGreaterThan(80);
    expect(text - shade(/48;2;(\d+)/, HOVER_BAR)).toBeGreaterThan(60);
  });

  it('only lifts that grey while it is painting on the user bar', () => {
    // #505050 elsewhere is ordinary dim chrome - brightening it everywhere
    // would repaint parts of the TUI this rewrite has no business touching.
    const restyle = createTerminalRestyler(dark);
    expect(restyle(`${BAR_TEXT}dim chrome`)).toBe(`${BAR_TEXT}dim chrome`);
    expect(restyle(`${BAR}${BAR_TEXT}on bar\x1b[49m${BAR_TEXT}off bar`)).toBe(
      `${LIFTED_BAR}${LIFTED_BAR_TEXT}on bar\x1b[49m${BAR_TEXT}off bar`,
    );
  });

  it('leaves the message text alone on a light theme', () => {
    // #505050 on the tinted bar is dark-on-light; it already reads.
    const restyle = createTerminalRestyler(light);
    expect(restyle(`${BAR}${BAR_TEXT}msg`)).toBe(`${GRAY_BAR}${BAR_TEXT}msg`);
  });

  it('derives the dark bar from the theme background, keeping its hue', () => {
    // Dracula's #282a36 is blue-tinted; a flat grey bar would look pasted on.
    const restyle = createTerminalRestyler(() => '#282a36');
    expect(restyle(BAR)).toBe('\x1b[48;2;105;106;114m');
  });

  it("leaves Claude Code's own dark palette alone under a dark theme", () => {
    // The correct, common case: CC in its dark palette on a dark terminal. Only
    // the user bar is re-derived; text, code and dark diff backgrounds stay.
    const restyle = createTerminalRestyler(dark);
    const untouched = `${WHITE}text\x1b[38;2;248;248;242mcode\x1b[48;2;2;40;0m+added`;
    expect(restyle(untouched)).toBe(untouched);
  });

  // The mirror of the light-theme rewrites: on a DARK theme, Claude Code
  // painting its LIGHT palette (it detected the wrong tone, or an app flip it
  // never learned about) is the illegible case - a white user bar, black text,
  // pale diff blocks. These fixtures use the same #000000 theme background, so
  // the derived bar/bar-text land on the same LIFTED_* values as the CC-dark case.
  const LIGHT_BAR = '\x1b[48;2;240;240;240m';
  const LIGHT_HOVER_BAR = '\x1b[48;2;252;252;252m';
  const LIGHT_BAR_TEXT = '\x1b[38;2;0;0;0m';

  it("lifts Claude Code's light-mode user bar clear of a dark theme", () => {
    // The reported symptom: a near-white block with black text sitting on the
    // dark terminal. It must read like the dark-mode bar - same derived shade.
    const restyle = createTerminalRestyler(dark);
    expect(restyle(`${LIGHT_BAR}${LIGHT_BAR_TEXT}msg`)).toBe(`${LIFTED_BAR}${LIFTED_BAR_TEXT}msg`);
    expect(restyle(`${LIGHT_HOVER_BAR}${LIGHT_BAR_TEXT}msg`)).toBe(
      `${LIFTED_HOVER_BAR}${LIFTED_BAR_TEXT}msg`,
    );
  });

  it("remaps Claude Code's light diff backgrounds to its dark ones on a dark theme", () => {
    const restyle = createTerminalRestyler(dark);
    expect(restyle('\x1b[48;2;220;255;220madded')).toBe('\x1b[48;2;2;40;0madded');
    expect(restyle('\x1b[48;2;255;220;220mremoved')).toBe('\x1b[48;2;61;1;0mremoved');
    expect(restyle('\x1b[48;2;178;255;178mnewWord')).toBe('\x1b[48;2;4;71;0mnewWord');
    // A remapped diff background counts as dark: the dark-on-light diff text on
    // it lightens to Monokai, the way a light theme darkens code on its pastels.
    expect(restyle('\x1b[48;2;220;255;220m\x1b[38;2;51;51;51m code')).toBe(
      '\x1b[48;2;2;40;0m\x1b[38;2;248;248;242m code',
    );
  });

  it("paints Claude Code's light-mode selection in its dark selection blue on a dark theme", () => {
    // Full-screen CC draws the mouse selection itself. Its text was already
    // lightened for the dark default, so a pale selection left it white on
    // pale blue - unreadable.
    const restyle = createTerminalRestyler(dark);
    expect(restyle(`\x1b[38;2;0;0;0m\x1b[48;2;180;213;255mpicked`)).toBe(
      `${WHITE}\x1b[48;2;38;79;120mpicked`,
    );
    // And the dark-palette text CC paints after the selection bg lightens too.
    expect(restyle('\x1b[38;2;0;0;0mmore')).toBe(`${WHITE}more`);
  });

  it("paints Claude Code's dark-mode selection in its light selection blue on a light theme", () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle(`${WHITE}\x1b[48;2;38;79;120mpicked`)).toBe(
      `${DARK_TEXT}\x1b[48;2;180;213;255mpicked`,
    );
    expect(restyle(`${WHITE}more`)).toBe(`${DARK_TEXT}more`);
  });

  it("lightens Claude Code's light foregrounds on a dark theme", () => {
    const restyle = createTerminalRestyler(dark);
    expect(restyle('\x1b[38;2;0;0;0mtext')).toBe(`${WHITE}text`); // black text → white
    expect(restyle('\x1b[38;2;51;51;51mcode')).toBe('\x1b[38;2;248;248;242mcode');
    expect(restyle('\x1b[38;2;87;105;247msrc/main.ts')).toBe('\x1b[38;2;177;185;249msrc/main.ts');
    expect(restyle('\x1b[38;2;167;29;93mimport')).toBe('\x1b[38;2;249;38;114mimport');
    expect(restyle('\x1b[38;2;44;122;57mok')).toBe('\x1b[38;2;78;186;101mok');
    expect(restyle('\x1b[38;2;171;43;63merr')).toBe('\x1b[38;2;255;107;128merr');
  });

  it('keeps a black foreground on an app-drawn light background under a dark theme', () => {
    // The mirror of the light-theme "keeps light foregrounds over a dark pill":
    // black text on a genuinely light chip must stay black, only text back on
    // the dark default lightens.
    const restyle = createTerminalRestyler(dark);
    expect(
      restyle(`\x1b[48;2;255;255;255m${LIGHT_BAR_TEXT}Label\x1b[49m${LIGHT_BAR_TEXT}after`),
    ).toBe(`\x1b[48;2;255;255;255m${LIGHT_BAR_TEXT}Label\x1b[49m${WHITE}after`);
  });

  it('rewrites every occurrence in a chunk', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle(`${BAR}a${BAR}b`)).toBe(`${GRAY_BAR}a${GRAY_BAR}b`);
  });

  it('darkens Claude Code code/status foregrounds on the default background', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle('\x1b[38;2;248;248;242mcode')).toBe('\x1b[38;2;56;58;66mcode');
    expect(restyle('\x1b[38;2;249;38;114mimport')).toBe('\x1b[38;2;194;24;91mimport');
    expect(restyle('\x1b[38;2;230;219;116m"str"')).toBe('\x1b[38;2;139;118;20m"str"');
    expect(restyle('\x1b[38;2;255;193;7mwarn')).toBe('\x1b[38;2;154;103;0mwarn');
  });

  it('keeps light foregrounds painted over an app-drawn dark background', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle(`\x1b[48;2;0;0;0m${WHITE}Jump to bottom\x1b[49m${WHITE}after`)).toBe(
      `\x1b[48;2;0;0;0m${WHITE}Jump to bottom\x1b[49m${DARK_TEXT}after`,
    );
    // \x1b[0m also resets the dark-background state.
    expect(restyle(`\x1b[48;2;0;0;0m${WHITE}x\x1b[0m${WHITE}y`)).toBe(
      `\x1b[48;2;0;0;0m${WHITE}x\x1b[0m${DARK_TEXT}y`,
    );
  });

  it('darkens the foreground on the rewritten (light) user bar', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle(`${BAR}${WHITE}msg`)).toBe(`${GRAY_BAR}${DARK_TEXT}msg`);
  });

  it('rewrites dark diff-line backgrounds to pastels', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle('\x1b[48;2;2;40;0madded')).toBe('\x1b[48;2;223;240;216madded');
    expect(restyle('\x1b[48;2;61;1;0mremoved')).toBe('\x1b[48;2;248;222;222mremoved');
    // A remapped diff background counts as light: foregrounds on it darken.
    expect(restyle(`\x1b[48;2;2;40;0m\x1b[38;2;80;200;80m+line`)).toBe(
      '\x1b[48;2;223;240;216m\x1b[38;2;40;130;55m+line',
    );
  });

  it('rewrites diff word-emphasis backgrounds and darkens code text on them', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle('\x1b[48;2;4;71;0mnewWord')).toBe('\x1b[48;2;178;226;165mnewWord');
    expect(restyle('\x1b[48;2;92;2;0moldWord')).toBe('\x1b[48;2;246;198;198moldWord');
    // Monokai code text inside an emphasized word darkens like on any light bg.
    expect(restyle('\x1b[48;2;4;71;0m\x1b[38;2;248;248;242mshowRationale')).toBe(
      '\x1b[48;2;178;226;165m\x1b[38;2;56;58;66mshowRationale',
    );
  });

  it('darkens the periwinkle file-reference foreground', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle('\x1b[38;2;177;185;249msrc/main.ts')).toBe('\x1b[38;2;70;79;187msrc/main.ts');
  });

  it('rewrites colors inside a combined SGR sequence', () => {
    const restyle = createTerminalRestyler(light);
    expect(restyle('\x1b[1;38;2;255;255;255mbold')).toBe('\x1b[1;38;2;51;51;51mbold');
  });

  it('leaves other truecolor sequences untouched', () => {
    const restyle = createTerminalRestyler(light);
    const other = '\x1b[48;2;55;55;56mtext\x1b[38;2;55;55;55m';
    expect(restyle(other)).toBe(other);
  });

  it('rewrites a sequence split across chunks, at every split point', () => {
    const payload = `pre${BAR}msg`;
    const expected = `pre${GRAY_BAR}msg`;
    for (let at = 4; at < 3 + BAR.length; at++) {
      const restyle = createTerminalRestyler(light);
      const joined = restyle(payload.slice(0, at)) + restyle(payload.slice(at));
      expect(joined).toBe(expected);
    }
  });

  it('flushes a held partial that turns out not to match', () => {
    const restyle = createTerminalRestyler(light);
    const first = restyle('x\x1b[48;2;55');
    expect(first).toBe('x'); // partial held back
    expect(first + restyle(';99mrest')).toBe('x\x1b[48;2;55;99mrest');
  });

  it('passes everything through verbatim when disabled', () => {
    const restyle = createTerminalRestyler(off);
    expect(restyle(`a${BAR}b${WHITE}c`)).toBe(`a${BAR}b${WHITE}c`);
  });

  it('flushes the carry when the theme flips to disabled mid-stream', () => {
    let bg: string | null = '#fafafa';
    const restyle = createTerminalRestyler(() => bg);
    expect(restyle('x\x1b[48;2;55')).toBe('x');
    bg = null;
    expect(restyle('y')).toBe('\x1b[48;2;55y');
  });
});
