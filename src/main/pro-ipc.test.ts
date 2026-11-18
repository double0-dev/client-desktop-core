import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { LOCKED, featureIpc, type IpcListener, type IpcSendListener } from './pro-ipc';

function fakeIpc() {
  const handlers = new Map<string, IpcListener>();
  const listeners = new Map<string, Set<IpcSendListener>>();
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, listener: IpcListener) => void handlers.set(channel, listener)),
    removeHandler: vi.fn((channel: string) => void handlers.delete(channel)),
    on: vi.fn((channel: string, listener: IpcSendListener) => {
      listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
    }),
    removeListener: vi.fn((channel: string, listener: IpcSendListener) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
}
const event = {} as IpcMainInvokeEvent;

describe('featureIpc', () => {
  it('answers ELOCKED without running the handler while the feature is not entitled', async () => {
    // A locked build must not merely hide the UI: the renderer can be driven
    // to call any channel, so the gate sits in main.
    const ipc = fakeIpc();
    const listener = vi.fn(() => ({ ok: true }));
    featureIpc(ipc, () => false).handle('example:list', listener);
    expect(await ipc.handlers.get('example:list')!(event)).toEqual(LOCKED);
    expect(listener).not.toHaveBeenCalled();
  });

  it('runs the handler with its arguments while entitled', async () => {
    const ipc = fakeIpc();
    const listener = vi.fn((_e: IpcMainInvokeEvent, payload: { root: string }) => payload.root);
    featureIpc(ipc, () => true).handle('example:list', listener);
    expect(await ipc.handlers.get('example:list')!(event, { root: '/acme' })).toBe('/acme');
  });

  it('asks on every call, so a feature that lapses locks at once', async () => {
    let entitled = true;
    const ipc = fakeIpc();
    featureIpc(ipc, () => entitled).handle('example:list', () => 'data');
    expect(await ipc.handlers.get('example:list')!(event)).toBe('data');
    entitled = false;
    expect(await ipc.handlers.get('example:list')!(event)).toEqual(LOCKED);
  });

  it('removes a handler from the underlying ipc', () => {
    const ipc = fakeIpc();
    const registrar = featureIpc(ipc, () => true);
    registrar.handle('example:list', () => null);
    registrar.removeHandler('example:list');
    expect(ipc.handlers.has('example:list')).toBe(false);
  });

  // A fire-and-forget message has no reply to lock: while the feature is not
  // entitled it must never reach the listener (a renderer can be driven).
  it('drops a message sent while the feature is not entitled, and unsubscribes', () => {
    const ipc = fakeIpc();
    let entitled = false;
    const listener = vi.fn();
    const off = featureIpc(ipc, () => entitled).on('example:ping', listener);
    const send = (): void => {
      for (const l of ipc.listeners.get('example:ping') ?? []) l({} as IpcMainEvent, 'x');
    };
    send();
    expect(listener).not.toHaveBeenCalled();
    entitled = true;
    send();
    expect(listener).toHaveBeenCalledWith(expect.anything(), 'x');
    off();
    expect(ipc.listeners.get('example:ping')?.size).toBe(0);
  });
});
