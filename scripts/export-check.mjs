#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations */
// The leak check over an exported tree (a private plan ›
// Export and import) - the second check behind the core-paths.txt allowlist.
// Fails on:
//
//   1. a `pro/` path, or a Pro changelog (`releases/*-pro.md`), or a `.env`;
//   2. a quoted `'@pro/…'` specifier, or any path into pro/ (`the official build`,
//      a Pro plan), outside the files that wire the alias
//      (the four composition roots, the build configs, the boundary's own
//      scripts and test) - prose naming the seam in backticks is fine;
//   3. any line of the denylist (`--denylist <file>`, kept in pro/ - it names
//      what is Pro): a literal is matched as text, `re:<pattern>` as a
//      regular expression (an IPC channel is a string literal `'jira:…'`, while
//      `jira:` alone is also an object key or prose), and `sha256:<hex>` is a
//      word or e-mail address matched by its hash, so the maintainer's
//      identity never has to be written down in plain text;
//   4. every IPC channel Pro registers or calls (`--pro <pro folder>`: read off
//      pro/'s handlers, bridges and CHANNELS arrays) as a quoted literal -
//      a Pro channel in core is Pro code that stayed behind, and the list
//      keeps itself current as features move;
//   5. an absolute path into a real home folder (`/Users/<name>/` that is not
//      a fixture persona's) or the maintainer's checkout;
//   6. a table core's schema does not define, in the exported migrations
//      (a CREATE TABLE, a snapshot entry) - scripts/export-core.mjs filters
//      them out; this proves it did;
//   7. any of the above in a file's PATH (a folder named after a Pro feature);
//   8. a package of the strip list (`--strip-deps <file>`, kept in pro/) still
//      in package.json's dependency fields or in the lockfile's importers -
//      scripts/export-core.mjs removes them; this proves it did;
//   9. a Pro feature word (`--feature-words <file>`, kept in pro/), unless
//      `--report-feature-words` asks for counts only.
//
// Files are read as latin1 bytes, never grep (a raw NUL makes grep skip a
// file silently - CLAUDE.md gotcha).
//
//   node scripts/export-check.mjs <exported tree> [--denylist <file>] [--pro <folder>]
//                                 [--strip-deps <file>]
//                                 [--feature-words <file> [--report-feature-words]]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSITION_ROOTS } from './pro-boundary.mjs';
import {
  PRO_PATH,
  PRO_PATH_FILES,
  isCommentLine,
  parseStripList,
  tablesCreatedIn,
  tablesDefinedIn,
} from './export-core.mjs';

/** Files that legitimately name `@pro/*`: they ARE the alias. */
const PRO_ALIAS_FILES = new Set([
  ...Object.keys(COMPOSITION_ROOTS),
  'electron.vite.config.ts',
  'vitest.config.ts',
  'eslint.config.mjs',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'tsconfig.core.node.json',
  'tsconfig.core.web.json',
  'scripts/pro-paths.mjs',
  'scripts/pro-paths.d.mts',
  'scripts/pro-boundary.mjs',
  'scripts/pro-boundary.d.mts',
  'scripts/export-check.mjs',
  'src/main/pro-boundary.test.ts',
  'src/main/export-check.test.ts',
]);

/**
 * Home folders that name nobody: the fixture personas' (CLAUDE.md › fixture
 * data - Emma Wilson, James Carter), macOS' shared folder, a placeholder.
 */
const FIXTURE_HOME = /^(?:emma[\w-]*|james[\w-]*|Shared|x)$/i;

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'dist-core', 'coverage']);

/** Normalised as the hashes are made: accents folded, lower case. */
export function normaliseToken(token) {
  return token.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokenHash(token) {
  return createHash('sha256').update(normaliseToken(token)).digest('hex');
}

/** `{ literals, patterns, hashes }` from the denylist's text. */
export function parseDenylist(text) {
  const literals = [];
  const patterns = [];
  const hashes = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('sha256:')) hashes.add(line.slice('sha256:'.length).toLowerCase());
    else if (line.startsWith('re:')) patterns.push(new RegExp(line.slice('re:'.length), 'g'));
    else literals.push(line);
  }
  return { literals, patterns, hashes };
}

/** Every word and e-mail address in a text, plus each address' local part and domain. */
function tokensOf(text) {
  const out = new Set();
  const normalised = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  for (const m of normalised.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const address = m[0].toLowerCase();
    out.add(address);
    const [local, domain] = address.split('@');
    out.add(local);
    out.add(domain);
  }
  for (const m of normalised.matchAll(/[A-Za-z0-9]+/g)) out.add(m[0].toLowerCase());
  return out;
}

/** The text of the line holding an offset. */
function lineOf(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The line number (1-based) of an offset. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Every finding in one file's text: `{ rule, line, detail }`. `identityText`
 * is the same file decoded as UTF-8 for the identity pass: the literal scan
 * reads latin1 (a raw NUL must not end it), but there an accented letter is
 * two bytes that never fold to its base letter, so a name written with its
 * diacritics slipped past its hash.
 */
export function checkText(path, text, denylist, identityText = text) {
  const findings = [];
  if (!PRO_ALIAS_FILES.has(path)) {
    for (const m of text.matchAll(/['"]@pro\//g)) {
      findings.push({ rule: '@pro', line: lineAt(text, m.index), detail: '@pro/' });
    }
  }
  // A path into pro/ (a plan, a module) outside the files that wire it -
  // export-core.mjs neutralizes them; one left means it did not.
  for (const m of text.matchAll(PRO_PATH)) {
    // A file that wires the alias names pro/ in its code on purpose; its
    // comments are neutralized like everyone's.
    if (PRO_PATH_FILES.has(path) && !isCommentLine(lineOf(text, m.index))) continue;
    findings.push({ rule: 'pro path', line: lineAt(text, m.index), detail: m[0] });
  }
  if (denylist) {
    for (const literal of denylist.literals) {
      let at = text.indexOf(literal);
      while (at >= 0) {
        findings.push({ rule: 'denylist', line: lineAt(text, at), detail: literal });
        at = text.indexOf(literal, at + literal.length);
      }
    }
    for (const pattern of denylist.patterns) {
      for (const m of text.matchAll(pattern)) {
        findings.push({ rule: 'denylist', line: lineAt(text, m.index), detail: m[0] });
      }
    }
    if (denylist.hashes.size > 0) {
      for (const token of tokensOf(identityText)) {
        if (denylist.hashes.has(tokenHash(token))) {
          const at = identityText.toLowerCase().indexOf(token);
          findings.push({
            rule: 'identity',
            line: at >= 0 ? lineAt(identityText, at) : 0,
            detail: 'a denylisted name or address',
          });
        }
      }
    }
  }
  // `/Users/<name>/` and a Windows `\Users\<name>` - one backslash in prose,
  // two inside a string literal (`'C:\\Users\\<name>'`); a Windows-path test
  // fixture carried the maintainer's account name past the slash-only rule.
  for (const m of text.matchAll(
    /(?:\/|\\{1,2})Users(?:\/|\\{1,2})([A-Za-z0-9._-]+)(?=\/|\\|['"`]|$)/gm,
  )) {
    if (!FIXTURE_HOME.test(m[1])) {
      findings.push({ rule: 'machine path', line: lineAt(text, m.index), detail: m[0] });
    }
  }
  for (const m of text.matchAll(/\/Applications\/Development\//g)) {
    findings.push({ rule: 'machine path', line: lineAt(text, m.index), detail: m[0] });
  }
  return findings;
}

/** Channel names in Pro's main and preload sources. */
export function channelsIn(text) {
  const out = new Set();
  // A channel kept in a constant and passed by name counts too: a
  // `const CHANNEL = 'x:y'` handed to `handle(CHANNEL, ...)` was invisible.
  const constants = new Map();
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g)) {
    constants.set(m[1], m[2]);
  }
  const value = (literal, name) => literal ?? constants.get(name);
  const arg = String.raw`\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*)\s*[,)])`;
  const call = new RegExp(
    String.raw`\b(?:(?:ipc|ipcMain|registrar)\.(?:handle|handleOnce|on|once)|ipcRenderer\.(?:invoke|send|sendSync|on|once)|\.send)` +
      arg,
    'g',
  );
  for (const m of text.matchAll(call)) {
    const channel = value(m[1] ?? m[2], m[3]);
    if (channel) out.add(channel);
  }
  for (const block of text.matchAll(/CHANNELS = \[([\s\S]*?)\]/g)) {
    for (const m of block[1].matchAll(/'([^']+)'|"([^"]+)"|\b([A-Za-z_$][\w$]*)\b/g)) {
      const channel = value(m[1] ?? m[2], m[3]);
      if (channel) out.add(channel);
    }
  }
  // Only `area:name` strings are channels (a `.send('x')` can be anything).
  return [...out].filter((c) => /^[A-Za-z]+:[A-Za-z]/.test(c));
}

/** Every channel Pro's sources name (the official build, the official build). */
export function proChannels(proDir) {
  const out = new Set();
  for (const part of ['main', 'preload']) {
    const dir = join(proDir, part);
    for (const path of walk(dir)) {
      if (!/\.ts$/.test(path) || /\.test\.ts$/.test(path)) continue;
      for (const c of channelsIn(readFileSync(join(dir, path), 'utf8'))) out.add(c);
    }
  }
  return [...out].sort();
}

/** Findings about a path itself. */
export function checkPath(path) {
  if (path === 'pro' || path.startsWith('pro/')) return 'a pro/ path';
  if (/^releases\/[^/]*-pro\.md$/.test(path)) return 'a Pro changelog';
  if (/(^|\/)\.env(\.|$)/.test(path)) return 'an env file';
  return null;
}

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Every finding in an exported tree, as `{ path, rule, line, detail }`.
 * `channels`: Pro's channel names, matched as quoted literals.
 */
const SCHEMA_FILE = 'src/main/db/schema.ts';
const MIGRATIONS = 'src/main/db/migrations';

/** Findings for a table the exported schema does not define, anywhere in its migrations. */
export function checkMigrations(root) {
  const schemaPath = join(root, SCHEMA_FILE);
  const folder = join(root, MIGRATIONS);
  if (!existsSync(schemaPath) || !existsSync(folder)) return [];
  const keep = new Set(tablesDefinedIn(readFileSync(schemaPath, 'utf8')));
  const findings = [];
  for (const name of readdirSync(folder)) {
    const sqlPath = join(folder, name, 'migration.sql');
    if (existsSync(sqlPath)) {
      for (const table of tablesCreatedIn(readFileSync(sqlPath, 'utf8'))) {
        if (!keep.has(table)) {
          findings.push({
            path: `${MIGRATIONS}/${name}/migration.sql`,
            rule: 'migrations',
            line: 0,
            detail: `creates ${table}, which ${SCHEMA_FILE} does not define`,
          });
        }
      }
    }
    const snapshotPath = join(folder, name, 'snapshot.json');
    if (existsSync(snapshotPath)) {
      const { ddl } = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      const tables = new Set(
        ddl.flatMap((e) => [e.entityType === 'tables' ? e.name : e.table, e.tableTo]),
      );
      for (const table of tables) {
        if (table && !keep.has(table)) {
          findings.push({
            path: `${MIGRATIONS}/${name}/snapshot.json`,
            rule: 'migrations',
            line: 0,
            detail: `lists ${table}, which ${SCHEMA_FILE} does not define`,
          });
        }
      }
    }
  }
  return findings;
}

export function checkExport(root, denylistText = null, channels = []) {
  const denylist = parseDenylist(denylistText ?? '');
  for (const c of channels) denylist.literals.push(`'${c}'`, `"${c}"`);
  const findings = [...checkMigrations(root)];
  for (const path of walk(root)) {
    const pathFinding = checkPath(path);
    if (pathFinding) findings.push({ path, rule: 'path', line: 0, detail: pathFinding });
    // The name itself too: a file or folder named after a Pro feature tells
    // as much as its contents would.
    for (const f of checkText('', path, denylist)) {
      if (f.rule === 'pro path') continue; // checkPath already refuses a pro/ path
      findings.push({ path, rule: `path name (${f.rule})`, line: 0, detail: f.detail });
    }
    const bytes = readFileSync(join(root, path));
    const found = checkText(path, bytes.toString('latin1'), denylist, bytes.toString('utf8'));
    for (const f of found) findings.push({ path, ...f });
  }
  return findings;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Findings for stripped packages still in the tree: a dependency field of
 * package.json, or an importer of pnpm-lock.yaml (a package something else
 * still depends on may stay in its `packages:` section - only what the
 * project itself asks for counts).
 */
export function checkStrippedDeps(root, names) {
  const findings = [];
  const manifestPath = join(root, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of names) {
        if (manifest[field] && name in manifest[field]) {
          findings.push({
            path: 'package.json',
            rule: 'strip-deps',
            line: 0,
            detail: `${field} › ${name}`,
          });
        }
      }
    }
  }
  const lockPath = join(root, 'pnpm-lock.yaml');
  if (existsSync(lockPath)) {
    const lock = readFileSync(lockPath, 'utf8');
    const start = lock.indexOf('\nimporters:');
    const end = start < 0 ? -1 : lock.indexOf('\npackages:', start);
    const importers = start < 0 ? '' : lock.slice(start, end < 0 ? undefined : end);
    for (const name of names) {
      const entry = new RegExp(`^\\s+'?${escapeRe(name)}'?:\\s*$`, 'm');
      if (entry.test(importers)) {
        findings.push({
          path: 'pnpm-lock.yaml',
          rule: 'strip-deps',
          line: 0,
          detail: `importers › ${name}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Findings for Pro feature words (`--feature-words <file>`, the denylist's
 * syntax: a literal, or `re:<pattern>`): a Pro feature's name in the public
 * tree, in code, comments or tests. Separate from the denylist
 * because the core still holds such words while a private plan moves the
 * vocabulary out; until then the dry run only reports them
 * (`--report-feature-words`).
 */
export function checkFeatureWords(root, wordsText) {
  const words = parseDenylist(wordsText);
  const findings = [];
  for (const path of walk(root)) {
    if (path === 'pnpm-lock.yaml') continue;
    const text = readFileSync(join(root, path)).toString('latin1');
    // Line starts once per file: lineAt walks from the top for every match.
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const lineOfOffset = (index) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const found = new Map();
    for (const literal of words.literals) {
      for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
        const line = lineOfOffset(at);
        found.set(`${line}\0${literal}`, { line, detail: literal });
      }
    }
    for (const pattern of words.patterns) {
      for (const m of text.matchAll(pattern)) {
        const line = lineOfOffset(m.index);
        found.set(`${line}\0${pattern.source}`, { line, detail: pattern.source });
      }
    }
    for (const f of found.values()) findings.push({ path, rule: 'feature word', ...f });
  }
  return findings;
}

/** A per-word and per-file count of feature-word findings, most first. */
export function featureWordReport(findings) {
  const count = (key) => {
    const map = new Map();
    for (const f of findings) map.set(key(f), (map.get(key(f)) ?? 0) + 1);
    return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  };
  const lines = new Set(findings.map((f) => `${f.path}:${f.line}`)).size;
  return [
    `feature words: ${findings.length} finding(s) on ${lines} line(s)`,
    ...count((f) => f.detail).map(([word, n]) => `  ${String(n).padStart(5)}  ${word}`),
    'by file:',
    ...count((f) => f.path).map(([path, n]) => `  ${String(n).padStart(5)}  ${path}`),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : null;
  };
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? (args.splice(at, 1), true) : false;
  };
  const denylistPath = option('--denylist');
  const proDir = option('--pro');
  const stripFile = option('--strip-deps');
  const wordsFile = option('--feature-words');
  const reportWords = flag('--report-feature-words');
  const tree = args[0];
  if (!tree) {
    console.error(
      'usage: node scripts/export-check.mjs <exported tree> [--denylist <file>] [--pro <folder>] [--strip-deps <file>] [--feature-words <file> [--report-feature-words]]',
    );
    process.exit(2);
  }
  const wordFindings = wordsFile
    ? checkFeatureWords(resolve(tree), readFileSync(wordsFile, 'utf8'))
    : [];
  if (reportWords) console.log(`${featureWordReport(wordFindings)}\n`);
  const channels = proDir ? proChannels(resolve(proDir)) : [];
  const findings = [
    ...checkExport(
      resolve(tree),
      denylistPath ? readFileSync(denylistPath, 'utf8') : null,
      channels,
    ),
    ...(stripFile
      ? checkStrippedDeps(resolve(tree), parseStripList(readFileSync(stripFile, 'utf8')))
      : []),
    ...(reportWords ? [] : wordFindings),
  ];
  for (const f of findings) {
    console.log(`${f.path}${f.line ? `:${f.line}` : ''}  [${f.rule}] ${f.detail}`);
  }
  if (findings.length > 0) {
    console.error(`\nexport check: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log(`export check: clean (${channels.length} Pro channels checked)`);
}
