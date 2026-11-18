import { describe, expect, it } from 'vitest';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { UriIdentityService } from '@codingame/monaco-vscode-api/vscode/vs/platform/uriIdentity/common/uriIdentityService';

import { uriOf } from '@renderer/lib/remote-uri';
import { lspUriConverters } from './lsp-uri';
import { canonicalHostUri, HostAwareUriIdentityService } from './host-uri-identity';

/**
 * VS Code canonicalises the URIs it keys model references and diagnostics
 * by. Its stock service folds a file URI's authority into the path on a
 * POSIX client - every diagnostic for a host's file landed on a phantom
 * `file://d0-host.<id>/d0-host.<id>/…` and no squiggle ever showed, and the
 * word highlighter's model reference threw "Unable to read file" on every
 * focus (2026-10-31). Run against VS Code's own classes.
 */

const HOST = 'e6bf6ebe-a0a1-4001-a871-32621b9e78ec';
const remote = (path: string) => uriOf(URI, HOST, path);

/** The file service as the editor stack has it: `file:` served, case-sensitive. */
const fileService = {
  hasProvider: (uri: URI) => uri.scheme === 'file',
  hasCapability: () => true,
  onDidChangeFileSystemProviderRegistrations: () => ({ dispose: () => undefined }),
  onDidChangeFileSystemProviderCapabilities: () => ({ dispose: () => undefined }),
};
type ServiceCtor = new (fs: unknown) => { asCanonicalUri(uri: URI): URI };

// The first import transforms the VS Code module graph cold.
describe('canonical URIs of a host file', { timeout: 60_000 }, () => {
  const ours = new (HostAwareUriIdentityService as unknown as ServiceCtor)(fileService);

  /** The cause, pinned: if VS Code ever fixes it, this test says the override can go. */
  it('is broken in the stock service on this platform', () => {
    if (process.platform === 'win32') return;
    const stock = new (UriIdentityService as unknown as ServiceCtor)(fileService);
    const canon = stock.asCanonicalUri(remote('/home/emmaw/acme/src/app.py'));
    expect(canon.path).toBe(`/d0-host.${HOST}/home/emmaw/acme/src/app.py`);
  });

  it("keeps the host's model URI as it is", () => {
    const model = remote('/home/emmaw/acme/src/app.py');
    const canon = ours.asCanonicalUri(model);
    expect(canon.toString()).toBe(model.toString());
    expect(canon.authority).toBe(`d0-host.${HOST}`);
    expect(canon.path).toBe('/home/emmaw/acme/src/app.py');
  });

  it('normalises a host path as a path, authority untouched', () => {
    const canon = ours.asCanonicalUri(remote('/home/emmaw/acme/src/../lib/./util.py'));
    expect(canon.toString()).toBe(remote('/home/emmaw/acme/lib/util.py').toString());
  });

  it('leaves local files to the stock rules', () => {
    expect(canonicalHostUri(URI.file('/home/emmaw/acme/app.py'))).toBeNull();
    const local = ours.asCanonicalUri(URI.file('/home/emmaw/acme/./app.py'));
    expect(local.toString()).toBe('file:///home/emmaw/acme/app.py');
    // A UNC share's authority is not a host's.
    expect(canonicalHostUri(URI.parse('file://server/share/a.py'))).toBeNull();
  });

  /**
   * The whole way a diagnostic travels: the host's server names its plain
   * file, the client's converter puts the host back, and the markers are
   * stored under the canonical URI - which must be the open model's, or the
   * editor never shows them.
   */
  it("files a host server's diagnostics under the open model's URI", () => {
    const model = remote('/home/emmaw/acme/src/app.py');
    const conv = lspUriConverters(URI, HOST)!;
    const published = conv.protocol2Code('file:///home/emmaw/acme/src/app.py');
    expect(ours.asCanonicalUri(published).toString()).toBe(model.toString());
  });
});
