#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations */
// The public tree (a private plan › Export and import):
// every TRACKED file `core-paths.txt` matches, copied into an empty folder.
// An allowlist - a file nobody listed is not exported. Pushes nowhere; the
// dry run (export.yml) checks the copy with scripts/export-check.mjs and
// builds it on its own.
//
// `--strip-deps <file>` (a package name per line, `#` comments - Pro keeps
// the list) removes those packages from the exported package.json and then
// refreshes the exported lockfile with `pnpm install --lockfile-only`, so the
// public tree never names a package only Pro runs on.
//
// The database's one migration history (src/main/db/migrations) is generated
// from core's tables and Pro's (drizzle.config.ts). The copy keeps only what
// touches the tables core's own schema.ts defines - every other statement and
// snapshot entry is dropped (`filterMigrationSql`, `filterSnapshot`), so the
// public tree never shows Pro's tables. Every migration folder gets a neutral
// name (`<timestamp>_core`, or `<timestamp>_other_edition` for one the filter
// emptied, kept as a no-op): a name like `add-jira-filter` would tell. Drizzle
// records a migration by name, and the public app's databases only ever see
// the public names - deterministic, so every export agrees with the last.
//
// Comments and test titles across core cite Pro's code and plans by path
// (`a private plan`, `the official build`) - the
// private tree navigates by them. The copy replaces each such path with a
// neutral phrase (`neutralizeProPaths`); the files that wire the `@pro` alias
// or check the boundary name pro/ in code on purpose (`PRO_PATH_FILES`), so
// only their comment lines are rewritten. export-check.mjs fails on any left.
//
//   node scripts/export-core.mjs --out <empty folder> [--strip-deps <file>]
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreMatcher, parseCorePaths } from './pro-boundary.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The tracked files the allowlist exports, repo-relative POSIX paths. */
export function exportedFiles(root = ROOT) {
  const isCore = coreMatcher(parseCorePaths(readFileSync(join(root, 'core-paths.txt'), 'utf8')));
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
    .split('\0')
    .filter(Boolean);
  // A file deleted in the working tree but still in the index is not copied.
  return tracked.filter((path) => isCore(path) && existsSync(join(root, path)));
}

/** Package names from a strip list: one per line, `#` starts a comment. */
export function parseStripList(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** The public tree's licence (LICENSE); the private package.json names none, Pro is proprietary. */
export const CORE_LICENSE = 'Apache-2.0';

/**
 * package.json text with a `license` field after `version` (after the
 * opening brace when there is none), replacing one already there - by lines,
 * like stripDependencies, so the format check still passes.
 */
export function withLicense(text, license = CORE_LICENSE) {
  const lines = text.split('\n').filter((l) => !/^\s*"license":/.test(l));
  const version = lines.findIndex((l) => /^\s*"version":/.test(l));
  const at = version >= 0 ? version : lines.findIndex((l) => /^\s*\{\s*$/.test(l));
  if (at < 0) {
    // A one-line manifest (`{}`): nothing to keep, so write it out.
    return `${JSON.stringify({ license, ...JSON.parse(text) }, null, 2)}\n`;
  }
  const indent = version >= 0 ? /^(\s*)/.exec(lines[at])[1] : '  ';
  lines.splice(at + 1, 0, `${indent}"license": ${JSON.stringify(license)},`);
  const result = lines.join('\n');
  JSON.parse(result);
  return result;
}

/**
 * package.json text without the named packages in any dependency field. Edits
 * lines rather than re-serializing, so the file keeps the formatting the
 * public tree's format check expects; a removed last entry takes the comma
 * off the line before it.
 */
export function stripDependencies(text, names) {
  const strip = new Set(names);
  const lines = text.split('\n');
  const out = [];
  let field = null;
  for (const line of lines) {
    const open = /^\s*"([^"]+)":\s*\{\s*$/.exec(line);
    if (open) field = DEPENDENCY_FIELDS.includes(open[1]) ? open[1] : null;
    else if (field && /^\s*\},?\s*$/.test(line)) {
      const prev = out.length - 1;
      if (prev >= 0) out[prev] = out[prev].replace(/,\s*$/, '');
      field = null;
    } else if (field) {
      const entry = /^\s*"([^"]+)":/.exec(line);
      if (entry && strip.has(entry[1])) continue;
    }
    out.push(line);
  }
  const result = out.join('\n');
  JSON.parse(result); // a malformed result must fail here, not in the public install
  return result;
}

export function exportTree(out, root = ROOT, { stripDeps = [] } = {}) {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`refusing to export into a folder that is not empty: ${out}`);
  }
  const files = exportedFiles(root);
  for (const path of files) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  neutralizeExportedText(out, files);
  const exported = filterMigrations(out, files);
  if (files.includes('package.json')) {
    const manifest = join(out, 'package.json');
    let text = readFileSync(manifest, 'utf8');
    if (stripDeps.length > 0) text = stripDependencies(text, stripDeps);
    writeFileSync(manifest, withLicense(text));
  }
  return exported;
}

/** Files that name pro/ paths on purpose: they wire the alias or check the boundary. */
export const PRO_PATH_FILES = new Set([
  'electron.vite.config.ts',
  'vitest.config.ts',
  'eslint.config.mjs',
  'drizzle.config.ts',
  'package.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'scripts/pro-boundary.mjs',
  'scripts/pro-paths.mjs',
  'scripts/export-core.mjs',
  'scripts/export-check.mjs',
  'src/main/pro-boundary.test.ts',
  'src/main/export-check.test.ts',
  'src/main/ipc-channels.test.ts',
]);

/** A path into pro/ (`the official build`, `a private plan`) - never `@pro/`, never a bare `pro/`. */
export const PRO_PATH = /(?<![@\w./-])pro\/[\w-](?:[\w.-]*[\w-])?(?:\/[\w-](?:[\w.-]*[\w-])?)*/g;

/**
 * Replace every path into pro/ with a neutral phrase: a plan with "a private
 * plan", the rest with "the official build". Neither holds a quote character:
 * a path also sits inside quoted strings (a test's title), and an apostrophe
 * there ended the string.
 */
export function neutralizeProPaths(text) {
  return text.replace(PRO_PATH, (path) =>
    path.startsWith('pro/docs/') || path.endsWith('.md') ? 'a private plan' : 'the official build',
  );
}

/** A whole-line comment (`//`, `/*`, ` *`, `#`): where an exempt file's citations live. */
export const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*|#)/.test(line);

/** An exempt file keeps its code; only its comment lines are neutralized. */
export function neutralizeProPathComments(text) {
  return text
    .split('\n')
    .map((line) => (isCommentLine(line) ? neutralizeProPaths(line) : line))
    .join('\n');
}

/** Exported files read as text (the rest - icons - are copied as they are). */
const TEXT_FILE =
  /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|py|sh|css|html|txt)$|(?:^|\/)\.(?:gitignore|gitattributes|prettierignore|npmrc)$/;

function neutralizeExportedText(out, files) {
  for (const path of files) {
    if (!TEXT_FILE.test(path)) continue;
    const target = join(out, path);
    const text = readFileSync(target, 'utf8');
    const neutral = PRO_PATH_FILES.has(path)
      ? neutralizeProPathComments(text)
      : neutralizeProPaths(text);
    if (neutral !== text) writeFileSync(target, neutral);
  }
}

const SCHEMA_FILE = 'src/main/db/schema.ts';
const MIGRATIONS = 'src/main/db/migrations/';
const BREAKPOINT = '--> statement-breakpoint';

/** The tables a Drizzle schema file defines (`pgTable('name', ...)`). */
export function tablesDefinedIn(schemaText) {
  return [...schemaText.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Every table a SQL statement names (as its target, an index's, a FK's, a
 * query's), and every index it names by itself (`DROP INDEX "x"`, `ALTER
 * INDEX "x"` name no table - the filter knows which table each index is on).
 */
export function tablesIn(statement) {
  const ref =
    /\b(?:TABLE|ON|INTO|UPDATE|FROM|REFERENCES|JOIN|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"public"\.)?"([^"]+)"/gi;
  return [...statement.matchAll(ref)].map((m) => m[1]);
}

/** The indexes a migration history creates on any of `tables`. */
export function indexesOn(sql, tables) {
  const created =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+(?:ONLY\s+)?(?:"public"\.)?"([^"]+)"/gi;
  return [...sql.matchAll(created)].filter((m) => tables.has(m[2])).map((m) => m[1]);
}

/** What an emptied migration holds: drizzle still records it under its name. */
export const EMPTY_MIGRATION =
  '-- Nothing for this edition: this step changed tables it does not have.\nSELECT 1;\n';

/** The tables a migration history creates (`CREATE TABLE "name"`). */
export function tablesCreatedIn(sql) {
  return [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"public"\.)?"([^"]+)"/gi)].map(
    (m) => m[1],
  );
}

/**
 * A migration.sql without the statements that name a table of `drop`
 * (drizzle writes one statement per breakpoint). A statement that only reads
 * such a table (a backfill) goes too - it is moot without that table. Only
 * names in `drop` count: `EXTRACT(EPOCH FROM "createdAt")` reads a column.
 */
export function filterMigrationSql(sql, drop) {
  const chunks = sql.split(BREAKPOINT);
  const kept = chunks.filter((chunk) => !tablesIn(chunk).some((t) => drop.has(t)));
  if (kept.length === chunks.length) return sql;
  const statements = kept.filter((chunk) => chunk.split('\n').some(isStatementLine));
  if (statements.length === 0) return EMPTY_MIGRATION;
  return `${kept.join(BREAKPOINT).trim()}\n`;
}

const isStatementLine = (line) => line.trim() !== '' && !line.trim().startsWith('--');

/** A drizzle snapshot.json with only the entities of `keep`'s tables (FKs into them too). */
export function filterSnapshot(json, keep) {
  const snapshot = JSON.parse(json);
  snapshot.ddl = snapshot.ddl.filter((entity) => {
    const table = entity.entityType === 'tables' ? entity.name : entity.table;
    if (!keep.has(table)) return false;
    return entity.entityType !== 'fks' || keep.has(entity.tableTo);
  });
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** A migration's public folder name: its timestamp and whether anything of it is left. */
export const publicMigrationName = (folder, emptied) =>
  `${folder.split('_')[0]}_${emptied ? 'other_edition' : 'core'}`;

/**
 * Filter the exported migrations down to the exported schema's tables.
 * Returns the exported paths, emptied migrations under their new names.
 */
function filterMigrations(out, files) {
  if (!files.includes(SCHEMA_FILE)) return files;
  const keep = new Set(tablesDefinedIn(readFileSync(join(out, SCHEMA_FILE), 'utf8')));
  const sqlFiles = files.filter((p) => p.startsWith(MIGRATIONS) && p.endsWith('/migration.sql'));
  const history = sqlFiles.map((p) => readFileSync(join(out, p), 'utf8')).join('\n');
  const dropTables = new Set(tablesCreatedIn(history).filter((t) => !keep.has(t)));
  // Their indexes too: a later DROP / ALTER INDEX names only the index, and
  // kept, it would fail on a free database that never had it.
  const drop = new Set([...dropTables, ...indexesOn(history, dropTables)]);
  for (const path of files) {
    if (!path.startsWith(MIGRATIONS)) continue;
    const target = join(out, path);
    if (path.endsWith('/migration.sql')) {
      writeFileSync(target, filterMigrationSql(readFileSync(target, 'utf8'), drop));
    } else if (path.endsWith('/snapshot.json')) {
      writeFileSync(target, filterSnapshot(readFileSync(target, 'utf8'), keep));
    }
  }
  const renamed = new Map();
  for (const path of sqlFiles) {
    const emptied = readFileSync(join(out, path), 'utf8') === EMPTY_MIGRATION;
    const folder = path.slice(MIGRATIONS.length).split('/')[0];
    const name = publicMigrationName(folder, emptied);
    if (name === folder) continue;
    renameSync(join(out, MIGRATIONS, folder), join(out, MIGRATIONS, name));
    renamed.set(`${MIGRATIONS}${folder}/`, `${MIGRATIONS}${name}/`);
  }
  return files.map((path) => {
    for (const [from, to] of renamed)
      if (path.startsWith(from)) return to + path.slice(from.length);
    return path;
  });
}

/** Re-resolve the exported lockfile against the stripped package.json (no node_modules written). */
export function refreshLockfile(out) {
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: out,
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : null;
  };
  const out = option('--out');
  if (!out) {
    console.error('usage: node scripts/export-core.mjs --out <empty folder> [--strip-deps <file>]');
    process.exit(2);
  }
  const stripFile = option('--strip-deps');
  const stripDeps = stripFile ? parseStripList(readFileSync(stripFile, 'utf8')) : [];
  const files = exportTree(resolve(out), ROOT, { stripDeps });
  console.log(`exported ${files.length} files to ${resolve(out)}`);
  if (stripDeps.length > 0) {
    refreshLockfile(resolve(out));
    console.log(`stripped ${stripDeps.length} Pro-only packages and refreshed the lockfile`);
  }
}
