import { describe, expect, it } from 'vitest';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { score } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languageSelector';

import { uriOf } from '@renderer/lib/remote-uri';
import { lspSelectorPattern, lspUriConverters } from './lsp-uri';

/**
 * What a host's language server sees of the editor's URIs (plan 29 spec ›
 * 4.3), with VS Code's own URI class and its own document selector scoring -
 * the code vscode-languageclient runs.
 */

const HOST = 'h1';
const remote = (path: string) => uriOf(URI, HOST, path);

// The first import transforms the VS Code module graph cold.
describe('host URI converters', { timeout: 60_000 }, () => {
  const conv = lspUriConverters(URI, HOST)!;

  it('strips the host authority on the way out and puts it back on the way in', () => {
    const model = remote('/home/emmaw/acme/app.py');
    const wire = conv.code2Protocol(model);
    expect(wire).toBe('file:///home/emmaw/acme/app.py');
    const back = conv.protocol2Code(wire);
    expect(back.toString()).toBe(model.toString());
    expect(back.authority).toBe('d0-host.h1');
    // A path that needs escaping survives the round trip.
    const spaced = remote('/home/emmaw/acme/my notes/ü.py');
    expect(conv.protocol2Code(conv.code2Protocol(spaced)).toString()).toBe(spaced.toString());
  });

  /** A diagnostic's (or a definition's) URI the server names: that host's file. */
  it("maps the server's own files - outside the project too - to the host's model", () => {
    const diag = conv.protocol2Code('file:///home/emmaw/acme/app.py');
    expect(diag.toString()).toBe(remote('/home/emmaw/acme/app.py').toString());
    const site = conv.protocol2Code(
      'file:///home/emmaw/acme/.venv/lib/python3.10/site-packages/requests/api.py',
    );
    expect(site.authority).toBe('d0-host.h1');
    expect(site.path).toBe('/home/emmaw/acme/.venv/lib/python3.10/site-packages/requests/api.py');
  });

  /**
   * A URI that already went through a converter (a client handing back what
   * it got, a definition result re-sent) must not gain or lose anything a
   * second time - a doubled authority names a file that does not exist.
   */
  it('is stable on an already converted URI, both ways', () => {
    const model = remote('/home/emmaw/acme/src/app.py');
    const back = conv.protocol2Code(model.toString());
    expect(back.toString()).toBe(model.toString());
    expect(back.path).toBe('/home/emmaw/acme/src/app.py');
    const wire = conv.code2Protocol(model);
    expect(conv.code2Protocol(URI.parse(wire))).toBe(wire);
    expect(conv.code2Protocol(conv.protocol2Code(wire))).toBe(wire);
  });

  it('leaves other schemes and other authorities alone', () => {
    expect(conv.protocol2Code('untitled:Untitled-1').scheme).toBe('untitled');
    expect(conv.protocol2Code('file://server/share/a.py').authority).toBe('server');
    const other = uriOf(URI, 'h2', '/home/emmaw/acme/app.py');
    expect(conv.code2Protocol(other)).toBe(other.toString());
  });

  it('has none for this machine (the defaults stand)', () => {
    expect(lspUriConverters(URI, null)).toBeNull();
  });
});

describe('the document selector for a host client', { timeout: 60_000 }, () => {
  const ROOT = '/home/emmaw/acme';
  const matches = (selector: object, uri: URI) =>
    score(selector, uri, 'python', true, undefined, undefined) > 0;

  it("matches the host's models under its root, never a local model at the same path", () => {
    const hostSelector = {
      language: 'python',
      scheme: 'file',
      pattern: lspSelectorPattern(HOST, ROOT),
    };
    expect(matches(hostSelector, remote(`${ROOT}/src/app.py`))).toBe(true);
    expect(matches(hostSelector, URI.file(`${ROOT}/src/app.py`))).toBe(false);
    expect(matches(hostSelector, uriOf(URI, 'h2', `${ROOT}/src/app.py`))).toBe(false);
    expect(matches(hostSelector, remote('/home/emmaw/other/app.py'))).toBe(false);
  });

  /** The bug the pattern fixes: the local pattern never matched a remote model. */
  it('a plain root pattern matches local models only', () => {
    const local = { language: 'python', pattern: lspSelectorPattern(null, ROOT) };
    expect(matches(local, URI.file(`${ROOT}/src/app.py`))).toBe(true);
    expect(matches(local, remote(`${ROOT}/src/app.py`))).toBe(false);
  });
});
