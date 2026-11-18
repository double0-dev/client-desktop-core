import { UriIdentityService } from '@codingame/monaco-vscode-api/vscode/vs/platform/uriIdentity/common/uriIdentityService';
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { posix } from '@codingame/monaco-vscode-api/vscode/vs/base/common/path';
import { HOST_AUTHORITY_PREFIX } from '@renderer/lib/remote-uri';

/**
 * The editor's URI identity service, made safe for a host's files
 * (lib/remote-uri.ts: `file://d0-host.<id>/home/emmaw/acme/app.py`).
 *
 * VS Code canonicalises every URI it keys things by - model references, the
 * markers a language server's diagnostics become - through
 * `normalizePath`, which for a `file:` URI rebuilds the path from the
 * platform `fsPath`. With an authority that fsPath is a UNC share
 * (`//d0-host.<id>/home/…`); POSIX `normalize` folds its leading `//`, the
 * authority stays on, and the "canonical" URI names
 * `file://d0-host.<id>/d0-host.<id>/home/…` - a file that does not exist.
 * So every diagnostic for a host's file landed on that phantom URI (hovers
 * worked, no squiggle ever showed), and the word highlighter's model
 * reference threw "Unable to read file '//d0-host.<id>/d0-host.<id>/…'" on
 * every focus (2026-10-31). Windows clients never saw it: win32 `normalize`
 * keeps the share.
 *
 * A host URI's path is already POSIX: it is normalised as a path, the
 * authority untouched. The base service's case cache adds nothing for it
 * (the editors' overlay is case-sensitive), so it is skipped.
 */
export function canonicalHostUri(uri: URI): URI | null {
  if (uri.scheme !== 'file' || !uri.authority.startsWith(HOST_AUTHORITY_PREFIX)) return null;
  const path = uri.path ? posix.normalize(uri.path) : uri.path;
  return path === uri.path ? uri : uri.with({ path });
}

export class HostAwareUriIdentityService extends UriIdentityService {
  override asCanonicalUri(uri: URI): URI {
    return canonicalHostUri(uri) ?? super.asCanonicalUri(uri);
  }
}
