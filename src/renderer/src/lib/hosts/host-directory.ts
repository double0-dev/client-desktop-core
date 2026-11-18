import { useSyncExternalStore } from 'react';

/**
 * Which remote hosts this machine knows, as core reads them: an id and the
 * label the user gave it - the explorer's "on <host>", the unreachable
 * banner, Search Everywhere's subtitles, an extension's status bar items. The hosts
 * themselves are the official build's (a private plan ›
 * M7): their store registers as the source when it loads, so in the core
 * build - where nothing loads it - every list is empty and every label falls
 * back to the reader's own wording.
 */
export type HostEntry = { id: string; label: string };

type HostSource = {
  list(): readonly HostEntry[];
  subscribe(listener: () => void): () => void;
};

const NONE: readonly HostEntry[] = [];
let source: HostSource | null = null;

/** The hosts store calls this once, at load. */
export function registerHostSource(next: HostSource): void {
  source = next;
}

const subscribe = (listener: () => void): (() => void) =>
  source ? source.subscribe(listener) : () => {};
const snapshot = (): readonly HostEntry[] => (source ? source.list() : NONE);

/** Every host, live. */
export function useHosts(): readonly HostEntry[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Every host, now (outside React). */
export function getHosts(): readonly HostEntry[] {
  return snapshot();
}

/** One host by id, now. */
export function getHost(id: string | null | undefined): HostEntry | null {
  return id ? (snapshot().find((h) => h.id === id) ?? null) : null;
}

/** For tests: forget the registered source. */
export function resetHostSourceForTest(): void {
  source = null;
}
