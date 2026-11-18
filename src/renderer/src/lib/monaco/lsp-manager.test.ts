import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { bridgeSlots } from '@renderer/test-support';
import { resetHostStatusesForTest } from '@renderer/lib/hosts/host-status';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { score } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languageSelector';

import { uriOf } from '@renderer/lib/remote-uri';

// Core reads the hosts and session-view bridges through the extension's slots.
beforeEach(() => installRendererExtension(bridgeSlots()));
afterEach(() => resetRendererExtensionForTest());

/**
 * The renderer's language clients per machine (plan 29 spec › 4.3, 4.4): the
 * client key, the options a host's client is built with (selector, workspace
 * folder, URI converters - checked against VS Code's own URI and selector
 * code), and the restart once a host that was away is back. The client class
 * is a stand-in that records its options; main is `window.api.lsp`.
 */

type ClientOptions = {
  documentSelector: Array<{ language: string; scheme?: string; pattern: string }>;
  workspaceFolder: { uri: URI; name: string };
  uriConverters?: { code2Protocol(u: URI): string; protocol2Code(s: string): URI };
};
const built: Array<{
  options: ClientOptions;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('monaco-editor', () => ({ Uri: URI }));
vi.mock('vscode-languageclient/browser', () => ({
  AbstractMessageReader: class {
    dispose(): void {
      // nothing held
    }
  },
  AbstractMessageWriter: class {},
  // The client the manager subclasses: records what each one was built with.
  BaseLanguageClient: class {
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    constructor(_id: string, _name: string, clientOptions: ClientOptions) {
      built.push({ options: clientOptions, start: this.start, stop: this.stop });
    }
  },
  CloseAction: { DoNotRestart: 1 },
  ErrorAction: { Continue: 1 },
}));

const { attachLanguageClient, clientKey, resetLanguageClientsForTest, retryLanguageClients } =
  await import('./lsp-manager');

const ROOT = '/home/emmaw/acme';
let startAnswer: (language: string, root: string) => { serverId?: string; code?: string };
let hostsChanged: ((list: Array<{ id: string; state: string }>) => void) | null;
const exits = new Map<string, () => void>();
let started: Array<{ language: string; root: string }>;

function model(uri: URI, language = 'python') {
  return { getLanguageId: () => language, uri } as unknown as Parameters<
    typeof attachLanguageClient
  >[0];
}

beforeEach(() => {
  built.length = 0;
  started = [];
  exits.clear();
  hostsChanged = null;
  let n = 0;
  startAnswer = () => ({ serverId: `lsp-${++n}` });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      lsp: {
        start: vi.fn(async (language: string, root: string) => {
          started.push({ language, root });
          return startAnswer(language, root);
        }),
        send: vi.fn(),
        stop: vi.fn(),
        onMessage: vi.fn(() => () => undefined),
        onExit: vi.fn((id: string, cb: () => void) => {
          exits.set(id, cb);
          return () => exits.delete(id);
        }),
      },
      hosts: {
        onChanged: vi.fn((cb: typeof hostsChanged) => {
          hostsChanged = cb;
          return () => undefined;
        }),
        statuses: vi.fn(async () => [{ id: 'h1', state: 'connected' }]),
      },
    },
  });
});

afterEach(() => {
  resetLanguageClientsForTest();
  resetHostStatusesForTest();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// The first import transforms the VS Code module graph cold.
describe('language clients per machine', { timeout: 60_000 }, () => {
  it('keys a client by machine, language and root', () => {
    expect(clientKey('h1', 'python', ROOT)).toBe(`h1::python::${ROOT}`);
    expect(clientKey(null, 'python', ROOT)).toBe(`local::python::${ROOT}`);
  });

  it("builds a host's client with the host selector, a plain root and the URI converters", async () => {
    attachLanguageClient(model(uriOf(URI, 'h1', `${ROOT}/app.py`)), ROOT, 'h1');
    await vi.waitFor(() => expect(built).toHaveLength(1));
    const { options } = built[0];
    expect(options.documentSelector).toEqual([
      { language: 'python', scheme: 'file', pattern: `//d0-host.h1${ROOT}/**` },
    ]);
    // The server runs on the host: its workspace folder is its own path.
    expect(options.workspaceFolder.uri.toString()).toBe(`file://${ROOT}`);
    expect(options.uriConverters).toBeDefined();
  });

  /** The plan's "diagnostics for a remote model". */
  it("files the host server's diagnostics under the host's model, which its selector matches", async () => {
    const remoteModel = uriOf(URI, 'h1', `${ROOT}/app.py`);
    attachLanguageClient(model(remoteModel), ROOT, 'h1');
    await vi.waitFor(() => expect(built).toHaveLength(1));
    const { options } = built[0];
    // textDocument/publishDiagnostics names the host's own path.
    const target = options.uriConverters!.protocol2Code(`file://${ROOT}/app.py`);
    expect(target.toString()).toBe(remoteModel.toString());
    expect(
      score(options.documentSelector, target, 'python', true, undefined, undefined),
    ).toBeGreaterThan(0);
    // didOpen tells the server its own path.
    expect(options.uriConverters!.code2Protocol(remoteModel)).toBe(`file://${ROOT}/app.py`);
  });

  it('keeps this machine as it was: the root pattern, no converters', async () => {
    attachLanguageClient(model(URI.file(`${ROOT}/app.py`)), ROOT);
    await vi.waitFor(() => expect(built).toHaveLength(1));
    expect(built[0].options.documentSelector).toEqual([
      { language: 'python', pattern: `${ROOT}/**` },
    ]);
    expect(built[0].options.uriConverters).toBeUndefined();
  });

  it('runs one client per machine for the same root, and refcounts within one', async () => {
    const offs = [
      attachLanguageClient(model(uriOf(URI, 'h1', `${ROOT}/a.py`)), ROOT, 'h1'),
      attachLanguageClient(model(uriOf(URI, 'h1', `${ROOT}/b.py`)), ROOT, 'h1'),
      attachLanguageClient(model(uriOf(URI, 'h2', `${ROOT}/a.py`)), ROOT, 'h2'),
      attachLanguageClient(model(URI.file(`${ROOT}/a.py`)), ROOT),
    ];
    await vi.waitFor(() => expect(built).toHaveLength(3));
    expect(started).toHaveLength(3);
    for (const off of offs) off();
  });

  it('waits for a host that is away and starts once it is connected again', async () => {
    startAnswer = () => ({ code: 'EHOSTDOWN' });
    attachLanguageClient(model(uriOf(URI, 'h1', `${ROOT}/app.py`)), ROOT, 'h1');
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await flush();
    expect(built).toHaveLength(0);
    hostsChanged!([{ id: 'h1', state: 'unreachable' }]);
    // A retried install for another machine does not start it.
    retryLanguageClients('python', null);
    await flush();
    expect(started).toHaveLength(1);
    startAnswer = () => ({ serverId: 'lsp-9' });
    hostsChanged!([{ id: 'h1', state: 'connected' }]);
    await vi.waitFor(() => expect(built).toHaveLength(1));
    expect(started).toHaveLength(2);
  });

  it('stops the client when its host server goes (clearing its diagnostics) and starts again', async () => {
    vi.useFakeTimers();
    attachLanguageClient(model(uriOf(URI, 'h1', `${ROOT}/app.py`)), ROOT, 'h1');
    await vi.waitFor(() => expect(built).toHaveLength(1));
    exits.get('lsp-1')!();
    expect(built[0].stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toHaveLength(2);
  });
});
