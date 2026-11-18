import { pathOf, type UriLike } from '@renderer/lib/remote-uri';

/**
 * Where a jump out of the editor lands (go-to-definition into a file that is
 * not open, a link) - plan 29 spec › 4.3. Pure.
 *
 * A host's file whose path lies in one of that host's projects opens as any
 * file of the session (the path alone names it). One outside every project
 * root of its host - the host's `site-packages`, its toolchain's sources -
 * keeps the host: by path alone it would resolve to THIS machine, so the tab
 * carries the host and the file opens read-only through it.
 */
export type EditorOpenTarget = { path: string; hostId?: string };

export function editorOpenTarget(
  uri: UriLike,
  hostOfPath: (path: string) => string | null,
): EditorOpenTarget | null {
  if (uri.scheme !== 'file') return null;
  const { hostId, path } = pathOf(uri);
  if (!hostId || hostOfPath(path) === hostId) return { path };
  return { path, hostId };
}
