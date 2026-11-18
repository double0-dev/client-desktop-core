import { is } from '@electron-toolkit/utils';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * Origin the packaged renderer is served from (see `installAppProtocol` in
 * index.ts). A privileged custom scheme instead of file:// so responses carry
 * real headers - file:// loads can't have a CSP header attached.
 */
export const APP_ORIGIN = 'app://renderer';

/**
 * True if `url` is the app's own renderer: the Vite dev server in development,
 * or the app:// origin the packaged renderer is served from. Everything else
 * (file://, arbitrary http(s), other custom schemes) is foreign.
 */
export function isAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Node's WHATWG URL reports a null origin for non-special schemes, so compare
  // protocol + host directly rather than `origin`.
  if (`${parsed.protocol}//${parsed.host}` === APP_ORIGIN) return true;
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  if (devUrl) {
    try {
      return parsed.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * True if an IPC message came from the app's own renderer: the sender's MAIN
 * frame (no embedded frame gets to speak privileged IPC) and that frame is on
 * the app's own origin. Handlers should silently bail when this is false.
 */
export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return isAppUrl(frame.url);
}
