import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every runtime dependency in package.json is used by core code, or is Pro's
 * and on the export's strip list (the official build) - so the public
 * package.json names no package only the official build runs on. A Pro-only
 * dependency added without a strip-list line fails here, before the export
 * ships its name; one nothing imports any more fails too (drop it).
 */

const ROOT = join(__dirname, '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(path, out);
    } else if (/\.(ts|tsx|mts|mjs|css)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('runtime dependencies', () => {
  it('are each used by core, or stripped from the export as Pro-only', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const stripFile = join(ROOT, 'the official build');
    const stripped = new Set(
      existsSync(stripFile)
        ? readFileSync(stripFile, 'utf8')
            .split('\n')
            .map((line) => line.replace(/#.*/, '').trim())
            .filter(Boolean)
        : [],
    );
    const files = [
      ...sources(join(ROOT, 'src')),
      ...sources(join(ROOT, 'scripts')),
      ...['electron.vite.config.ts', 'vitest.config.ts', 'eslint.config.mjs'].map((f) =>
        join(ROOT, f),
      ),
    ];
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const unused = Object.keys(pkg.dependencies).filter(
      (name) => !stripped.has(name) && !new RegExp(`['"]${escape(name)}['"/]`).test(text),
    );
    expect(unused).toEqual([]);
  });
});
