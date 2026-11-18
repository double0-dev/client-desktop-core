import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * How a Pro module registers its IPC (a private plan ›
 * Entitlement): never on `ipcMain` directly, always through a registrar bound
 * to its feature, so a call made while the feature is not entitled is answered
 * `ELOCKED` without reaching the handler - a locked build must not merely hide
 * the UI, the renderer could be driven. `ipcMain` itself has this shape, which
 * is what a module's own test passes.
 */
// `any[]`, as Electron types `ipcMain.handle`'s listener - each handler
// validates its own payload (they arrive untyped over the wire anyway).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcSendListener = (event: IpcMainEvent, ...args: any[]) => void;

export type IpcRegistrar = {
  handle(channel: string, listener: IpcListener): void;
  removeHandler(channel: string): void;
};

/**
 * What `ctx.ipcFor(feature)` hands a Pro module: `IpcRegistrar` plus `on`, a
 * fire-and-forget channel (`ipcRenderer.send`, no reply), gated the same way.
 * Returns the unsubscribe.
 */
export type FeatureRegistrar = IpcRegistrar & {
  on(channel: string, listener: IpcSendListener): () => void;
};

/** What a registrar wraps: `ipcMain`'s shape. */
type IpcTarget = IpcRegistrar & {
  on?(channel: string, listener: IpcSendListener): unknown;
  removeListener?(channel: string, listener: IpcSendListener): unknown;
};

export const LOCKED = { error: 'This is a Pro feature.', code: 'ELOCKED' } as const;

/** `ipc` with every handler gated on `entitled()`, asked per call (a trial can end mid-run). */
export function featureIpc(ipc: IpcTarget, entitled: () => boolean): FeatureRegistrar {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => (entitled() ? listener(event, ...args) : LOCKED));
    },
    removeHandler(channel) {
      ipc.removeHandler(channel);
    },
    // A message has no reply to lock: while the feature is not entitled it is
    // dropped, never handed to the listener.
    on(channel, listener) {
      const gated: IpcSendListener = (event, ...args) => {
        if (entitled()) listener(event, ...args);
      };
      ipc.on?.(channel, gated);
      return () => {
        ipc.removeListener?.(channel, gated);
      };
    },
  };
}
