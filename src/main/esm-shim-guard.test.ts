import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// electron-vite inserts main's ESM `__dirname` shim after the LAST line-start
// `import … from '…'` in a module. A script embedded in a template string
// (a generated plugin, a hook) whose own line starts with `import` pulls the
// shim into that string, and the whole main bundle dies at launch on
// `__dirname is not defined` - only on a fresh `pnpm dev`, never in a test.
const MAIN = __dirname;
// Pro's main and daemon code is bundled into main too (a private plan › M7):
// the same rule holds there when the tree has it.
const PRO = join(__dirname, '../../pro');
const ROOTS = [MAIN, ...['main', 'daemon'].map((d) => join(PRO, d)).filter((d) => existsSync(d))];
const FIRST_STATEMENT =
  /^(const|let|var|function|class|async function|export (const|let|function|class|default|async))\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('main sources', () => {
  it('never start a line with import after the first statement', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const start = lines.findIndex((l) => FIRST_STATEMENT.test(l));
      if (start < 0) continue;
      lines.forEach((l, i) => {
        if (i > start && /^import\b/.test(l)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
