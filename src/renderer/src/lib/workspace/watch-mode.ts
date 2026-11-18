import { useSyncExternalStore } from 'react';
import { isWithin } from '@renderer/lib/path-within';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';

/**
 * How main watches each project folder this window asked to watch
 * (`fs:watch`'s `mode`, a private plan › 11.2): a Linux
 * host past its inotify budget polls instead, and the explorer says so in its
 * footer ("polling (large tree)"). A local watch never answers a mode.
 */
export type WatchMode = 'native' | 'poll';

/**
 * Keyed by the machine AND the path (`<hostId>|<path>`, `|<path>` locally):
 * the same path string on two machines is two folders.
 */
let modes: Record<string, WatchMode> = {};
const keyOf = (root: string): string => `${currentHostOfPath(root) ?? ''}|${root}`;
const pathOfKey = (key: string): { host: string; path: string } => {
  const at = key.indexOf('|');
  return { host: key.slice(0, at), path: key.slice(at + 1) };
};
/** Watch refs per root this window holds (main ref-counts the OS watcher the same way). */
const refs = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Record what `fs.watch(root)` answered (an absent mode forgets the root). */
export function noteWatchMode(root: string, mode: WatchMode | undefined | null): void {
  const key = keyOf(root);
  if ((modes[key] ?? null) === (mode ?? null)) return;
  const next = { ...modes };
  if (mode) next[key] = mode;
  else delete next[key];
  modes = next;
  emit();
}

/** The mode of the watch covering `path` (its own root, else the one holding it). */
export function watchModeOf(
  path: string,
  table: Record<string, WatchMode> = modes,
): WatchMode | null {
  const host = currentHostOfPath(path) ?? '';
  let best: { key: string; length: number } | null = null;
  for (const key of Object.keys(table)) {
    const k = pathOfKey(key);
    if (k.host !== host || !isWithin(path, k.path)) continue;
    if (!best || k.path.length > best.length) best = { key, length: k.path.length };
  }
  return best ? table[best.key] : null;
}

/** `fs.watch(root)` that records the mode main answered - the watch callers use it. */
export function watchFolder(root: string): void {
  const fs = window.api?.fs;
  if (!fs?.watch) return;
  listenForModeChanges();
  const key = keyOf(root);
  refs.set(key, (refs.get(key) ?? 0) + 1);
  void Promise.resolve(fs.watch(root))
    // An answer that lands after the last unwatch is about nothing any more.
    .then((res) => {
      if (refs.has(key)) noteWatchMode(root, res?.mode);
    })
    .catch(() => undefined);
}

let listening = false;
/**
 * A remote watch that switches to polling later (native watching ran out)
 * says so with its next change notice (`fs:changed` › `mode`).
 */
function listenForModeChanges(): void {
  const on = window.api?.fs?.onChanged;
  if (listening || !on) return;
  listening = true;
  on((root, _paths, mode) => {
    if (mode && refs.has(keyOf(root))) noteWatchMode(root, mode);
  });
}

/** Drop a watch ref (and the mode once nothing asks for it). */
export function unwatchFolder(root: string): void {
  void window.api?.fs?.unwatch(root);
  const key = keyOf(root);
  const left = (refs.get(key) ?? 1) - 1;
  if (left > 0) {
    refs.set(key, left);
    return;
  }
  refs.delete(key);
  noteWatchMode(root, null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatchMode(path: string | null | undefined): WatchMode | null {
  return useSyncExternalStore(subscribe, () => (path ? watchModeOf(path) : null));
}

/** Tests. */
export function resetWatchModesForTest(): void {
  modes = {};
  refs.clear();
  listeners.clear();
  listening = false;
}
