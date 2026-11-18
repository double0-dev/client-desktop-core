import type { Edition } from './extension';

/**
 * Which edition this main bundle is (a private plan ›
 * decision 6): `core` = the core build, `pro` = core + pro/. Baked in by
 * electron.vite.config.ts (`process.env.DOUBLE0_EDITION` in main's `define`),
 * so it is known at module load - user-data.ts runs before anything else in
 * main, long before `@pro/main` registers. Unset (vitest, the remote runtime)
 * reads as pro, the behaviour every build had before the split.
 */
export const EDITION: Edition = process.env.DOUBLE0_EDITION === 'core' ? 'core' : 'pro';
