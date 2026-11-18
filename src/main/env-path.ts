/**
 * PATH in a copied environment. Windows names it `Path` and reads env names
 * case-insensitively, while a copy of `process.env` (`{ ...process.env }`) is
 * a plain, case-sensitive object: setting `PATH` on it ADDS a second
 * variable beside `Path`, and which of the two a child process sees is up to
 * how the env block is ordered. Terminals got `PATH=<a tool folder>;` and lost the
 * user's whole PATH that way (2026-10-28) - `node`, `git` and the rest were
 * "not recognized". Elsewhere names are case-sensitive and `PATH` is the
 * only spelling. Pure, for tests.
 */

/** Every key naming PATH in `env` on `platform`. */
function pathKeys(env: Record<string, unknown>, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return 'PATH' in env ? ['PATH'] : [];
  return Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
}

/** The env's PATH, whatever its spelling; undefined when there is none. */
export function envPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const key of pathKeys(env, platform)) {
    const value = env[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Set the env's PATH in place, keeping the spelling it already has (`Path`
 * on Windows) and dropping any other spelling, so exactly one remains.
 */
export function setEnvPath<T extends Record<string, string | undefined>>(
  env: T,
  value: string,
  platform: NodeJS.Platform = process.platform,
): T {
  const keys = pathKeys(env, platform);
  const keep = keys[0] ?? 'PATH';
  for (const key of keys) if (key !== keep) delete env[key];
  (env as Record<string, string | undefined>)[keep] = value;
  return env;
}
