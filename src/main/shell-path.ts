/**
 * A path git hands to `sh` (GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_SSH_COMMAND -
 * git runs every such variable through its shell). On Windows that is Git
 * Bash, which reads a backslash as an escape: `C:\Users\…\seq.sh` arrived as
 * `C:Users…seq.sh: command not found` and every Reword failed (2026-10-28).
 * Forward slashes are read the same by Git Bash and by Windows itself.
 */
export function shellPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

/**
 * `shellPath`, single-quoted as one shell word - the whole value of such a
 * variable is a command line. The temp folder is space-free on macOS and Linux,
 * but on Windows it sits under the account folder (`C:/Users/Emma Wilson/…`),
 * which split the command at the space.
 */
export function shellCommandPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `'${shellPath(path, platform).replace(/'/g, `'\\''`)}'`;
}

/**
 * An absolute path git REPORTED (`rev-parse --show-toplevel`, `worktree list`)
 * in the form the rest of the app uses. Git for Windows answers `C:/Users/…`
 * while every folder the app picked is `C:\Users\…`, so the renderer's
 * containment checks never matched: the git client marked no worktree row and
 * a session rooted in a subfolder stayed out of its new worktree (2026-10-28).
 */
export function nativePath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replace(/\//g, '\\') : path;
}
