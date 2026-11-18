import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @xterm/addon-webgl draws every glyph into its texture atlas with
// `ctx.font = `${fontStyle} ${fontWeight} ${size}px ${family}``, and fontStyle
// is '' for upright text - so the shorthand starts with a space. Chromium 156
// (Electron 45) rejects a `font` value with leading whitespace and keeps
// `10px sans-serif`: the atlas glyphs come out tiny while the cells keep their
// measured size, so terminal text renders at about half size with gaps between
// the letters. patches/@xterm__addon-webgl@*.patch drops the space; this test
// fails if an upgrade of the addon ships without it.
const lib = join(
  dirname(createRequire(import.meta.url).resolve('@xterm/addon-webgl/package.json')),
  'lib',
);
const ATLAS_FONT = /_tmpCtx\.font=`([^`]*)px \$\{this\._config\.fontFamily\}`/g;

describe('the WebGL glyph atlas font', () => {
  for (const file of ['addon-webgl.mjs', 'addon-webgl.js']) {
    it(`never starts with a space (${file})`, () => {
      const assignments = [...readFileSync(join(lib, file), 'utf8').matchAll(ATLAS_FONT)];
      expect(assignments).toHaveLength(1);
      // Unpatched: `${style} ${weight} ${size}` - an empty style leaves the
      // leading space. Patched: the style brings its own trailing space.
      expect(assignments[0][1]).toMatch(/^\$\{(\w+)\?\1\+" ":""\}\$\{\w+\} /);
    });
  }
});
