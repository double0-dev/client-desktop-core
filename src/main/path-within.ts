/**
 * Path containment on either platform, for main: whether a folder lies in
 * another, a path relative to its base for display, and absoluteness. Pure.
 * Twin: the renderer's `lib/path-within.ts`.
 */

const isSep = (ch: string | undefined): boolean => ch === '/' || ch === '\\';

/** Trailing separators off, so `/a/b/` and `/a/b` are the same folder. */
export function normalizePath(path: string): string {
  let end = path.length;
  while (end > 1 && isSep(path[end - 1])) end--;
  return path.slice(0, end);
}

/**
 * A Windows path (a drive or UNC path) with one separator and ASCII lower
 * case, for comparing only: an agent writes `c:/…` for the session's
 * `C:\…` folder, and the tool title showed the whole absolute path (review,
 * 2026-10-29). Length-preserving, so `relativeWithin` still slices by the
 * base's length. POSIX paths compare exactly - their file systems are
 * case-sensitive. Twin: `comparablePath` in the renderer's `lib/path-within.ts`.
 */
function comparable(path: string): string {
  return /^([A-Za-z]:|\\\\)/.test(path)
    ? path.replace(/\\/g, '/').replace(/[A-Z]/g, (ch) => ch.toLowerCase())
    : path;
}
/**
 * Whether `target` is `base` or lies below it - on a path boundary (`/a/b`
 * never contains `/a/bc`), with either separator: Windows paths come back
 * from `path.join` with backslashes, and a `/`-only check matched nothing
 * below a repo there. Twin: the renderer's `lib/path-within.ts`.
 */
export function isWithin(target: string, base: string): boolean {
  const dir = comparable(normalizePath(target));
  const root = comparable(normalizePath(base));
  if (dir === root) return true;
  if (!dir.startsWith(root)) return false;
  // A root (`/`) already ends on its separator.
  return isSep(root[root.length - 1]) || isSep(dir[root.length]);
}

/**
 * `target` relative to `base` for display, with either separator; `target`
 * unchanged when it lies outside `base` or is `base` itself.
 */
export function relativeWithin(target: string, base: string): string {
  if (!base || !isWithin(target, base)) return target;
  return (
    normalizePath(target)
      .slice(normalizePath(base).length)
      .replace(/^[\\/]+/, '') || target
  );
}

/** Absolute on either platform: `/x`, `\x` or a drive path (`C:\x`, `C:/x`). */
export function isAbsolutePath(path: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(path);
}

/** Whether host path `child` is `base` or lies under it (both plain). */
export function hostPathWithin(child: string, base: string): boolean {
  const b = base.length > 1 ? base.replace(/\/+$/, '') : base;
  return child === b || child.startsWith(b === '/' ? '/' : `${b}/`);
}
