import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  channelsIn,
  checkExport,
  checkFeatureWords,
  checkMigrations,
  checkPath,
  checkStrippedDeps,
  checkText,
  featureWordReport,
  parseDenylist,
  proChannels,
  tokenHash,
} from '../../scripts/export-check.mjs';
import {
  EMPTY_MIGRATION,
  publicMigrationName,
  exportTree,
  exportedFiles,
  filterMigrationSql,
  filterSnapshot,
  indexesOn,
  neutralizeProPathComments,
  neutralizeProPaths,
  parseStripList,
  stripDependencies,
  withLicense,
  tablesCreatedIn,
  tablesDefinedIn,
  tablesIn,
} from '../../scripts/export-core.mjs';

// a private plan › Export and import: the export copies
// the core-paths.txt allowlist and the leak check is the second line behind
// it. This file is itself exported, so every "bad" value below is assembled
// at runtime - written out whole, the real check would flag this test.
const HOME = '/Users/';
const someonesHome = `${HOME}someone/project`;
const checkout = `/Applications/${'Development'}/double0`;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'export-check-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const rules = (findings: { rule: string }[]): string[] => findings.map((f) => f.rule);

describe('checkPath', () => {
  it('refuses pro/, a Pro changelog and env files, and nothing else', () => {
    expect(checkPath('pro/main/index.ts')).toBe('a pro/ path');
    expect(checkPath('releases/1.0.0-pro.md')).toBe('a Pro changelog');
    expect(checkPath('.env')).toBe('an env file');
    expect(checkPath('src/.env.local')).toBe('an env file');
    // The stubs share the prefix but are core.
    expect(checkPath('src/pro-stub/main.ts')).toBeNull();
    expect(checkPath('releases/1.0.0.md')).toBeNull();
    expect(checkPath('.env.example.md')).toBe('an env file');
  });
});

describe('checkText - @pro', () => {
  const spec = `'@pro/${'main'}'`;

  it('flags a quoted @pro specifier outside the files that wire the alias', () => {
    expect(rules(checkText('src/main/terminal.ts', `import x from ${spec};`, null))).toEqual([
      '@pro',
    ]);
  });

  it('allows it in a composition root and the build configs', () => {
    expect(checkText('src/main/index.ts', `import x from ${spec};`, null)).toEqual([]);
    expect(checkText('electron.vite.config.ts', `alias: { ${spec}: x }`, null)).toEqual([]);
  });

  it('leaves prose that names the seam in backticks alone', () => {
    expect(checkText('src/main/edition.ts', '// imports `@pro/main` only', null)).toEqual([]);
  });
});

describe('paths into pro/', () => {
  // Built at runtime: written whole, this file (exported) would hold them.
  const plan = ['pro', 'docs', 'plan', '21-demo.md'].join('/');
  const module = ['pro', 'main', 'demo.ts'].join('/');

  it('neutralizes plan and module paths, keeps @pro, a bare pro/ and sentence ends', () => {
    expect(neutralizeProPaths(`// see ${plan} › 3, and ${module}.`)).toBe(
      '// see a private plan › 3, and the official build.',
    );
    // Inside a quoted string (a test's title) the result must stay one string.
    expect(neutralizeProPaths(`describe('gadgets (${plan} › 4)', f);`)).toBe(
      "describe('gadgets (a private plan › 4)', f);",
    );
    const kept = `import x from '${['@pro', 'main'].join('/')}'; // the pro/ folder, src/pro-stub/main.ts`;
    expect(neutralizeProPaths(kept)).toBe(kept);
  });

  it('rewrites only the comment lines of a file that wires the alias', () => {
    const text = `// wired from ${module}\nconst f = resolve('${module}');`;
    expect(neutralizeProPathComments(text)).toBe(
      `// wired from the official build\nconst f = resolve('${module}');`,
    );
  });

  it('fails on a path left in code, and in a wiring file only on its comments', () => {
    expect(rules(checkText('src/x.ts', `const p = '${module}';`, null))).toEqual(['pro path']);
    expect(checkText('vitest.config.ts', `const p = '${module}';`, null)).toEqual([]);
    expect(rules(checkText('vitest.config.ts', `// see ${plan}`, null))).toEqual(['pro path']);
  });
});

describe('checkText - denylist', () => {
  it('matches literals and patterns, line by line', () => {
    const denylist = parseDenylist(
      ['# a comment', 'SecretManager', `re:['"](?:demo):[a-zA-Z]`].join('\n'),
    );
    const text = ['const a = 1;', 'new SecretManager();', "invoke('demo:run');"].join('\n');
    expect(checkText('src/x.ts', text, denylist)).toEqual([
      { rule: 'denylist', line: 2, detail: 'SecretManager' },
      { rule: 'denylist', line: 3, detail: "'demo:r" },
    ]);
  });

  it('reads a channel only as a quoted name - not an object key, prose or a storage key', () => {
    // The bug these patterns avoid: a bare `demo:` matched `{ demo: 1 }`
    // and a tool's per-folder key `demo:${folder}` in core code.
    const denylist = parseDenylist(`re:['"\`](?:demo):[a-zA-Z]`);
    expect(checkText('src/x.ts', 'const m = { demo: 1 };', denylist)).toEqual([]);
    expect(checkText('src/x.ts', 'const k = `demo:${folder}`;', denylist)).toEqual([]);
    expect(checkText('src/x.ts', 'const k = `demo:list`;', denylist)).toHaveLength(1);
  });

  it('matches an identity by its hash - any case, accents folded, inside an address', () => {
    // The maintainer's name and addresses are never written down in plain
    // text: the denylist carries their hashes.
    const denylist = parseDenylist(
      [`sha256:${tokenHash('wilson')}`, `sha256:${tokenHash('emmaw@example.com')}`].join('\n'),
    );
    expect(rules(checkText('src/x.ts', '// by Emma WILSON', denylist))).toEqual(['identity']);
    expect(rules(checkText('src/x.ts', '// by Emma Wílson', denylist))).toEqual(['identity']);
    expect(rules(checkText('src/x.ts', 'author: EmmaW@Example.com', denylist))).toEqual([
      'identity',
    ]);
    expect(checkText('src/x.ts', '// by Emma Wilsonian', denylist)).toEqual([]);
    // A finding names the rule, never the matched value.
    expect(checkText('src/x.ts', 'wilson', denylist)[0].detail).not.toContain('wilson');
  });

  // Files are read as bytes. Decoded as latin1 only, a UTF-8 accented letter is
  // two characters that never fold to its base letter - the name written with
  // its diacritics passed the check.
  it('finds an accented name in a UTF-8 file on disk', () => {
    const denylist = [`sha256:${tokenHash('wilson')}`].join('\n');
    for (const spelling of ['Wílson', 'WÍLSON', 'Wiĺson']) {
      const root = tree({ 'src/x.ts': `// by Emma ${spelling}\n` });
      expect(rules(checkExport(root, denylist)), spelling).toEqual(['identity']);
    }
  });
});

describe('checkText - machine paths', () => {
  it("flags a real home folder and the maintainer's checkout", () => {
    expect(rules(checkText('src/x.ts', `'${someonesHome}'`, null))).toEqual(['machine path']);
    expect(rules(checkText('src/x.ts', `'${checkout}/client-desktop'`, null))).toEqual([
      'machine path',
    ]);
  });

  it('flags a Windows home folder, written as prose or inside a string literal', () => {
    // A test fixture's Windows path with the maintainer's account name passed
    // the slash-only rule. Assembled here: this file is exported too.
    const bs = '\\';
    const win = (name: string, sep: string): string => ['C:', 'Users', name].join(sep);
    // In source, a string literal doubles each backslash; prose has one.
    expect(
      rules(checkText('src/x.ts', `'${win('someone', bs + bs)}${bs + bs}file.ts'`, null)),
    ).toEqual(['machine path']);
    expect(rules(checkText('src/x.ts', `'${win('someone', bs + bs)}'`, null))).toEqual([
      'machine path',
    ]);
    expect(rules(checkText('README.md', `${win('someone', bs)}${bs}`, null))).toEqual([
      'machine path',
    ]);
    expect(checkText('src/x.ts', `'${win('emmaw', bs + bs)}${bs + bs}file.ts'`, null)).toEqual([]);
  });

  it("allows the fixture personas' homes, the shared folder and a placeholder", () => {
    for (const name of ['emmaw', 'emmawilson', 'emmaw-old', 'jamesc', 'Shared', 'x']) {
      expect(checkText('src/x.ts', `'${HOME}${name}/acme'`, null), name).toEqual([]);
    }
  });
});

describe('Pro channels', () => {
  // A channel kept in a constant and passed by name was invisible to the
  // literal match, so a core file naming it passed the leak check.
  it('resolves a channel passed by a constant', () => {
    const text = [
      "const OPEN = 'demo:open';",
      'ipc.handle(OPEN, open);',
      'const CHANNELS = [OPEN, "demo:close"] as const;',
    ].join('\n');
    expect(channelsIn(text).sort()).toEqual(['demo:close', 'demo:open']);
  });

  it("reads the channels off Pro's handlers, bridges and CHANNELS arrays", () => {
    const text = [
      "ipc.handle('demo:list', list);",
      "ipcMain.on('demo:watch', watch);",
      "ipcRenderer.invoke('demo:get', id);",
      "win.webContents.send('demo:changed', x);",
      "const CHANNELS = ['demo:a', 'demo:b'] as const;",
      // Not a channel: no area prefix.
      "port.send('ping');",
    ].join('\n');
    expect(channelsIn(text).sort()).toEqual([
      'demo:a',
      'demo:b',
      'demo:changed',
      'demo:get',
      'demo:list',
      'demo:watch',
    ]);
  });

  it('flags a Pro channel left in core as an exact quoted name', () => {
    const root = tree({
      'src/a.ts': "invoke('demo:commit');",
      // A longer core channel that shares the prefix is not the Pro one.
      'src/b.ts': "invoke('demo:commitMessage');",
    });
    expect(checkExport(root, null, ['demo:commit'])).toEqual([
      { path: 'src/a.ts', rule: 'denylist', line: 1, detail: "'demo:commit'" },
    ]);
  });

  it("collects them from pro/main and pro/preload, skipping Pro's tests", () => {
    const pro = tree({
      'main/x.ts': "ipc.handle('demo:main', h);",
      'main/x.test.ts': "ipc.handle('demo:test', h);",
      'preload/x.ts': "ipcRenderer.invoke('demo:bridge');",
    });
    expect(proChannels(pro)).toEqual(['demo:bridge', 'demo:main']);
  });
});

describe('checkExport', () => {
  it('reports the path and every finding inside, and passes a clean tree', () => {
    const root = tree({
      'pro/main/index.ts': 'export {};',
      'src/main/ok.ts': 'export const ok = 1;',
    });
    expect(checkExport(root)).toEqual([
      { path: 'pro/main/index.ts', rule: 'path', line: 0, detail: 'a pro/ path' },
    ]);
    expect(checkExport(tree({ 'src/ok.ts': 'export {};' }))).toEqual([]);
  });
});

describe('exportTree', () => {
  function repo(): string {
    const root = tree({
      'core-paths.txt': 'src/**\npackage.json\n',
      'package.json': '{}',
      'src/a.ts': 'export {};',
      'pro/b.ts': 'export {};',
      'notes.md': 'private',
    });
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, timeout: 30_000 });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q');
    git('add', '.');
    // Untracked: never exported, even under src/.
    writeFileSync(join(root, 'src/untracked.ts'), 'export {};');
    return root;
  }

  it('copies exactly the tracked files the allowlist matches', () => {
    const root = repo();
    expect(exportedFiles(root).sort()).toEqual(['package.json', 'src/a.ts']);
    const out = join(root, '..', `${root.split('/').pop()}-out`);
    scratch.push(out);
    expect(exportTree(out, root).sort()).toEqual(['package.json', 'src/a.ts']);
    expect(readFileSync(join(out, 'src/a.ts'), 'utf8')).toBe('export {};');
    expect(checkExport(out)).toEqual([]);
  });

  it('refuses a folder that already holds files', () => {
    const root = repo();
    const out = tree({ 'left-over.txt': 'x' });
    expect(() => exportTree(out, root)).toThrow(/not empty/);
  });
});

// Packages only Pro runs on leave the exported package.json (Pro keeps the
// list, the official build). The names here are made up.
const MANIFEST = `{
  "name": "app",
  "scripts": {
    "paid-sdk": "echo a script named like a package stays"
  },
  "dependencies": {
    "@acme/paid-sdk": "1.0.0",
    "react": "^19.0.0",
    "paid-sdk": "^2.0.0"
  },
  "devDependencies": {
    "vitest": "^4.0.0",
    "paid-sdk-cli": "^1.0.0"
  },
  "pnpm": {
    "packageExtensions": {
      "paid-sdk": { "peerDependenciesMeta": {} }
    }
  }
}
`;

describe('withLicense', () => {
  // The public tree is Apache-2.0 (LICENSE); the private package.json names no
  // licence - Pro is proprietary - so only the exported copy gets the field.
  const PKG = '{\n  "name": "double0-desktop",\n  "version": "0.8.4",\n  "private": true\n}\n';

  it('puts the licence right after the version, keeping the formatting', () => {
    expect(withLicense(PKG)).toBe(
      '{\n  "name": "double0-desktop",\n  "version": "0.8.4",\n  "license": "Apache-2.0",\n  "private": true\n}\n',
    );
  });

  it('replaces a licence that is already there instead of adding a second', () => {
    const once = withLicense(PKG, 'MIT');
    expect(JSON.parse(withLicense(once)).license).toBe('Apache-2.0');
    expect(withLicense(once).match(/"license"/g)).toHaveLength(1);
  });

  it('opens the manifest with the licence when it has no version', () => {
    expect(JSON.parse(withLicense('{\n  "name": "x"\n}\n'))).toEqual({
      license: 'Apache-2.0',
      name: 'x',
    });
  });
});

describe('stripDependencies', () => {
  it('removes the listed packages from the dependency fields only', () => {
    const out = stripDependencies(MANIFEST, ['@acme/paid-sdk', 'paid-sdk', 'paid-sdk-cli']);
    const parsed = JSON.parse(out) as Record<string, Record<string, unknown>>;
    expect(parsed.dependencies).toEqual({ react: '^19.0.0' });
    expect(parsed.devDependencies).toEqual({ vitest: '^4.0.0' });
    // A script or a pnpm setting with the same name is not a dependency.
    expect(parsed.scripts['paid-sdk']).toBeDefined();
    expect(parsed.pnpm.packageExtensions).toHaveProperty('paid-sdk');
  });

  // The last entry of a field leaving must take the comma off the one before,
  // or the public install fails on invalid JSON.
  it('keeps valid JSON when the last entry of a field goes', () => {
    const out = stripDependencies(MANIFEST, ['paid-sdk', 'paid-sdk-cli']);
    expect(out).toContain('"react": "^19.0.0"\n  },');
    expect(out).toContain('"vitest": "^4.0.0"\n  },');
  });

  it('leaves every other line as it was, for the public format check', () => {
    const out = stripDependencies(MANIFEST, ['@acme/paid-sdk']);
    expect(out).toBe(MANIFEST.replace('    "@acme/paid-sdk": "1.0.0",\n', ''));
    expect(stripDependencies(MANIFEST, ['not-there'])).toBe(MANIFEST);
  });
});

describe('parseStripList', () => {
  it('reads one name per line and skips comments and blanks', () => {
    expect(parseStripList('# Pro only\n@acme/paid-sdk\n\npaid-sdk  # trailing note\n')).toEqual([
      '@acme/paid-sdk',
      'paid-sdk',
    ]);
  });
});

describe('checkStrippedDeps', () => {
  const lock = (importer: string, packages: string): string =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${importer}\npackages:\n\n${packages}\n`;

  it('flags a listed package the manifest or the lockfile importers still ask for', () => {
    const root = tree({
      'package.json': MANIFEST,
      'pnpm-lock.yaml': lock(
        "      '@acme/paid-sdk':\n        specifier: 1.0.0\n        version: 1.0.0",
        '',
      ),
    });
    expect(checkStrippedDeps(root, ['@acme/paid-sdk']).map((f) => [f.path, f.detail])).toEqual([
      ['package.json', 'dependencies › @acme/paid-sdk'],
      ['pnpm-lock.yaml', 'importers › @acme/paid-sdk'],
    ]);
  });

  // Another package may still depend on it; only what the project itself asks
  // for counts.
  it('ignores a listed package that appears only in the packages section', () => {
    const root = tree({
      'package.json': stripDependencies(MANIFEST, ['@acme/paid-sdk']),
      'pnpm-lock.yaml': lock(
        '      react:\n        specifier: ^19.0.0\n        version: 19.0.0',
        "  '@acme/paid-sdk@1.0.0':\n    resolution: {integrity: sha512-x}",
      ),
    });
    expect(checkStrippedDeps(root, ['@acme/paid-sdk'])).toEqual([]);
  });
});

describe('checkFeatureWords', () => {
  const WORDS = '# a comment\nGadget board\nre:\\b[Ww]idgets?\\b\n';

  it('reports each word once per line, with its line, in code and comments alike', () => {
    const root = tree({
      'src/a.ts':
        'export const x = 1;\n// opens the Gadget board, widgets and a widget\nwidget();\n',
      // A word inside a longer one is not the word.
      'src/ok.ts': 'export const gadgetry = 1; // widgetry, a gadget board\n',
    });
    expect(
      checkFeatureWords(root, WORDS)
        .map((f) => [f.path, f.line, f.detail])
        .sort(),
    ).toEqual(
      [
        ['src/a.ts', 2, 'Gadget board'],
        ['src/a.ts', 2, '\\b[Ww]idgets?\\b'],
        ['src/a.ts', 3, '\\b[Ww]idgets?\\b'],
      ].sort(),
    );
  });

  // The lockfile names packages, not features; build output is not exported.
  it('skips the lockfile and build output folders', () => {
    const root = tree({
      'pnpm-lock.yaml': 'widget: 1\n',
      'dist-core/a.txt': 'widget\n',
      'out/main/index.js': 'widget\n',
    });
    expect(checkFeatureWords(root, WORDS)).toEqual([]);
  });

  it('counts per word and per file, most first', () => {
    const report = featureWordReport([
      { path: 'b.ts', rule: 'feature word', line: 1, detail: 'widget' },
      { path: 'a.ts', rule: 'feature word', line: 1, detail: 'widget' },
      { path: 'a.ts', rule: 'feature word', line: 1, detail: 'Gadget board' },
    ]);
    expect(report.split('\n')).toEqual([
      'feature words: 3 finding(s) on 2 line(s)',
      '      2  widget',
      '      1  Gadget board',
      'by file:',
      '      2  a.ts',
      '      1  b.ts',
    ]);
  });

  // The dry run reports until the core is clean, then the rule fails it.
  it('fails the command only without --report-feature-words', () => {
    const root = tree({ 'src/a.ts': '// a widget\n' });
    const words = join(tree({ 'words.txt': WORDS }), 'words.txt');
    const run = (...extra: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/export-check.mjs'), root, '--feature-words', words, ...extra],
        { encoding: 'utf8', timeout: 30_000 },
      );
    const failing = run();
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('src/a.ts:1  [feature word]');
    const reporting = run('--report-feature-words');
    expect(reporting.status).toBe(0);
    expect(reporting.stdout).toContain('feature words: 1 finding(s) on 1 line(s)');
  });
});

// The migration history holds every table of the official build; the copy
// keeps only the tables core's schema defines. Table names here are made up.
const BREAK = '--> statement-breakpoint';
const GADGETS_SQL = [
  'CREATE TABLE "gadgets" (\n\t"id" uuid PRIMARY KEY,\n\t"widgetId" uuid NOT NULL\n);\n',
  '\nCREATE INDEX "gadgets_widgetId_idx" ON "gadgets" ("widgetId");',
  '\nALTER TABLE "gadgets" ADD CONSTRAINT "gadgets_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "public"."widgets"("id") ON DELETE CASCADE;',
].join(BREAK);
const MIXED_SQL = [
  'ALTER TABLE "widgets" ADD COLUMN "sortOrder" double precision DEFAULT 0 NOT NULL;',
  '\n-- Seed the order from the creation time.\nUPDATE "widgets" SET "sortOrder" = -EXTRACT(EPOCH FROM "createdAt") * 1000;',
  '\nUPDATE "widgets" SET "done" = true\nWHERE "id" IN (SELECT "widgetId" FROM "gadgets");\n',
].join(BREAK);

describe('migration filtering', () => {
  const drop = new Set(['gadgets']);

  it('reads the tables a schema defines and a history creates', () => {
    expect(tablesDefinedIn("pgTable('widgets', {})\npgTable(\n  'notes',\n  {})")).toEqual([
      'widgets',
      'notes',
    ]);
    expect(tablesCreatedIn(GADGETS_SQL)).toEqual(['gadgets']);
    // The index's own name too, for a later DROP INDEX that names no table.
    expect(tablesIn('CREATE INDEX "i" ON "gadgets" ("widgetId")')).toEqual(['i', 'gadgets']);
  });

  it("empties a migration that only touched another edition's tables", () => {
    expect(filterMigrationSql(GADGETS_SQL, drop)).toBe(EMPTY_MIGRATION);
  });

  // A backfill that reads a dropped table goes with it; a column read with
  // FROM (EXTRACT(EPOCH FROM "createdAt")) is not a table and must stay.
  it('keeps core statements and drops the ones naming a dropped table', () => {
    const out = filterMigrationSql(MIXED_SQL, drop);
    expect(out).toContain('ADD COLUMN "sortOrder"');
    expect(out).toContain('EXTRACT(EPOCH FROM "createdAt")');
    expect(out).not.toContain('gadgets');
    expect(out.split(BREAK)).toHaveLength(2);
  });

  // DROP INDEX names no table; kept, it fails on a free database that never
  // had the index.
  it("drops a later statement that names only another edition's index", () => {
    const indexes = indexesOn(GADGETS_SQL, drop);
    expect(indexes).toEqual(['gadgets_widgetId_idx']);
    const later = [
      'DROP INDEX "gadgets_widgetId_idx";',
      '\nCREATE INDEX "widgets_name_idx" ON "widgets" ("name");',
    ].join(BREAK);
    const out = filterMigrationSql(later, new Set([...drop, ...indexes]));
    expect(out).not.toContain('gadgets');
    expect(out).toContain('widgets_name_idx');
  });

  it('leaves a core-only migration byte-identical', () => {
    const core = MIXED_SQL.split(BREAK).slice(0, 2).join(BREAK);
    expect(filterMigrationSql(core, drop)).toBe(core);
  });

  it("drops another edition's tables, columns, indexes and FKs from a snapshot", () => {
    const snapshot = JSON.stringify({
      id: 'a',
      prevIds: [],
      ddl: [
        { entityType: 'tables', name: 'widgets' },
        { entityType: 'tables', name: 'gadgets' },
        { entityType: 'columns', table: 'widgets', name: 'id' },
        { entityType: 'columns', table: 'gadgets', name: 'id' },
        { entityType: 'indexes', table: 'gadgets', name: 'gadgets_widgetId_idx' },
        { entityType: 'fks', table: 'gadgets', tableTo: 'widgets', name: 'gadgets_widgetId_fkey' },
      ],
      renames: [],
    });
    const out = JSON.parse(filterSnapshot(snapshot, new Set(['widgets'])));
    expect(out.ddl).toEqual([
      { entityType: 'tables', name: 'widgets' },
      { entityType: 'columns', table: 'widgets', name: 'id' },
    ]);
  });

  // A descriptive name (`add-jira-filter-to-projects`) would tell what the
  // official build adds, whatever the statements left in it.
  it('gives every migration a neutral public name from its timestamp', () => {
    expect(publicMigrationName('20260806102057_talented_runaways', true)).toBe(
      '20260806102057_other_edition',
    );
    expect(publicMigrationName('20261004213858_chat_runtime', false)).toBe('20261004213858_core');
  });

  it('checks every path against the denylist, not only the contents', () => {
    const root = tree({ [`src/${['secret', 'feature'].join('-')}/x.ts`]: 'export {};' });
    const findings = checkExport(root, ['secret-feature'].join('\n'));
    expect(findings.map((f) => f.rule)).toEqual(['path name (denylist)']);
  });

  it('flags a table the exported schema does not define', () => {
    const root = tree({
      'src/main/db/schema.ts': "pgTable('widgets', {})",
      'src/main/db/migrations/1_a/migration.sql': GADGETS_SQL,
      'src/main/db/migrations/1_a/snapshot.json': JSON.stringify({
        ddl: [{ entityType: 'tables', name: 'gadgets' }],
      }),
    });
    expect(checkMigrations(root).map((f) => f.detail)).toEqual([
      'creates gadgets, which src/main/db/schema.ts does not define',
      'lists gadgets, which src/main/db/schema.ts does not define',
    ]);
  });
});

// They list tracked files with git: a copy without a repository (a "Download
// ZIP") has nothing to export, so they skip there.
describe.skipIf(!existsSync(join(repoRoot, '.git')))('the export of this repository', () => {
  // The public tree must build without the packages Pro strips: no core file
  // may import one (the dry run's typecheck would fail later and slower).
  it('strips every Pro-only package and no core file imports one', () => {
    const list = join(repoRoot, 'pro', 'export-strip-deps.txt');
    if (!existsSync(list)) return; // the public tree has nothing to strip
    const names = parseStripList(readFileSync(list, 'utf8'));
    expect(names.length).toBeGreaterThan(0);
    const out = join(mkdtempSync(join(tmpdir(), 'export-strip-')), 'tree');
    scratch.push(dirname(out));
    const files = exportTree(out, repoRoot, { stripDeps: names });
    // The lockfile is refreshed by the CLI (pnpm), not here.
    expect(checkStrippedDeps(out, names).filter((f) => f.path === 'package.json')).toEqual([]);
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const imports = new RegExp(
      `(?:from\\s+|import\\s+|import\\(\\s*|require\\(\\s*|vi\\.mock\\(\\s*)['"](?:${names.map(escape).join('|')})(?:['"/])`,
    );
    const offenders = files.filter(
      (f) => /\.(?:[cm]?[jt]sx?)$/.test(f) && imports.test(readFileSync(join(out, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('passes the leak check', () => {
    // The dry run (export.yml) does this before every build of the public
    // tree; here it fails the private gate first. The denylist and Pro's
    // channels exist only in the private tree - the public one checks the
    // rest.
    const out = join(mkdtempSync(join(tmpdir(), 'export-core-')), 'tree');
    scratch.push(dirname(out));
    exportTree(out, repoRoot);
    const pro = join(repoRoot, 'pro');
    const denylist = join(pro, 'export-denylist.txt');
    const findings = checkExport(
      out,
      existsSync(denylist) ? readFileSync(denylist, 'utf8') : null,
      existsSync(pro) ? proChannels(pro) : [],
    );
    expect(findings).toEqual([]);
  });

  // No Pro feature's name in the public tree (a private plan › C7): core's
  // seams are named by what they plug in, its tests use stand-ins. A finding
  // here is a word that leaked - rename it, or move its code to Pro.
  it('names no Pro feature', () => {
    const words = join(repoRoot, 'pro', 'export-feature-words.txt');
    if (!existsSync(words)) return; // the public tree carries no word list
    const out = join(mkdtempSync(join(tmpdir(), 'export-words-')), 'tree');
    scratch.push(dirname(out));
    exportTree(out, repoRoot);
    expect(checkFeatureWords(out, readFileSync(words, 'utf8'))).toEqual([]);
  });

  // The public app migrates its database with exactly this history: it must
  // apply on a fresh database and leave core's tables, no others.
  it('migrates a fresh database to exactly the tables core defines', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'export-migrate-')), 'tree');
    scratch.push(dirname(out));
    exportTree(out, repoRoot);
    const folder = join(out, 'src/main/db/migrations');
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const client = new PGlite();
    try {
      await migrate(drizzle({ client }), { migrationsFolder: folder });
      const { rows } = await client.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      const core = tablesDefinedIn(readFileSync(join(out, 'src/main/db/schema.ts'), 'utf8'));
      expect(rows.map((r) => r.tablename)).toEqual([...core].sort());
      const { rows: applied } = await client.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(applied[0].n).toBe(readdirSync(folder).length);
    } finally {
      await client.close();
    }
  });
});
