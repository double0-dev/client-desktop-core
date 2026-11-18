/**
 * Build output a project's checkout holds for the machine that built it
 * (plan 29 decision 11, spec › 9.2): copied from this computer onto a host of
 * another platform or architecture it would not run (native modules, compiled
 * binaries, a virtualenv's interpreter links). Import-free, so a renderer
 * picker of files to copy and main's re-check
 * (`worktree-seed.ts` › `partitionLocalSeedPaths`) read the same list.
 */

/** Folder names (or `a/b` runs of names) that hold build output, at any depth. */
export const BUILD_OUTPUT: readonly string[] = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.gradle',
  'vendor/bundle',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.parcel-cache',
];

/**
 * The build-output folder `path` is or lies in (repo-relative, `/` or `\`
 * separated, a trailing slash for folders), or null. Matches whole segments
 * only: `distance/` and `rebuild.log` are not build output.
 */
export function buildOutputOf(path: string): string | null {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  for (const name of BUILD_OUTPUT) {
    const parts = name.split('/');
    for (let i = 0; i + parts.length <= segments.length; i++) {
      if (parts.every((p, j) => segments[i + j] === p)) return name;
    }
  }
  return null;
}

/**
 * Whether this computer and a host differ in what a build produces for them.
 * `platform` strings are `<os>-<arch>` (`linux-x64`, `darwin-arm64` - the
 * host facts' spelling); an unknown host platform counts as different, the
 * safe side.
 */
export function crossPlatform(local: string, host: string | null | undefined): boolean {
  return !host || host !== local;
}
