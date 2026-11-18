/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in third-party-notices.d.mts */
// The open-source notices every packaged app carries (a private plan
// › E): MIT, BSD, Apache and MPL ask that a binary ship each package's licence
// text. Written by the build itself, so every path that runs
// `electron-vite build` (pnpm build, release.sh, the deploy and quality
// workflows) produces it:
//
// - `recordBundled(target)` is a Vite plugin for each build (main, preload,
//   renderer, the renderer's workers): it records the package of every
//   module that ended up in a bundle - React, Monaco, xterm and the rest live
//   only there, never in the archive's node_modules.
// - `writeNotices()` runs last (the renderer build's close): the recorded
//   packages plus the runtime closure the archive ships in node_modules
//   (check-app-asar.mjs › runtimeClosure), each with the licence, notice and
//   third-party-notice files found in its folder, into
//   `out/third-party-notices.json`. Settings › General › Open-source licences
//   reads it (src/main/third-party-notices.ts).
//
// Electron's and Chromium's own licences are not in it: electron-builder moves
// `LICENSE.electron.txt` and `LICENSES.chromium.html` into every package.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The notices file, beside `main/`, `preload/` and `renderer/` in the build's output folder (`out/`). */
export const NOTICES_FILE = 'third-party-notices.json';

/** A licence-ish file in a package's own folder (not its subfolders). */
const NOTICE_FILE = /^(licen[cs]e|copying|notice|third[-_]?party[-_]?notices)([-._].*)?$/i;

/** One file's text is capped: a notices file a package ships whole can be huge. */
const MAX_TEXT_BYTES = 512 * 1024;

/**
 * Shipped without being a module the bundler tracks: Tailwind inlines these
 * into the renderer's CSS through `@import` in globals.css.
 */
export const ALSO_SHIPPED = ['tailwindcss', 'tw-animate-css'];

/**
 * Copyright lines a package's own metadata does not carry: the
 * `@codingame/monaco-vscode-*` packages are built from VS Code's source and
 * ship no licence file of their own.
 */
const EXTRA_COPYRIGHT = [
  [
    /^@codingame\/monaco-vscode-/,
    ['Copyright (c) CodinGame', 'Copyright (c) Microsoft Corporation (Visual Studio Code)'],
  ],
];

/** The name of the entry made for a package that ships no licence file. */
export const STANDARD_TEXT_FILE = 'LICENSE (standard text - the package ships none)';

const MIT_TEXT = `MIT License

{copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The copyright lines for a package with no licence file: its author, else its authors by name. */
export function copyrightOf(pkg) {
  const extra = EXTRA_COPYRIGHT.find(([re]) => re.test(pkg.name))?.[1];
  if (extra) return extra;
  const a = pkg.author;
  const name =
    typeof a === 'string'
      ? a.replace(/<[^>]*>|\([^)]*\)/g, '').trim()
      : a && typeof a === 'object' && typeof a.name === 'string'
        ? a.name.trim()
        : '';
  return [`Copyright (c) ${name || `the ${pkg.name} authors`}`];
}

/**
 * The standard text for a package that ships no licence file, or null when
 * its licence is not one we can write out: MIT with its copyright lines,
 * Apache-2.0 as the canonical text another package shipped (`apacheText`).
 */
export function standardText(pkg, license, apacheText) {
  if (license === 'MIT') return MIT_TEXT.replace('{copyright}', copyrightOf(pkg).join('\n'));
  if (license === 'Apache-2.0' && apacheText)
    return `${copyrightOf(pkg).join('\n')}\n\n${apacheText}`;
  return null;
}

/** The Apache License 2.0's full text, if one of the files read is it. */
export function canonicalApache(texts) {
  return (
    texts.find(
      (t) =>
        /^\s*Apache License\s+Version 2\.0/.test(t) && t.includes('END OF TERMS AND CONDITIONS'),
    ) ?? null
  );
}

/**
 * The package folder a bundled module came from: the path up to the last
 * `node_modules/<name>` (`<scope>/<name>` for a scoped one), so a pnpm store
 * path (`node_modules/.pnpm/x@1/node_modules/x/...`) names the real package.
 * Null for a module outside node_modules or a virtual one (`\0…`).
 */
export function packageDirOf(moduleId) {
  if (!moduleId || moduleId.startsWith('\0')) return null;
  const path = moduleId.split('?')[0].replaceAll('\\', '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const take = rest[0].startsWith('@') ? 2 : 1;
  if (rest.length < take || !rest[take - 1]) return null;
  return path.slice(0, at) + '/node_modules/' + rest.slice(0, take).join('/');
}

/** The licence, notice and third-party-notice files in `dir`, sorted by name. */
export function noticeFilesIn(dir, list = (d) => readdirSync(d)) {
  let names;
  try {
    names = list(dir);
  } catch {
    return [];
  }
  return names.filter((n) => NOTICE_FILE.test(n)).sort((a, b) => a.localeCompare(b));
}

/** A `license` field as text: a string, an SPDX-ish object, or the old array form. */
export function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l))
    return (
      l
        .map((x) => (typeof x === 'string' ? x : x?.type))
        .filter(Boolean)
        .join(' OR ') || null
    );
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return null;
}

/**
 * The notices document for a set of package folders: one entry per
 * name@version (sorted), each pointing into a shared list of texts so the
 * same MIT text or VS Code notices file is stored once.
 */
export function buildNotices(dirs, fs = defaultFs) {
  const byKey = new Map();
  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFile(join(dir, 'package.json')));
    } catch {
      continue;
    }
    if (!pkg.name || byKey.has(`${pkg.name}@${pkg.version}`)) continue;
    const files = noticeFilesIn(dir, fs.list).filter((f) => fs.isFile(join(dir, f)));
    byKey.set(`${pkg.name}@${pkg.version}`, {
      pkg,
      name: pkg.name,
      version: pkg.version ?? '',
      license: licenseOf(pkg),
      files: files.map((f) => ({
        name: f,
        text: fs.readFile(join(dir, f)).slice(0, MAX_TEXT_BYTES),
      })),
    });
  }
  // A package that ships no licence file still owes its notice: the
  // standard text, with its copyright lines.
  const apache = canonicalApache([...byKey.values()].flatMap((e) => e.files.map((f) => f.text)));
  for (const entry of byKey.values()) {
    if (entry.files.length > 0) continue;
    const text = standardText(entry.pkg, entry.license, apache);
    if (text) entry.files.push({ name: STANDARD_TEXT_FILE, text });
  }
  const texts = [];
  const textIndex = new Map();
  const packages = [...byKey.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(({ name, version, license, files }) => ({
      name,
      version,
      license,
      files: files.map(({ name, text }) => {
        let i = textIndex.get(text);
        if (i === undefined) {
          i = texts.length;
          texts.push(text);
          textIndex.set(text, i);
        }
        return { name, text: i };
      }),
    }));
  return { version: 1, packages, texts };
}

const defaultFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  list: (d) => readdirSync(d),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * The plugins for electron.vite.config.ts. One collector per build run: the
 * three builds run in one process, so what main and preload record is still
 * there when the renderer's build closes.
 */
export function thirdPartyNotices(rootDir = process.cwd()) {
  const bundled = new Set();
  const recordBundled = (target) => ({
    name: `third-party-notices:${target}`,
    apply: 'build',
    generateBundle(_options, bundle) {
      // The modules each emitted chunk renders - what actually ships, after
      // tree-shaking, not every module the build looked at.
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
          const dir = packageDirOf(id);
          if (dir) bundled.add(dir);
        }
      }
    },
  });
  const writeNotices = () => {
    // The renderer's own output folder (`out/renderer`, or `<outDir>/renderer`
    // for a scratch build) - the notices go one level up, beside main's.
    let outRoot = resolve(rootDir, 'out');
    return {
      name: 'third-party-notices:write',
      apply: 'build',
      configResolved(config) {
        outRoot = dirname(resolve(config.root, config.build.outDir));
      },
      async closeBundle() {
        // Loaded here, by a computed path: electron-vite bundles its config and
        // this file with it, and that bundler cannot parse the guard (it starts
        // with a shebang).
        const guard = pathToFileURL(resolve(rootDir, 'scripts/check-app-asar.mjs')).href;
        const { runtimeClosure, LEFT_OUT } = await import(/* @vite-ignore */ guard);
        const { dirs, unresolved } = runtimeClosure(rootDir);
        if (unresolved.length > 0) {
          throw new Error(
            `third-party notices: not installed, cannot read their licences: ${unresolved.join(', ')}`,
          );
        }
        const all = new Set([...bundled].filter((d) => existsSync(join(d, 'package.json'))));
        // A package the packages leave out on purpose ships no code, so no notice.
        for (const [name, d] of dirs) if (!LEFT_OUT.includes(name)) all.add(d);
        for (const name of ALSO_SHIPPED) {
          const pj = join(rootDir, 'node_modules', name, 'package.json');
          if (!existsSync(pj)) throw new Error(`third-party notices: ${name} is not installed`);
          all.add(dirname(realpathSync(pj)));
        }
        const doc = buildNotices(all);
        const out = join(outRoot, NOTICES_FILE);
        mkdirSync(outRoot, { recursive: true });
        writeFileSync(out, JSON.stringify(doc));
        console.log(`third-party notices: ${doc.packages.length} packages → ${out}`);
      },
    };
  };
  return { recordBundled, writeNotices };
}
