/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in pro-paths.d.mts */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where the four `@pro/*` entry modules resolve (a private plan
 * › Build mechanics). The official build points them at `pro/`; the core
 * build (`PRO=0`, or a tree without `pro/` - the public export) points them
 * at `src/pro-stub/`, the empty twins, so no Pro code is compiled in.
 *
 * One module for every consumer - electron.vite.config.ts, vitest.config.ts
 * and the remote runtime's esbuild call - so the three can never disagree.
 */
export const PRO_ENTRIES = ['main', 'preload', 'renderer', 'daemon'];

/** True for the official build: `pro/` is present and `PRO=0` is not set. */
export function proEnabled(env = process.env, root = process.cwd()) {
  return env.PRO !== '0' && existsSync(resolve(root, 'pro'));
}

/**
 * A line to print when `pro/` is there but `PRO=0` turns it off: a `PRO=0`
 * left in a shell silently ran `pnpm dev` / `pnpm test` as the core build.
 * Null otherwise (the official build, and a tree without pro/).
 */
export function editionNotice(env = process.env, root = process.cwd()) {
  return env.PRO === '0' && existsSync(resolve(root, 'pro'))
    ? '[double0] PRO=0: building the core edition - pro/ is ignored'
    : null;
}

/** `{ '@pro/main': <file>, … }` for the chosen edition. */
export function proAliases(root, pro) {
  return Object.fromEntries(
    PRO_ENTRIES.map((entry) => [
      `@pro/${entry}`,
      pro ? resolve(root, 'pro', entry, 'index.ts') : resolve(root, 'src/pro-stub', `${entry}.ts`),
    ]),
  );
}
