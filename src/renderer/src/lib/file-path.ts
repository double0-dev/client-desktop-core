/**
 * A repo-relative path split for display: the directory is
 * shown muted and the file name emphasised, so a list of changed files reads
 * by *what* changed rather than by the folders it sits in.
 *
 * When the file sits in a directory, `name` carries the leading "/" - the two
 * parts render back-to-back as one contiguous path, and the slash stays
 * attached to the (always visible) file name however far the directory gets
 * truncated, so `src/auth/provi…/token.service.ts` still reads as a path.
 * Root-level files have an empty `dir` and no slash.
 */
export type SplitFilePath = { dir: string; name: string };

export function splitFilePath(path: string): SplitFilePath {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i) };
}
