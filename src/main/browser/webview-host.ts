import { app, ipcMain, net, session, type Session, type WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeFor, runtimeReady } from '../host-runtime';
import { isTrustedSender } from '../ipc-util';
import { hostPathWithin, isWithin } from '../path-within';
import {
  BROWSER_PARTITION,
  PREVIEW_SCHEME,
  isAllowedPermission,
  isBrowsableUrl,
  vetWebviewAttach,
} from './guard';
import { MAX_HOST_PREVIEW_BYTES, PreviewRegistry, previewContentType } from './preview';

/**
 * The `<webview>` plumbing every window gets (a private plan)
 * - core, because the editor's file preview is a webview on the browser
 * partition too (a private plan › M5, open question 10):
 * every attach vetted (guard.ts), each guest's popups, navigations and the
 * app's shortcuts guarded, the partition's permissions, the `d0-preview` file
 * protocol and `browser:previewUrl`. Browser tabs (Pro) add their page state
 * through `onGuestAttached`.
 */

const previews = new PreviewRegistry();

type GuestListener = (guest: WebContents, host: WebContents) => void;
const attachedListeners = new Set<GuestListener>();

/** Every guest a window attaches, right after the guards are on it. */
export function onGuestAttached(listener: GuestListener): () => void {
  attachedListeners.add(listener);
  return () => attachedListeners.delete(listener);
}

/**
 * Configure the browser partition (once, after ready) and guard every
 * `<webview>` the app's windows attach.
 */
export function installBrowserGuards(): void {
  const ses = session.fromPartition(BROWSER_PARTITION);
  restorePreviewTokens();
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isAllowedPermission(permission)),
  );
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission));
  installPreviewProtocol(ses);

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('will-attach-webview', (event, prefs, params) => {
      const refusal = vetWebviewAttach(prefs, params);
      if (refusal) {
        console.warn(`[browser] refused a webview: ${refusal}`);
        event.preventDefault();
      }
    });
    // Policy goes on the guest the moment it exists, before its first
    // navigation can race past it.
    contents.on('did-attach-webview', (_e, guest) => guardGuest(guest, contents));
  });
}

function guardGuest(guest: WebContents, host: WebContents): void {
  // No page opens a window of its own. A browser tab (Pro) turns a popup into
  // a new tab next to it (its attach listener re-sets this handler, still
  // denying the window).
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: { preventDefault: () => void }, url: string): void => {
    if (!isBrowsableUrl(url)) event.preventDefault();
  };
  guest.on('will-navigate', block);
  guest.on('will-redirect', block);
  for (const listener of attachedListeners) listener(guest, host);
}

/**
 * Preview tokens are kept across runs, or a restored tab showing a file would
 * load a token this run never minted (review, 2026-10-06).
 */
function restorePreviewTokens(): void {
  const file = join(app.getPath('userData'), 'browser-previews.json');
  try {
    previews.load(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // First run, or an unreadable file - tokens are minted afresh.
  }
  previews.onChange = () => {
    try {
      writeFileSync(file, JSON.stringify(previews.entries()), { mode: 0o600 });
    } catch (err) {
      console.warn('[browser] could not save preview tokens', err);
    }
  };
}

/** The host a `d0-preview:` URL serves files of: an id, null = this machine, undefined = no such token. */
export function previewHostOf(url: string): string | null | undefined {
  const entry = previews.entryOf(url);
  return entry ? entry.hostId : undefined;
}

/**
 * A remote host's file for a preview (plan 29 spec › 7.5): read through the
 * host's files, confined to the token's folder by a realpath check ON THE
 * HOST, a regular file within the 32 MB cap. Null = not found. A token whose
 * folder no longer resolves to the same host (the project moved) serves
 * nothing.
 */
export async function readHostPreview(
  hostId: string,
  root: string,
  target: string,
): Promise<{ body: Buffer; type: string } | null> {
  const rt = runtimeFor(root);
  if (rt.remote?.hostId !== hostId) return null;
  try {
    const [real, realRoot] = await Promise.all([rt.realpath(target), rt.realpath(root)]);
    if (real === realRoot || !hostPathWithin(real, realRoot)) return null;
    const st = await rt.fs.stat(real);
    if (!st.isFile() || st.size > MAX_HOST_PREVIEW_BYTES) return null;
    const body = (await rt.fs.readFile(real)) as Buffer;
    return { body, type: previewContentType(real) };
  } catch {
    return null;
  }
}

function installPreviewProtocol(ses: Session): void {
  ses.protocol.handle(PREVIEW_SCHEME, async (request) => {
    const target = previews.resolve(request.url);
    const entry = previews.entryOf(request.url);
    const root = entry?.root ?? null;
    if (!target || !root) return new Response('Not found', { status: 404 });
    if (entry?.hostId) {
      await runtimeReady();
      const file = await readHostPreview(entry.hostId, root, target);
      if (!file) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(file.body), {
        status: 200,
        headers: { 'content-type': file.type, 'content-length': String(file.body.length) },
      });
    }
    try {
      // Symlinks are followed by the read: what it really points at must be
      // under the folder too - a link in a cloned repo to ~/.ssh/id_rsa would
      // otherwise be readable by that repo's page (review, 2026-10-06).
      const [real, realRoot] = await Promise.all([realpath(target), realpath(root)]);
      if (!isWithin(real, realRoot)) return new Response('Not found', { status: 404 });
      if (!(await stat(real)).isFile()) return new Response('Not found', { status: 404 });
      // net.fetch picks the Content-Type from the extension.
      return await net.fetch(pathToFileURL(real).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const CHANNELS = ['browser:previewUrl'] as const;

/** `browser:previewUrl` - the editor's preview and a browser tab load files through it. */
export function registerPreviewIpc(): () => void {
  // A workspace file as a `d0-preview://` URL a browser tab can load.
  ipcMain.handle('browser:previewUrl', async (event, p: { root?: unknown; file?: unknown }) => {
    if (!isTrustedSender(event)) return null;
    if (typeof p?.root !== 'string' || typeof p?.file !== 'string') return null;
    if (p.root.includes('\0') || p.file.includes('\0')) return null;
    // A folder on a remote host (plan 29 spec › 7.5): the token records the
    // host, and the handler reads through its files.
    await runtimeReady();
    const rt = runtimeFor(p.root);
    const hostId = rt.remote?.hostId ?? null;
    try {
      if (!(await (hostId ? rt.fs.stat(p.root) : stat(p.root))).isDirectory()) return null;
    } catch {
      return null;
    }
    return previews.urlFor(p.root, p.file, hostId);
  });

  return () => {
    for (const c of CHANNELS) ipcMain.removeHandler(c);
  };
}
