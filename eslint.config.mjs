import { createRequire } from 'node:module';
import { defineConfig } from 'eslint/config';
import tseslint from '@electron-toolkit/eslint-config-ts';
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier';
import eslintPluginReact from 'eslint-plugin-react';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';

// eslint-plugin-react's `version: 'detect'` calls `context.getFilename()`,
// which ESLint 10 removed - every file then fails to lint. Hand it the
// installed version instead (same answer, no detection).
const reactVersion = createRequire(import.meta.url)('react/package.json').version;

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/routeTree.gen.ts'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: { react: { version: reactVersion } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactRefresh.configs.vite()],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      // react-hooks 7 brings the React Compiler's checks into `recommended`.
      // Four stay off, each named so the rest keep guarding the tree:
      // - preserve-manual-memoization / incompatible-library only report a
      //   component the compiler would skip; this app does not run the
      //   compiler.
      // - refs: the latest-value ref (`fnRef.current = fn` in render, read by
      //   stable callbacks and effects) is how this codebase avoids stale
      //   closures - ~110 sites, all of that one pattern (2026-11-12).
      // - set-state-in-effect: state reset when an input changes (a session
      //   switch, a dialog opening) - ~90 sites; each costs one extra render,
      //   none loops.
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  // A route file exports only its `Route` and keeps the component it names
  // local - exporting the component would keep it out of the router plugin's
  // code split, and the plugin hot-reloads route files itself.
  // react-refresh 0.5 reports those local components.
  {
    files: ['src/renderer/src/routes/**/route.tsx', 'src/renderer/src/routes/__root.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  // The core / Pro boundary (a private plan): core never
  // imports Pro, except the four composition roots, each its own entry.
  // scripts/pro-boundary.mjs (run by src/main/pro-boundary.test.ts) is the
  // complete check - type imports, mocks, dynamic imports, the allowlist -
  // this rule is the fast editor-time half of it.
  {
    files: ['src/**/*.{ts,tsx,mts,mjs}'],
    ignores: [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/src/main.tsx',
      'src/main/daemon/daemon-main.ts',
      'src/main/pro-boundary.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@pro/*'],
              message: 'Only a composition root imports @pro.',
            },
            {
              group: ['**/pro/**', '!**/pro-stub/**'],
              message: 'Core never imports from pro/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['pro/**/*.{ts,tsx,mts,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/pro-stub/**'],
              message: 'Pro never imports the core stubs.',
            },
          ],
        },
      ],
      // Every Pro IPC handler goes through a feature's registrar
      // (`ctx.ipcFor(feature)`, src/main/pro-ipc.ts), which answers ELOCKED
      // while the feature is not entitled. the official build is the
      // second check.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='ipcMain'][callee.property.name=/^(handle|handleOnce|on|once)$/]",
          message: 'Register Pro IPC through ctx.ipcFor(feature), never on ipcMain.',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
