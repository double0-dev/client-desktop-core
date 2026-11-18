import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { editionNotice, proAliases, proEnabled } from './scripts/pro-paths.mjs';

// Standalone Vitest config - electron-vite owns electron.vite.config.ts (it is
// a multi-target main/preload/renderer config Vitest can't consume), so tests
// get their own setup.
//
// Two projects, because the two halves of the app need different globals:
//   main     - pure node, no DOM: src/main (git/db/ssh parsers, IPC handlers)
//              plus src/preload, which is a node context too
//   renderer - jsdom, so localStorage-backed stores and React components run
//              the same code path they do in the app instead of their
//              "no window" fallbacks.
// The official run (`pnpm test`) compiles pro/ in and runs its tests; the
// core run (`pnpm test:core`, PRO=0) resolves `@pro/*` to src/pro-stub/ and
// runs core's tests alone - the proof that core works with no Pro code
// (a private plan › "Works as before").
const pro = proEnabled(process.env, process.cwd());
const notice = editionNotice(process.env, process.cwd());
if (notice) console.warn(notice);
const alias = {
  '@renderer': resolve('src/renderer/src'),
  '@main': resolve('src/main'),
  ...proAliases(process.cwd(), pro),
};
const proTests = (glob: string) => (pro ? [glob] : []);

// electron-vite's `?asset` imports (an asset's packaged file path) have no
// meaning under vitest - resolve them to a stub path so main-process modules
// that import an icon (badge.ts, notify.ts) stay testable.
const assetStub = {
  name: 'stub-asset-imports',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return id.endsWith('?asset') ? '\0asset-stub' : undefined;
  },
  load(id: string) {
    return id === '\0asset-stub' ? 'export default "/stub-asset"' : undefined;
  },
};

// The release check runs on the dev Mac while other agents load it (load
// average past 100). Each tag run surfaced a different test losing a timing
// race (v0.7.0 - v0.7.3), and a failed check spends a version. In CI only:
// retry a failed test twice - a real bug fails all three - and run half the
// workers so the suite competes less with itself. Local runs stay strict, so
// a flaky test still shows up here first.
const ci = !!process.env.CI;

// Tests turned off everywhere because they lose timing races on a busy
// machine - Pro's own list, read only when pro/ is there.
const skippedFile = resolve('pro/test/skipped-tests.json');
const SKIPPED_TESTS: string[] =
  pro && existsSync(skippedFile)
    ? (JSON.parse(readFileSync(skippedFile, 'utf8')) as { tests: string[] }).tests
    : [];
const retry = ci ? 2 : 0;

export default defineConfig({
  test: {
    ...(ci ? { maxWorkers: '50%' } : {}),
    projects: [
      {
        plugins: [assetStub],
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/{main,preload}/**/*.test.ts',
            ...proTests('pro/{main,preload,daemon}/**/*.test.ts'),
          ],
          exclude: [...configDefaults.exclude, ...SKIPPED_TESTS],
          // What `@pro/*` pulls into core's own tests (the official build).
          setupFiles: proTests('./pro/test/main-setup.ts'),
          // These tests run real sh, git and ssh-keygen. The release check
          // runs on the dev Mac while it works, and v0.7.1's check timed out
          // at vitest's 5 s in five files that pass in under a second idle. A
          // test that really hangs still fails, just later.
          testTimeout: 20_000,
          hookTimeout: 20_000,
          retry,
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            ...alias,
            // Exported under the `browser` condition only, which the jsdom
            // project does not resolve with (the app's Vite does).
            'vscode-languageclient/browser': resolve(
              'node_modules/vscode-languageclient/lib/browser/main.js',
            ),
          },
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          // Same reason as main's: 5 s ran out under a load average past 100.
          testTimeout: 15_000,
          retry,
          include: [
            'src/renderer/**/*.test.{ts,tsx}',
            ...proTests('pro/renderer/**/*.test.{ts,tsx}'),
          ],
          // What Pro's own renderer tests share (the official build).
          setupFiles: [
            './src/renderer/src/test-setup.ts',
            ...proTests('./pro/test/renderer-setup.ts'),
          ],
          restoreMocks: true,
          // The monaco-vscode packages import their own `.css`, which Node's
          // loader refuses - run them through Vite's transform instead.
          server: { deps: { inline: [/@codingame\//] } },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // Every file `include` matches is reported, imported or not (Vitest 4+
      // dropped the `all` switch for this), so untested modules show up as 0%
      // instead of silently vanishing.
      include: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'pro/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/renderer/src/test-setup.ts',
        // Generated by tsr on dev/build.
        'src/renderer/src/routeTree.gen.ts',
        // Generated by drizzle-kit.
        'src/main/db/migrations/**',
      ],
    },
  },
});
