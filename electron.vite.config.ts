import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type UserConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { MAIN_ENV_KEYS, mainEnvDefines } from './scripts/main-env.mjs';
import { editionNotice, proAliases, proEnabled } from './scripts/pro-paths.mjs';
import { thirdPartyNotices } from './scripts/third-party-notices.mjs';

/**
 * Runtime dependencies bundled into main instead of loaded from node_modules
 * at launch: each external package is resolved and read file by file before
 * main runs a line (drizzle-orm alone cost ~450 ms of every launch, the rest
 * ~125 ms more). Only pure JS that main imports statically belongs here -
 * native modules (the pty), packages that find files next to themselves
 * (PGlite) and ones main loads on first use (`await import()`) stay external.
 * Pro adds its own (`PRO_MAIN_BUNDLED_DEPS`, the official build).
 */
const MAIN_BUNDLED_DEPS = ['drizzle-orm', 'zod', '@electron-toolkit/utils'];

/** the official build, when pro/ is there. */
type ProBuild = {
  PRO_MAIN_ENV_KEYS: string[];
  PRO_MAIN_BUNDLED_DEPS: string[];
  releaseBuild(
    env: Record<string, string | undefined>,
    pkg: { name: string; version: string },
    target: 'main' | 'renderer',
  ): { sourcemap: 'hidden'; plugins: import('vite').PluginOption[] } | null;
};

/**
 * The remote daemon runtime (a private plan › 3): after
 * every main build, the daemon entry again - this time with every dependency
 * inlined but the pty package, as CommonJS for a host's plain Node - plus the
 * pty package's JS and Linux prebuilds, into `<main outDir>/remote/`. The app
 * pushes that folder to a host (the official build); its hash is
 * the remote build id. scripts/check-remote-runtime.mjs checks it. The build
 * script is Pro's (the official build, a private plan › M7) and is
 * loaded only for the official build - by a computed path, so the public
 * tree, which has no pro/, never resolves it.
 */
type RuntimeBuilder = {
  buildRemoteRuntime(opts: {
    root: string;
    outDir: string;
    esbuild: typeof import('esbuild');
    alias: Record<string, string>;
  }): Promise<unknown>;
};
function remoteDaemonRuntime(alias: Record<string, string>): Plugin {
  return {
    name: 'remote-daemon-runtime',
    apply: 'build',
    async writeBundle(options) {
      if (!options.dir) return;
      const esbuild = await import('esbuild');
      const script = pathToFileURL(resolve('pro/scripts/remote-runtime.mjs')).href;
      const { buildRemoteRuntime } = (await import(/* @vite-ignore */ script)) as RuntimeBuilder;
      await buildRemoteRuntime({
        root: process.cwd(),
        outDir: resolve(options.dir, 'remote'),
        esbuild,
        alias,
      });
    },
  };
}

export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  // The main process reads VITE_API_URL & co. as plain `process.env` with
  // localhost fallbacks. Nothing sets them in a packaged app, so they are baked
  // in here from .env / the build environment; scripts/check-main-bundle.mjs
  // proves it after every build (a private plan).
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Official build (pro/ compiled in) or core build (`PRO=0`, or a tree
  // without pro/): a private plan › Build mechanics.
  const pro = proEnabled(process.env, process.cwd());
  const notice = editionNotice(process.env, process.cwd());
  if (notice) console.warn(notice);
  // What the official build adds (its env keys, a release build's source-map
  // upload) - loaded from pro/ only when it is there.
  const proBuild: ProBuild | null = pro
    ? ((await import(pathToFileURL(resolve('pro/scripts/build.mjs')).href)) as ProBuild)
    : null;
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  // Read from process.env, not the VITE_ loader - these must never be baked
  // into a bundle.
  const releaseMain = proBuild?.releaseBuild(process.env, pkg, 'main') ?? null;
  const releaseRenderer = proBuild?.releaseBuild(process.env, pkg, 'renderer') ?? null;
  const proAlias = proAliases(process.cwd(), pro);
  // The open-source notices the package carries (out/third-party-notices.json):
  // each build records the packages it bundled, the renderer's - the last -
  // writes the file (scripts/third-party-notices.mjs).
  const notices = thirdPartyNotices(process.cwd());
  return {
    main: {
      // `@main/*`: how pro/ reaches core main code (a private plan).
      resolve: { alias: { ...proAlias, '@main': resolve('src/main') } },
      plugins: [
        notices.recordBundled('main'),
        // Remote sessions are Pro: the core build ships no host runtime.
        ...(pro ? [remoteDaemonRuntime(proAlias)] : []),
        ...(releaseMain?.plugins ?? []),
      ],
      define: {
        ...mainEnvDefines(env, [...MAIN_ENV_KEYS, ...(proBuild?.PRO_MAIN_ENV_KEYS ?? [])]),
        // src/main/edition.ts: which edition this main bundle is, known at load.
        'process.env.DOUBLE0_EDITION': JSON.stringify(pro ? 'pro' : 'core'),
      },
      build: {
        // drizzle-orm is bundled, not loaded from node_modules: its ESM build is
        // ~680 small files, and resolving them one by one cost ~450 ms of
        // every launch before main ran a line (bundled: ~20 ms). PGlite stays
        // external - it locates its wasm / data files next to its own module.
        // The rest of the pure-JS packages main loads at launch are bundled for
        // the same reason (MAIN_BUNDLED_DEPS). Every other dependency stays
        // external (electron-vite's default).
        externalizeDeps: {
          exclude: [...MAIN_BUNDLED_DEPS, ...(proBuild?.PRO_MAIN_BUNDLED_DEPS ?? [])],
        },
        sourcemap: releaseMain?.sourcemap ?? false,
        // Three entries: the app (`index`), the session daemon (`daemon`),
        // which the app relaunches as a plain node process on its own binary
        // so terminals outlive it (a private plan), and the
        // database worker thread (`db-worker`). The daemon and the worker
        // import no Electron; shared modules land in `out/main/chunks/`.
        rolldownOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            daemon: resolve('src/main/daemon/daemon-main.ts'),
            // The database worker thread (src/main/db/db-worker.ts): PGlite and
            // its migrations off main's thread. Imports no Electron.
            'db-worker': resolve('src/main/db/db-worker.ts'),
          },
          // Rolldown keeps JSDoc comments by default (Rollup dropped them):
          // main's docs would ship in the bundle, and the ones that name a
          // `process.env.VITE_*` key trip scripts/check-main-bundle.mjs.
          output: { comments: { legal: true, annotation: true, jsdoc: false } },
        },
      },
    },
    preload: {
      // Dependencies stay external (electron-vite's `build.externalizeDeps`
      // default): the preload runs unsandboxed and requires them at load.
      resolve: { alias: { ...proAlias, '@main': resolve('src/main') } },
      plugins: [notices.recordBundled('preload')],
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          ...proAlias,
          // The editor's VS Code packages import the LGPL `jschardet` only to
          // guess encodings, which the app never turns on: a stand-in, and the
          // package is left out of node_modules (jschardet-stub.ts).
          jschardet: resolve('src/renderer/src/lib/monaco/jschardet-stub.ts'),
        },
      },
      // The @codingame monaco-vscode stack resolves worker/wasm assets through
      // `new URL(..., import.meta.url)`; Vite 8's dependency optimizer rewrites
      // those against the pre-bundled output itself (the esbuild plugin it once
      // needed is gone), and 'es' workers keep code-split worker chunks buildable.
      worker: {
        format: 'es',
        plugins: () => [notices.recordBundled('renderer-worker')],
      },
      build: { sourcemap: releaseRenderer?.sourcemap ?? false },
      plugins: [
        tanstackRouter({
          target: 'react',
          autoCodeSplitting: true,
          routesDirectory: resolve('src/renderer/src/routes'),
          generatedRouteTree: resolve('src/renderer/src/routeTree.gen.ts'),
        }),
        tailwindcss(),
        react(),
        // Last, so it sees the final chunks.
        ...(releaseRenderer?.plugins ?? []),
        notices.recordBundled('renderer'),
        // The renderer builds last: everything is recorded by its close.
        notices.writeNotices(),
      ],
    },
  };
});
