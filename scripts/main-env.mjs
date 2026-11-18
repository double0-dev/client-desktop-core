/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in main-env.d.mts */
// Which VITE_* values the MAIN bundle needs baked in, and the check that proves
// they were (a private plan › Desktop changes 1).
//
// src/main reads these as plain `process.env.VITE_*` with localhost fallbacks.
// Nothing sets them in a packaged app, so unless the bundler inlines them at
// build time the shipped app silently talks to localhost. electron.vite.config.ts
// turns `mainEnvDefines(loadEnv(...))` into `define` entries; check-main-bundle.mjs
// runs `checkMainBundle` over out/main/index.js after every build (workflow and
// release.sh) so a regression fails the build instead of the release.
// Pure helpers, covered by src/main/main-env.test.ts.

/** Core's keys; the official build adds its own (electron.vite.config.ts reads them from pro/). */
export const MAIN_ENV_KEYS = ['VITE_API_URL', 'VITE_DESKTOP_PROTOCOL'];

/**
 * `define` map for the main bundle: `process.env.<key>` → the literal value,
 * or the literal `undefined` when the key is unset - a packaged app never has
 * these in its environment anyway, so the code's `?? <localhost fallback>`
 * behaves the same and no `process.env.VITE_*` read survives bundling.
 */
export function mainEnvDefines(env, keys = MAIN_ENV_KEYS) {
  const out = {};
  for (const key of keys) {
    const value = env?.[key];
    out[`process.env.${key}`] =
      typeof value === 'string' && value.trim() !== '' ? JSON.stringify(value.trim()) : 'undefined';
  }
  return out;
}

/**
 * Problems with a built main bundle: any surviving `process.env.VITE_*` read
 * (not inlined) and every `expect` string that is missing (the production host
 * the build was supposed to bake in). Empty array = fine.
 */
export function checkMainBundle(source, { expect = [] } = {}) {
  const problems = [];
  const leaked = source.match(/process\.env\.VITE_[A-Z0-9_]+/g);
  if (leaked) {
    problems.push(`main bundle still reads ${[...new Set(leaked)].join(', ')} at runtime`);
  }
  for (const needle of expect) {
    if (!source.includes(needle)) problems.push(`main bundle does not contain "${needle}"`);
  }
  return problems;
}

/** The host name to expect in a bundle built with `env` (from VITE_API_URL), or null. */
export function expectedApiHost(env) {
  const url = env?.VITE_API_URL;
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    return new URL(url.trim()).host;
  } catch {
    return null;
  }
}
