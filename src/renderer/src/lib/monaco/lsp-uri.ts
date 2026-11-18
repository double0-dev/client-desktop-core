import {
  HOST_AUTHORITY_PREFIX,
  uriOf,
  type UriFactory,
  type UriLike,
} from '@renderer/lib/remote-uri';

/**
 * What a language server on a remote host sees of the editor's URIs
 * (a private plan › 4.3). Pure.
 *
 * The editor names a host's file `file://d0-host.<id>/home/emmaw/acme/app.py`
 * (lib/remote-uri.ts) so two hosts with the same path are two models. The
 * server runs ON that host and knows only its own paths: everything it is
 * sent is a plain `file:///home/emmaw/acme/app.py`, and every `file:` URI it
 * answers with (a definition, a diagnostic, a workspace edit) is that host's -
 * the authority goes back on, so a jump into the host's `site-packages` opens
 * the HOST's file, never a local one under the same path.
 */

export type ConverterUri = UriLike & { toString(): string };

export type ConverterUriClass<U extends ConverterUri> = UriFactory<U> & {
  parse(value: string): U;
};

export type UriConverters<U> = {
  code2Protocol(uri: U): string;
  protocol2Code(value: string): U;
};

/** The converters for a host's client; null for a local one (the defaults stand). */
export function lspUriConverters<U extends ConverterUri>(
  Uri: ConverterUriClass<U>,
  hostId: string | null,
): UriConverters<U> | null {
  if (!hostId) return null;
  const authority = `${HOST_AUTHORITY_PREFIX}${hostId}`;
  return {
    code2Protocol: (uri) =>
      uri.scheme === 'file' && uri.authority === authority
        ? Uri.file(uri.path).toString()
        : uri.toString(),
    protocol2Code: (value) => {
      const parsed = Uri.parse(value);
      // The server's own file: the host's. A URI with an authority already
      // (a share, another machine) or another scheme is left as it came.
      return parsed.scheme === 'file' && parsed.authority === ''
        ? uriOf(Uri, hostId, parsed.path)
        : parsed;
    },
  };
}

/**
 * The client's document selector pattern. vscode-languageclient matches it
 * against a model's `fsPath`, which for a host URI is `//d0-host.<id>/…` - so a
 * host's root pattern carries the authority (a bare `${root}/**` matched no
 * remote model, and a local model under the same path must not match a
 * host's client).
 */
export function lspSelectorPattern(hostId: string | null, root: string): string {
  return hostId ? `//${HOST_AUTHORITY_PREFIX}${hostId}${root}/**` : `${root}/**`;
}
