/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in pro-boundary.d.mts */
// The core / Pro boundary (a private plan › decisions 13
// and 14). Core is an ALLOWLIST - `core-paths.txt` at the repository root -
// and Pro is everything else. The rules this checks:
//
//   1. A core file references `@pro/*` only from one of the four composition
//      roots, and each root only its own entry.
//   2. A core file never references a file that is not core (a path inside
//      pro/, or a file in src/ that is not on the list).
//   3. A Pro file never references the stub twins in src/pro-stub/.
//
// "References" means every module specifier, not only `import` statements:
// `import type`, `export … from`, side-effect imports, dynamic `import()`,
// `require()` and the test helpers `vi.mock` / `vi.doMock` /
// `vi.importActual` / `vi.importMock` - a core test that mocks a Pro path
// depends on it as much as one that imports it. Files are read as bytes
// (latin1), never through grep: one of Pro's modules carries a raw NUL
// and plain grep skips such a file silently (CLAUDE.md gotcha).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** The four composition roots and the one `@pro/*` entry each may import. */
export const COMPOSITION_ROOTS = {
  'src/main/index.ts': '@pro/main',
  'src/preload/index.ts': '@pro/preload',
  'src/renderer/src/main.tsx': '@pro/renderer',
  'src/main/daemon/daemon-main.ts': '@pro/daemon',
};

/**
 * Files whose module specifiers are fixture TEXT, not dependencies: the
 * boundary's own test writes violating imports into a scratch tree.
 */
const FIXTURE_FILES = new Set(['src/main/pro-boundary.test.ts']);

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'coverage', '.git']);
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '.d.ts', '/index.ts', '/index.tsx'];

/** `core-paths.txt` → glob list (blank lines and `#` comments dropped). */
export function parseCorePaths(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/** A glob over repo-relative POSIX paths: `**` any depth, `*` one segment. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more whole segments; a trailing `**` anything.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function coreMatcher(globs) {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

/**
 * Every module specifier in a source text, with the kind of reference.
 * Comment-stripping is deliberately crude (block and line comments outside
 * strings are not tracked): a specifier written inside a comment is reported
 * too, which only ever errs on the side of a false alarm.
 */
export function moduleReferences(text) {
  const found = [];
  const patterns = [
    ['from', /\bfrom\s*['"]([^'"\n]+)['"]/g],
    ['import', /\bimport\s*['"]([^'"\n]+)['"]/g],
    ['dynamic-import', /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g],
    ['require', /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g],
    ['vi', /\bvi\s*\.\s*(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]/g],
  ];
  for (const [kind, re] of patterns) {
    for (const match of text.matchAll(re)) found.push({ kind, specifier: match[1] });
  }
  return found;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (SOURCE_FILE.test(entry.name)) out.push(rel);
  }
}

/** Repo-relative POSIX path of a specifier resolved from `fromFile`, or null for a package. */
function resolveSpecifier(root, fromFile, specifier) {
  let base;
  if (specifier.startsWith('@renderer/'))
    base = `src/renderer/src/${specifier.slice('@renderer/'.length)}`;
  else if (specifier.startsWith('@main/')) base = `src/main/${specifier.slice('@main/'.length)}`;
  else if (specifier.startsWith('.'))
    base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  else return null;
  // `?asset`, `?worker`, `?raw` suffixes name the file before them.
  base = base.replace(/\?.*$/, '');
  for (const ext of RESOLVE_EXTS) {
    const candidate = `${base}${ext}`;
    try {
      if (statSync(join(root, candidate)).isFile()) return candidate;
    } catch {
      // try the next extension
    }
  }
  return base;
}

/**
 * Walks src/ and pro/ under `root` and returns every boundary violation as
 * `{ file, specifier, kind, rule }`. Empty = the boundary holds.
 */
export function checkProBoundary(root, corePathsText) {
  const isCore = coreMatcher(parseCorePaths(corePathsText));
  const files = [];
  walk(root, 'src', files);
  walk(root, 'pro', files);
  const violations = [];
  for (const file of files) {
    if (FIXTURE_FILES.has(file)) continue;
    const core = isCore(file);
    const pro = file.startsWith('pro/');
    const text = readFileSync(join(root, file), 'latin1');
    for (const { kind, specifier } of moduleReferences(text)) {
      if (specifier.startsWith('@pro/')) {
        if (pro) continue;
        if (COMPOSITION_ROOTS[file] !== specifier) {
          violations.push({
            file,
            specifier,
            kind,
            rule: 'only a composition root imports its own @pro entry',
          });
        }
        continue;
      }
      const target = resolveSpecifier(root, file, specifier);
      if (target === null) continue;
      if (pro) {
        if (target.startsWith('src/pro-stub/')) {
          violations.push({ file, specifier, kind, rule: 'Pro never imports the core stubs' });
        }
        continue;
      }
      if (core && !isCore(target)) {
        violations.push({
          file,
          specifier,
          kind,
          rule: `core imports only core (${target} is not on core-paths.txt)`,
        });
      }
    }
  }
  return violations;
}

// CLI: `node scripts/pro-boundary.mjs` from the repository root.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const violations = checkProBoundary(root, readFileSync(join(root, 'core-paths.txt'), 'utf8'));
  for (const v of violations) console.error(`${v.file}: ${v.kind} '${v.specifier}' - ${v.rule}`);
  if (violations.length > 0) process.exit(1);
  console.log('pro boundary holds');
}
