// Types for scripts/main-env.mjs so electron.vite.config.ts and the tests
// import it under `pnpm typecheck`.
export const MAIN_ENV_KEYS: string[];
export function mainEnvDefines(
  env: Record<string, string | undefined>,
  keys?: readonly string[],
): Record<string, string>;
export function checkMainBundle(source: string, opts?: { expect?: string[] }): string[];
export function expectedApiHost(env: Record<string, string | undefined>): string | null;
