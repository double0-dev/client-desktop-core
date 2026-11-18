/**
 * Editor URIs that know which machine a file is on
 * (a private plan › 12). Pure.
 *
 * A local file is `file:///path` (`Uri.file`, Windows drive paths included); a
 * file on a remote host carries the host's id as the URI authority -
 * `file://d0-host.build-box/home/emmaw/acme/src/a.ts` - so two sessions on two hosts
 * with the same `/home/emmaw/acme/src/a.ts` are two models, never one. A host
 * path is always POSIX (no Windows servers), so it goes in as is.
 *
 * Language detection still keys off the path; a host's language server sees
 * plain `file:` URIs through the converters in lib/monaco/lsp-uri.ts.
 *
 * The URI class is passed in (`mon.Uri` in the app) so this file never pulls
 * the editor bundle into whoever imports it.
 */
/**
 * A remote host's authority is `d0-host.<hostId>`, never the bare id: a local
 * Windows UNC path (`\\\\server\\share\\a.ts`) is a file URI with an authority
 * too, and must stay a local file.
 */
export const HOST_AUTHORITY_PREFIX = 'd0-host.';

export type UriLike = { scheme: string; authority: string; path: string; fsPath: string };

export type UriFactory<U extends UriLike> = {
  file(path: string): U;
  from(components: { scheme: string; authority?: string; path?: string }): U;
};

/** The editor URI of `path` on `hostId` (null = this machine). */
export function uriOf<U extends UriLike>(
  Uri: UriFactory<U>,
  hostId: string | null | undefined,
  path: string,
): U {
  if (!hostId) return Uri.file(path);
  return Uri.from({ scheme: 'file', authority: `${HOST_AUTHORITY_PREFIX}${hostId}`, path });
}

/**
 * The host and path a file URI names: a local one's `fsPath` (the platform's
 * own spelling - `C:\…` on Windows), a remote one's POSIX path. Never `fsPath`
 * for a remote URI: with an authority it reads as a UNC share (`//build-box/…`).
 */
export function pathOf(uri: UriLike): { hostId: string | null; path: string } {
  if (uri.scheme === 'file' && uri.authority.startsWith(HOST_AUTHORITY_PREFIX)) {
    return { hostId: uri.authority.slice(HOST_AUTHORITY_PREFIX.length), path: uri.path };
  }
  // A local file - a UNC share's authority included (its fsPath is the share).
  return { hostId: null, path: uri.fsPath };
}
