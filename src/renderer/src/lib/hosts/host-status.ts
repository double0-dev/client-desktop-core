import type { HostStatusFeed } from '@renderer/lib/extension/types';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { useSyncExternalStore } from 'react';
import type { HostStatusPayload } from '../../../../preload/index';

/**
 * What main says about each host (a private plan › 9.4):
 * its connection state, the last message and stderr, the facts it learned.
 * Machine state, not a setting - main pushes it with `hosts:changed`, this
 * window asks once at load.
 */
export type HostStatus = HostStatusPayload;

let statuses: Record<string, HostStatus> = {};
const listeners = new Set<() => void>();
const connectedListeners = new Set<(hostId: string) => void>();

export function applyHostStatuses(list: HostStatus[]): void {
  const prev = statuses;
  const next: Record<string, HostStatus> = {};
  for (const s of list) next[s.id] = s;
  statuses = next;
  for (const l of listeners) l();
  // A host that is connected now and was not (or was not known yet - this
  // window's first answer): whatever failed while it was away tries again.
  for (const s of list) {
    if (s.state !== 'connected' || prev[s.id]?.state === 'connected') continue;
    for (const l of [...connectedListeners]) l(s.id);
  }
}

/**
 * THE "this host is connected again" hook: `listener(hostId)` runs each time a
 * host turns `connected` - after a drop, after the first connect of a launch,
 * and for a host already connected when this window first hears of it. Every
 * renderer surface that read a host while it was away retries here (the
 * language clients, the explorer, an editor that failed to load) instead of
 * keeping its own copy of the feed. Returns the unsubscribe.
 */
export function onHostConnected(listener: (hostId: string) => void): () => void {
  startHostStatusFeed();
  connectedListeners.add(listener);
  return () => connectedListeners.delete(listener);
}

/** The status feed, from the extension's hosts slot; none in the core build. */
function hostsBridge(): HostStatusFeed | undefined {
  return rendererExtension().hosts?.statusFeed();
}

let started = false;
/** Subscribe to main once per window (idempotent). */
export function startHostStatusFeed(): void {
  const bridge = hostsBridge();
  if (started || !bridge) return;
  started = true;
  bridge.onChanged(applyHostStatuses);
  void bridge.statuses().then((list) => {
    if (Array.isArray(list)) applyHostStatuses(list);
  });
}

export function getHostStatus(id: string | null | undefined): HostStatus | null {
  return id ? (statuses[id] ?? null) : null;
}

/**
 * Resolves with the host's status once `test` accepts it (checked now and on
 * every change), or null after `timeoutMs` - for a step that must wait on
 * main, such as a reconnect with the agent forward live.
 */
export function waitForHostStatus(
  id: string,
  test: (status: HostStatus) => boolean,
  timeoutMs: number,
): Promise<HostStatus | null> {
  return new Promise((resolve) => {
    let off = (): void => {};
    const finish = (status: HostStatus | null): void => {
      clearTimeout(timer);
      off();
      resolve(status);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const check = (): void => {
      const s = statuses[id];
      if (s && test(s)) finish(s);
    };
    off = subscribe(check);
    check();
  });
}

function subscribe(listener: () => void): () => void {
  startHostStatusFeed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getAll = (): Record<string, HostStatus> => statuses;

export function useHostStatuses(): Record<string, HostStatus> {
  return useSyncExternalStore(subscribe, getAll);
}

export function useHostStatus(id: string | null | undefined): HostStatus | null {
  const all = useHostStatuses();
  return id ? (all[id] ?? null) : null;
}

/** The state pill's words. */
export const HOST_STATE_LABEL: Record<HostStatus['state'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  installing: 'Installing',
  connected: 'Connected',
  unreachable: 'Unreachable',
  'needs-login': 'Needs login',
  error: 'Error',
};

/** Tests. */
export function resetHostStatusesForTest(): void {
  statuses = {};
  started = false;
  listeners.clear();
  connectedListeners.clear();
}
