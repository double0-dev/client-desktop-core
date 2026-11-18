#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in check-app-asar.d.mts */
// Fail unless every runtime dependency of the app is inside the packaged
// archive (a private plan › Implementation notes, 2026-09-16).
//
//   node scripts/check-app-asar.mjs [dist/mac-arm64/double0.app/Contents/Resources/app.asar ...]
//   node scripts/check-app-asar.mjs --core   # the open-source build in dist-core/ (pnpm package:core)
//
// Without arguments every app.asar under dist/ is checked. electron-builder
// collects node_modules from what `pnpm list --prod --json --depth Infinity`
// reports, and under this repo's hoisted pnpm layout that report once came
// back with no nested dependencies for some packages - the first release
// shipped without `nanostores` and 65 other packages and crashed on launch.
// The main bundle check proves the URLs; this proves the modules. Pure
// helpers are exported for the official build.
//
// It also runs check-remote-runtime.mjs (strict) over the runtime the app
// pushes to a host, `<archive>.unpacked/out/main/remote`: electron-builder
// adds its own `!**/node_modules/**` to an all-exclusions `files:` list, and
// that silently dropped the remote runtime's pty package - every packaged
// build failed to connect a new host, and every check passed (2026-11-01).
// `--core` checks the open-source build's packages instead (double0 Core,
// electron-builder.core.yml): the same modules and repo-only rules, and no
// host runtime at all - that build has none to push.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Package names present in an asar listing (`/node_modules/<name>/package.json`
 * entries). The listing is built with `path.join`, so on Windows every entry
 * comes back with backslashes (`\\node_modules\\react\\package.json`) - the
 * v0.1.1 Windows build reported all 263 packages missing for that reason.
 */
export function packagesInListing(entries) {
  const out = new Set();
  for (const p of entries) {
    const m = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(p.replaceAll('\\', '/'));
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * The runtime closure of `rootDir`'s package.json `dependencies`: every
 * package reachable through `dependencies` edges, resolved the way Node does
 * (nearest node_modules walking up from the importer's real directory, so a
 * pnpm virtual store works too), plus every installed `optionalDependencies`
 * entry and every installed `peerDependencies` entry NOT marked optional in
 * `peerDependenciesMeta` - pnpm installs peers, and a static import of one
 * crashes the packaged app exactly like a missing dependency
 * (`@better-auth/core` imports its peer `@opentelemetry/api`; v0.1.2 launched
 * into ERR_MODULE_NOT_FOUND). Optional peers are "use if present" and their
 * importers guard them. An uninstalled peer or optional is skipped; an
 * uninstalled dependency is reported. A peer that resolves to one of the
 * root's own devDependencies is a build-time tool, not runtime, and is
 * skipped too. `electron` itself is never in the archive.
 */
export function runtimeClosure(rootDir, readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))) {
  const pkgJsonFor = (name, fromDir) => {
    let dir = fromDir;
    for (;;) {
      const candidate = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  // name → the names the archive may hold it under: the dependency name, plus
  // the real package behind an `npm:` alias (`monaco-editor` is
  // `npm:@codingame/monaco-vscode-editor-api@…` here).
  const seen = new Map();
  // name → the real folder it resolved to (the notices read its licence there).
  const dirs = new Map();
  const unresolved = [];
  const aliasOf = (spec) => {
    const m = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/.exec(String(spec ?? ''));
    return m ? m[1] : null;
  };
  const root = readJson(join(rootDir, 'package.json'));
  // The root's pnpm.packageExtensions (keys `name` or `name@range`; the range
  // is not evaluated here) correct a dependency's manifest the way pnpm does
  // at install time - drizzle-orm's beta forgets the optional flag on its
  // mssql peers, and a stale lockfile keeps them installed even after pnpm
  // stops auto-installing them.
  const extensions = new Map(
    Object.entries(root.pnpm?.packageExtensions ?? {}).map(([key, ext]) => [
      key.replace(/(?!^)@.*$/, ''),
      ext,
    ]),
  );
  const extend = (pkg) => {
    const ext = extensions.get(pkg.name);
    if (!ext) return pkg;
    const out = { ...pkg };
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ]) {
      if (ext[field]) out[field] = { ...pkg[field], ...ext[field] };
    }
    return out;
  };
  const devOnly = new Set(
    Object.keys(root.devDependencies ?? {}).filter((n) => !(n in (root.dependencies ?? {}))),
  );
  // [name, alias, importerDir, required]: dependencies edges are required,
  // peer / optional edges are followed only when installed.
  const enqueue = (pkg, fromDir) => [
    ...Object.entries(pkg.dependencies ?? {}).map(([n, spec]) => [n, aliasOf(spec), fromDir, true]),
    // A peer marked optional in peerDependenciesMeta is "use if present"
    // (drizzle's database drivers) and its code guards the import; an unmarked
    // peer is a hard requirement the host must provide.
    ...Object.entries(pkg.peerDependencies ?? {})
      .filter(([n]) => !pkg.peerDependenciesMeta?.[n]?.optional)
      .map(([n, spec]) => [n, aliasOf(spec), fromDir, false]),
    ...Object.entries(pkg.optionalDependencies ?? {}).map(([n, spec]) => [
      n,
      aliasOf(spec),
      fromDir,
      false,
    ]),
  ];
  const queue = enqueue(root, rootDir);
  while (queue.length > 0) {
    const [name, alias, fromDir, required] = queue.shift();
    if (seen.has(name) || name === 'electron') continue;
    if (!required && devOnly.has(name)) continue;
    const pj = pkgJsonFor(name, fromDir);
    if (!pj) {
      if (required) {
        unresolved.push(name);
        seen.set(name, [name]);
      }
      continue;
    }
    seen.set(name, alias ? [name, alias] : [name]);
    const real = dirname(realpathSync(pj));
    dirs.set(name, real);
    queue.push(...enqueue(extend(readJson(pj)), real));
  }
  seen.delete('electron');
  dirs.delete('electron');
  return { packages: seen, unresolved, dirs };
}

/**
 * Dependencies the packages leave out on purpose (electron-builder `files`):
 * code that never runs and whose licence would otherwise ship. `jschardet`
 * (LGPL-2.1) comes with the editor's VS Code packages, which load it only to
 * guess encodings while `files.autoGuessEncoding` is on - never in this app;
 * the bundles import a stand-in (src/renderer/src/lib/monaco/jschardet-stub.ts).
 */
export const LEFT_OUT = ['jschardet'];

/** Left-out packages an archive holds anyway: the exclusion stopped working. */
export function shippedLeftOut(inArchive, leftOut = LEFT_OUT) {
  return leftOut.filter((n) => inArchive.has(n));
}

/** Names in the closure that the archive lacks under any of their names. */
export function missingPackages(closure, inArchive) {
  const entries = closure instanceof Map ? [...closure] : [...closure].map((n) => [n, [n]]);
  return entries
    .filter(([, names]) => !names.some((n) => inArchive.has(n)))
    .map(([name]) => name)
    .sort();
}

/**
 * Repo-only paths an archive must never hold - sources, plans, agent notes,
 * scripts, configs (electron-builder.yml › files). The code ships bundled in
 * out/; one of these in an archive is source or private notes leaking to
 * every install (pro/ did, from a private plan › M0 until 2026-11-06).
 */
const REPO_ONLY = [
  /^(pro|src|docs|scripts|releases|dist-core|\.claude|\.github)\//,
  /^(core-paths\.txt|tsconfig[^/]*\.json|vitest\.config\.ts|eslint\.config\.mjs|electron\.vite\.config\.ts|electron-builder[^/]*\.yml)$/,
];

/** The repo-only entries of an asar listing, as archive paths without the leading slash. */
export function repoOnlyEntries(entries) {
  const out = [];
  for (const raw of entries) {
    const path = raw.replace(/\\/g, '/').replace(/^\//, '');
    if (REPO_ONLY.some((re) => re.test(path))) out.push(path);
  }
  return out;
}

/**
 * What the pty patch (patches/@homebridge__node-pty-prebuilt-multiarch@*.patch)
 * adds to the macOS build: the call that gives every terminal's shell none of
 * the app's exception ports. Without it a program run in a terminal inherits
 * the app's crash handler, and its crash dump - another app's memory and
 * paths - lands among the app's own (a user's SwiftUI app, 2026-11-11). A source patch
 * applies only when the package compiles; a prebuilt binary for our ABI would
 * silently skip it, so the packaged binary itself is checked.
 */
const CRASH_PORT_RESET = '_posix_spawnattr_setexceptionports_np';

/** A macOS package: its archive sits in `<name>.app/Contents/Resources`. */
export function isMacArchive(archive) {
  return /\.app[\\/]Contents[\\/]Resources[\\/]app\.asar$/.test(archive);
}

/** True when a pty.node was built from the patched source. */
export function resetsCrashPorts(bytes) {
  return bytes.includes(CRASH_PORT_RESET);
}

/**
 * The app's own pty.node builds under an unpacked archive folder - never the
 * host runtime's (`out/main/remote`, a host runs no crash handler of ours) or a
 * bundled prebuild for another platform.
 */
export function appPtyBinaries(unpackedDir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const rel = p.slice(unpackedDir.length).replace(/\\/g, '/');
      if (rel.startsWith('/out/main/remote') || entry === 'prebuilds') continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry === 'pty.node') out.push(p);
    }
  };
  if (existsSync(unpackedDir)) walk(unpackedDir);
  return out;
}

/**
 * The open-source notices the build writes (scripts/third-party-notices.mjs)
 * and Settings › General shows: the licences of the bundled code and of every
 * package in the archive's node_modules, which MIT, BSD, Apache and MPL ask a
 * binary to carry (a private plan › E).
 */
export const NOTICES_ENTRY = 'out/third-party-notices.json';

/**
 * What is wrong with an archive's notices: unreadable, empty, or missing a
 * package the archive ships in node_modules. The archive holds an aliased
 * package under its alias (`monaco-editor`) and the notices under its real
 * name, so `aliases` (runtimeClosure's packages: name → every name) lets
 * either count.
 */
export function noticesProblems(raw, inArchive, aliases = new Map()) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [`${NOTICES_ENTRY} is not valid JSON`];
  }
  if (doc?.version !== 1 || !Array.isArray(doc.packages) || !Array.isArray(doc.texts)) {
    return [`${NOTICES_ENTRY} is not a notices document`];
  }
  if (doc.packages.length === 0) return [`${NOTICES_ENTRY} lists no package`];
  const listed = new Set(doc.packages.map((p) => p.name));
  const missing = [...inArchive]
    .filter((n) => !(aliases.get(n) ?? [n]).some((name) => listed.has(name)))
    .sort();
  const textless = doc.packages.filter((p) => !p.files?.length).map((p) => p.name);
  return [
    ...(missing.length > 0
      ? [`no notice for ${missing.length} shipped package(s): ${missing.join(' ')}`]
      : []),
    ...(textless.length > 0 ? [`no licence text for: ${textless.join(' ')}`] : []),
  ];
}

/**
 * Electron's and Chromium's own licence files, which electron-builder keeps
 * in every package (`LICENSE.electron.txt`, `LICENSES.chromium.html`): beside
 * the archive on macOS (`Contents/Resources`), next to the executable - one
 * folder up - on Windows and Linux.
 */
export function platformLicenseDirs(archive) {
  return isMacArchive(archive) ? [dirname(archive)] : [dirname(dirname(archive))];
}

/** The remote runtime beside a packaged archive (`asarUnpack: out/main/remote/**`). */
export function unpackedRemoteDir(archive) {
  return `${archive}.unpacked/out/main/remote`;
}

function findAsars(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry === 'app.asar') out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function main(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const asar = require('@electron/asar');
  const core = argv.includes('--core');
  const paths = argv.filter((a) => a !== '--core');
  // Each edition packages into its own folder (electron-builder.core.yml).
  const archives = paths.length > 0 ? paths : findAsars(join(rootDir, core ? 'dist-core' : 'dist'));
  if (archives.length === 0) {
    console.error('✖ no app.asar found - package first (electron-builder --dir)');
    return 1;
  }
  const { packages, unresolved } = runtimeClosure(rootDir);
  if (unresolved.length > 0) {
    console.error(`✖ not installed locally, cannot judge: ${unresolved.join(', ')}`);
    return 1;
  }
  let failed = false;
  for (const archive of archives) {
    const listing = asar.listPackage(archive);
    const leaked = repoOnlyEntries(listing);
    if (leaked.length > 0) {
      failed = true;
      const top = [...new Set(leaked.map((p) => p.split('/')[0]))].join(', ');
      console.error(`✖ ${archive}: ${leaked.length} repo-only file(s) packed (${top})`);
    }
    const present = packagesInListing(listing);
    if (!listing.some((e) => e.replaceAll('\\', '/') === `/${NOTICES_ENTRY}`)) {
      failed = true;
      console.error(
        `✖ ${archive}: no ${NOTICES_ENTRY} - the open-source notices are not in the package`,
      );
    } else {
      const problems = noticesProblems(
        asar.extractFile(archive, NOTICES_ENTRY).toString('utf8'),
        present,
        packages,
      );
      if (problems.length > 0) {
        failed = true;
        for (const p of problems) console.error(`✖ ${archive}: ${p}`);
      } else {
        console.log(`✔ ${archive}: open-source notices cover all ${present.size} shipped packages`);
      }
    }
    for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      if (!platformLicenseDirs(archive).some((d) => existsSync(join(d, file)))) {
        failed = true;
        console.error(
          `✖ ${archive}: no ${file} beside the app - Electron's licence must ship with it`,
        );
      }
    }
    const leftIn = shippedLeftOut(present);
    if (leftIn.length > 0) {
      failed = true;
      console.error(`✖ ${archive}: packed although left out on purpose: ${leftIn.join(' ')}`);
    }
    const missing = missingPackages(packages, present).filter((n) => !LEFT_OUT.includes(n));
    if (missing.length > 0) {
      failed = true;
      console.error(
        `✖ ${archive}: ${missing.length} runtime package(s) missing of ${packages.size}: ${missing.join(' ')}`,
      );
    } else {
      console.log(`✔ ${archive}: all ${packages.size} runtime packages present`);
    }
    if (isMacArchive(archive)) {
      const binaries = appPtyBinaries(`${archive}.unpacked`);
      if (binaries.length === 0) {
        failed = true;
        console.error(`✖ ${archive}: no unpacked pty.node to check for the crash port reset`);
      }
      for (const binary of binaries) {
        if (resetsCrashPorts(readFileSync(binary))) {
          console.log(`✔ ${binary}: terminals get none of the app's crash ports`);
        } else {
          failed = true;
          console.error(
            `✖ ${binary}: built without the pty patch - programs run in a terminal would crash into the app's crash handler`,
          );
        }
      }
    }
    const remote = unpackedRemoteDir(archive);
    if (core) {
      if (existsSync(remote)) {
        failed = true;
        console.error(`✖ ${archive}: the open-source build ships a host runtime (${remote})`);
      }
      continue;
    }
    const runtime = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./check-remote-runtime.mjs', import.meta.url)), '--dir', remote],
      { stdio: 'inherit' },
    );
    if (runtime.status !== 0) {
      failed = true;
      console.error(`✖ ${archive}: the host runtime in ${remote} is incomplete`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
