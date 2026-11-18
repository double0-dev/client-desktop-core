import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkProBoundary,
  coreMatcher,
  globToRegExp,
  moduleReferences,
  parseCorePaths,
} from '../../scripts/pro-boundary.mjs';

// a private plan › decisions 13 and 14: core is the
// allowlist in core-paths.txt, Pro is everything else, and core may reach Pro
// only through the four composition roots.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the core / Pro boundary of this repository', () => {
  it('holds: no core file imports Pro, and Pro never imports the stubs', () => {
    const corePaths = readFileSync(join(repoRoot, 'core-paths.txt'), 'utf8');
    expect(checkProBoundary(repoRoot, corePaths)).toEqual([]);
  });

  it('keeps every composition root on the core list', () => {
    // A root dropped from the list would make its @pro import read as a
    // Pro file importing Pro - silently allowed.
    const isCore = coreMatcher(
      parseCorePaths(readFileSync(join(repoRoot, 'core-paths.txt'), 'utf8')),
    );
    for (const root of [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/src/main.tsx',
      'src/main/daemon/daemon-main.ts',
    ]) {
      expect(isCore(root), root).toBe(true);
    }
  });
});

describe('moduleReferences', () => {
  it('finds every way a file can depend on another', () => {
    // Each line is a form that once slipped past an import-only check
    // somewhere: type-only imports erase at build time but fail the public
    // typecheck, and a mocked path is a hidden dependency of the test.
    const text = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "export { c } from './c';",
      "export * from './d';",
      "import './e.css';",
      "const f = await import('./f');",
      "type G = import('./g').G;",
      "const h = require('./h');",
      "vi.mock('./i', () => ({}));",
      "vi.doMock('./j');",
      "const k = await vi.importActual('./k');",
      "const l = await vi.importMock('./l');",
    ].join('\n');
    expect(
      moduleReferences(text)
        .map((r) => r.specifier)
        .sort(),
    ).toEqual(
      [
        './a',
        './b',
        './c',
        './d',
        './e.css',
        './f',
        './g',
        './h',
        './i',
        './j',
        './k',
        './l',
      ].sort(),
    );
  });
});

describe('globToRegExp', () => {
  it('matches ** across folders, * within one segment', () => {
    expect(globToRegExp('src/**').test('src/main/index.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('resources/icon.png').test('resources/icon-dev.png')).toBe(false);
  });
});

describe('checkProBoundary over a scratch tree', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'double0-pro-boundary-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it('reports each kind of violation and nothing that is allowed', () => {
    const dir = tree({
      'src/core/ok.ts': "import { x } from './other';\nimport { y } from 'some-package';",
      'src/core/other.ts': 'export const x = 1;',
      // Allowed: a root importing its own entry.
      'src/main/index.ts': "import { proMain } from '@pro/main';",
      // A root importing ANOTHER root's entry.
      'src/preload/index.ts': "import { proRenderer } from '@pro/renderer';",
      // A plain core file importing @pro.
      'src/core/sneaky.ts': "import { proMain } from '@pro/main';",
      // Core reaching into pro/ by a relative path - as a type and as a mock.
      'src/core/types.ts': "import type { Feature } from '../../pro/main/feature';",
      'src/core/mocked.test.ts': "vi.mock('../../pro/main/feature');",
      // Core importing a src file that is NOT on the list (Pro not yet moved).
      'src/legacy/jira.ts': 'export const jira = 1;',
      'src/core/uses-legacy.ts': "import { jira } from '../legacy/jira';",
      // Pro importing a stub twin.
      'pro/main/feature.ts': "import { proMain } from '../../src/pro-stub/main';",
      'src/pro-stub/main.ts': 'export const proMain = {};',
      // Pro importing core is fine.
      'pro/main/ok.ts': "import { x } from '../../src/core/other';",
    });
    const corePaths = ['src/core/**', 'src/main/**', 'src/preload/**', 'src/pro-stub/**'].join(
      '\n',
    );
    const found = checkProBoundary(dir, corePaths).map((v) => `${v.file} -> ${v.specifier}`);
    expect(found.sort()).toEqual(
      [
        'src/preload/index.ts -> @pro/renderer',
        'src/core/sneaky.ts -> @pro/main',
        'src/core/types.ts -> ../../pro/main/feature',
        'src/core/mocked.test.ts -> ../../pro/main/feature',
        'src/core/uses-legacy.ts -> ../legacy/jira',
        'pro/main/feature.ts -> ../../src/pro-stub/main',
      ].sort(),
    );
  });

  it('reads a file with a raw NUL byte (plain grep would skip it)', () => {
    const dir = tree({
      'src/core/nul.ts': "const key = `a\u0000b`;\nimport { x } from '../../pro/main/x';",
    });
    expect(checkProBoundary(dir, 'src/core/**')).toHaveLength(1);
  });
});
