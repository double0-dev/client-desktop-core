import * as monaco from 'monaco-editor';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  BaseLanguageClient,
  CloseAction,
  ErrorAction,
  type DataCallback,
  type Disposable,
  type LanguageClientOptions,
  type Message,
  type MessageTransports,
} from 'vscode-languageclient/browser';

import { fileName } from '@renderer/lib/utils';
import { getHostStatus, onHostConnected } from '@renderer/lib/hosts/host-status';
import { lspSelectorPattern, lspUriConverters } from '@renderer/lib/monaco/lsp-uri';

/**
 * Renderer side of the LSP integration: one language client per
 * (machine × language × project root), talking to a server main runs - here,
 * or on the root's remote host (a private plan
 * › 4.3, which adds the URI converters and the host-aware selector) - through
 * the `window.api.lsp` bridge (main frames stdio; this side owns the whole
 * protocol). The client wires completions/hover/definition/references/rename/
 * diagnostics/… into Monaco itself - nothing here touches providers directly.
 *
 * Attachment is per-editor: the Monaco wrapper attaches its model's
 * (language, root); the first attach starts the client, later ones refcount.
 * Whether a language actually HAS a server is main's call - an attach for an
 * unserved language costs one `lsp:start` that answers NOT_FOUND and is
 * negative-cached for the session.
 */

/** LSP traffic goes through the preload bridge: writes are fire-and-forget
 * sends, reads a per-server subscription. */
class IpcMessageReader extends AbstractMessageReader {
  private off: (() => void) | null = null;
  constructor(private readonly serverId: string) {
    super();
  }
  listen(callback: DataCallback): Disposable {
    this.off = window.api!.lsp.onMessage(this.serverId, (message) => callback(message as Message));
    return { dispose: () => this.dispose() };
  }
  override dispose(): void {
    super.dispose();
    this.off?.();
    this.off = null;
  }
}

class IpcMessageWriter extends AbstractMessageWriter {
  constructor(private readonly serverId: string) {
    super();
  }
  async write(msg: Message): Promise<void> {
    window.api!.lsp.send(this.serverId, msg);
  }
  end(): void {
    // stdio closes when main kills the process; nothing to flush.
  }
}

/**
 * vscode-languageclient's client over the IPC transports above, running
 * against the `vscode` extension API the monaco-vscode services provide.
 */
class IpcLanguageClient extends BaseLanguageClient {
  constructor(
    name: string,
    clientOptions: LanguageClientOptions,
    private readonly transports: MessageTransports,
  ) {
    super(name.toLowerCase(), name, clientOptions);
  }
  protected createMessageTransports(): Promise<MessageTransports> {
    return Promise.resolve(this.transports);
  }
}

type ClientEntry = {
  refs: number;
  /** Resolves when the client is up (or definitively not starting). */
  starting: Promise<void>;
  serverId: string | null;
  client: IpcLanguageClient | null;
  offExit: (() => void) | null;
  /** NOT_FOUND / start failure - don't retry for the session. */
  dead: boolean;
  /** The host was away at the start: retried once it is connected again. */
  waitingForHost: boolean;
};

const clients = new Map<string, ClientEntry>();

type UriConvertersOption = LanguageClientOptions['uriConverters'];

/** `${hostId ?? 'local'}::${language}::${root}` (spec 4.3). */
export function clientKey(hostId: string | null, language: string, root: string): string {
  return `${hostId ?? 'local'}::${language}::${root}`;
}

async function startClient(
  entry: ClientEntry,
  language: string,
  root: string,
  hostId: string | null,
): Promise<void> {
  const bridge = window.api?.lsp;
  if (!bridge) {
    entry.dead = true;
    return;
  }
  const res = await bridge.start(language, root);
  if (!res.serverId) {
    entry.dead = true;
    // A host that is away answers EHOSTDOWN: this client waits for it.
    entry.waitingForHost = !!hostId && res.code === 'EHOSTDOWN';
    // Connected again before this answer came back: no change will say so.
    if (entry.waitingForHost && hostId && getHostStatus(hostId)?.state === 'connected') {
      setTimeout(() => retryHostLanguageClients(hostId), HOST_RECHECK_MS);
    }
    return;
  }
  // All refs released while lsp:start was in flight.
  if (entry.refs <= 0) {
    bridge.stop(res.serverId);
    return;
  }
  entry.serverId = res.serverId;

  const transports: MessageTransports = {
    reader: new IpcMessageReader(res.serverId),
    writer: new IpcMessageWriter(res.serverId),
  };
  const converters = lspUriConverters(monaco.Uri, hostId);
  const client = new IpcLanguageClient(
    `${language} language server`,
    {
      // A host's models are `file://d0-host.<id>/…` - the selector names the
      // authority (lsp-uri.ts) or no remote model would ever match.
      documentSelector: [
        hostId
          ? { language, scheme: 'file', pattern: lspSelectorPattern(hostId, root) }
          : { language, pattern: lspSelectorPattern(null, root) },
      ],
      // A plain `file:` URI even for a host: the server runs there and the
      // root is its own path.
      workspaceFolder: { uri: monaco.Uri.file(root), name: fileName(root), index: 0 },
      ...(converters
        ? { uriConverters: converters as unknown as NonNullable<UriConvertersOption> }
        : {}),
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        // Restarts are main's job (lsp:exit → re-ensure below), with a
        // main-side cap - the client itself must not fight it.
        closed: () => ({ action: CloseAction.DoNotRestart }),
      },
    },
    transports,
  );
  entry.client = client;

  entry.offExit = bridge.onExit(res.serverId, () => {
    // Server died under us: tear the client down and restart on the SAME
    // entry (live editors hold detach closures against it) - main's restart
    // cap keeps a crash-looping server from thrashing.
    entry.offExit?.();
    entry.offExit = null;
    entry.client = null;
    entry.serverId = null;
    void client.stop().catch(() => {});
    if (entry.refs > 0) {
      setTimeout(() => {
        if (entry.refs > 0 && !entry.client && !entry.dead) {
          entry.starting = startClient(entry, language, root, hostId);
        }
      }, 1000);
    }
  });

  try {
    await client.start();
  } catch {
    entry.dead = true;
    entry.client = null;
    entry.offExit?.();
    entry.offExit = null;
    bridge.stop(res.serverId);
    entry.serverId = null;
  }
}

let offHostFeed: (() => void) | null = null;
const HOST_RECHECK_MS = 3000;

/** Hear host state changes once (spec 4.4): a host that comes back restarts its clients. */
function watchHosts(): void {
  if (offHostFeed) return;
  offHostFeed = onHostConnected(retryHostLanguageClients);
}

type Keyed = { entry: ClientEntry; language: string; root: string; hostId: string | null };
const keyed = new Map<ClientEntry, Keyed>();

function ensure(language: string, root: string, hostId: string | null): ClientEntry {
  const key = clientKey(hostId, language, root);
  let entry = clients.get(key);
  if (entry) return entry;
  entry = {
    refs: 0,
    starting: Promise.resolve(),
    serverId: null,
    client: null,
    offExit: null,
    dead: false,
    waitingForHost: false,
  };
  keyed.set(entry, { entry, language, root, hostId });
  if (hostId) watchHosts();
  entry.starting = startClient(entry, language, root, hostId);
  clients.set(key, entry);
  return entry;
}

function release(key: string, entry: ClientEntry): void {
  entry.refs--;
  if (entry.refs > 0) return;
  clients.delete(key);
  keyed.delete(entry);
  entry.offExit?.();
  entry.offExit = null;
  void entry.starting.then(() => {
    void entry.client?.stop().catch(() => {});
    entry.client = null;
    // Main keeps the process warm for its idle window; a quick tab reopen
    // costs a new initialize handshake, not a server cold start.
    if (entry.serverId) window.api?.lsp.stop(entry.serverId);
    entry.serverId = null;
  });
}

/**
 * A server for `language` just became available (installed via Settings or
 * the editor banner): clear the negative cache and start clients for every
 * root that still has editors attached - they get diagnostics live, without
 * reopening tabs.
 */
export function retryLanguageClients(language: string, hostId: string | null = null): void {
  for (const entry of clients.values()) {
    const k = keyed.get(entry);
    if (!k || k.language !== language || k.hostId !== hostId) continue;
    if (entry.dead && entry.refs > 0) {
      entry.dead = false;
      entry.waitingForHost = false;
      entry.starting = startClient(entry, k.language, k.root, k.hostId);
    }
  }
}

/**
 * A host is connected again (spec 4.4): every client of it that the bridge
 * drop (or the host being away at its start) left without a server starts
 * one - the drop already cleared its diagnostics with the stopped client.
 */
export function retryHostLanguageClients(hostId: string): void {
  for (const entry of clients.values()) {
    const k = keyed.get(entry);
    if (!k || k.hostId !== hostId || !entry.waitingForHost || entry.refs <= 0) continue;
    entry.dead = false;
    entry.waitingForHost = false;
    entry.starting = startClient(entry, k.language, k.root, k.hostId);
  }
}

/**
 * Attach language support for a model within a project root. Returns the
 * detach function. No-op (but still safe to call) for languages without a
 * server or outside the desktop app.
 */
export function attachLanguageClient(
  model: monaco.editor.ITextModel,
  root: string,
  hostId: string | null = null,
): () => void {
  const language = model.getLanguageId();
  if (!window.api?.lsp || !language || language === 'plaintext') return () => {};
  const entry = ensure(language, root, hostId);
  entry.refs++;
  return () => release(clientKey(hostId, language, root), entry);
}

/** Tests: drop every client. */
export function resetLanguageClientsForTest(): void {
  clients.clear();
  keyed.clear();
  offHostFeed?.();
  offHostFeed = null;
}
