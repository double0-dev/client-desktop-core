import { useSyncExternalStore } from 'react';
import { railTabIds, type RailTabId } from '@renderer/lib/workspace/dock-state';

/**
 * The icon rail's layout: drag a rail icon to reorder it, or drop it past the
 * spacer into the bottom cluster that sits next to the Commands toggle. A tiny
 * localStorage-backed store following the same pattern as vertical-tabs.ts:
 * module-level state, a `storage` listener fanning changes to other windows,
 * and applied directly by the settings import (`applyAppSettings` calls
 * `setRailOrder`).
 */

export const RAIL_ORDER_KEY = 'double0-rail-order';

export type RailSection = 'top' | 'bottom';
export type RailOrder = { top: RailTabId[]; bottom: RailTabId[] };

/**
 * Coerce a stored/imported value into a valid layout: known tool ids only, no
 * duplicates (the top cluster wins), and any tool the value doesn't mention -
 * a tool added after the order was saved, or a hand-edited import - joins the
 * end of the top cluster so it can't vanish from the rail.
 */
export function sanitizeRailOrder(raw: unknown): RailOrder {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as { top?: unknown; bottom?: unknown };
  const catalog = railTabIds();
  const known = (value: unknown): RailTabId[] =>
    Array.isArray(value)
      ? value.filter((id): id is RailTabId => catalog.includes(id as string))
      : [];
  const top: RailTabId[] = [];
  for (const id of known(doc.top)) if (!top.includes(id)) top.push(id);
  const bottom: RailTabId[] = [];
  for (const id of known(doc.bottom)) {
    if (!top.includes(id) && !bottom.includes(id)) bottom.push(id);
  }
  for (const id of catalog) if (!top.includes(id) && !bottom.includes(id)) top.push(id);
  return { top, bottom };
}

function load(): RailOrder {
  if (typeof window === 'undefined') return sanitizeRailOrder(null);
  try {
    const raw = window.localStorage.getItem(RAIL_ORDER_KEY);
    return sanitizeRailOrder(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeRailOrder(null);
  }
}

// Loaded on first read, never at module load: the catalog includes the
// extension's tools, and main.tsx installs the extension after every import ran.
// Re-read when the catalog changes (an extension installed in a test).
let order: RailOrder | null = null;
let orderCatalog = '';
const listeners = new Set<() => void>();

function current(): RailOrder {
  const catalog = railTabIds().join('\u001f');
  if (!order || catalog !== orderCatalog) {
    order = load();
    orderCatalog = catalog;
  }
  return order;
}

if (typeof window !== 'undefined') {
  // A reorder in one window must reach the others (torn-off sessions); a
  // settings-transfer import also writes this key and dispatches `storage`.
  window.addEventListener('storage', (event) => {
    if (event.key !== RAIL_ORDER_KEY) return;
    order = null;
    for (const listener of listeners) listener();
  });
}

export function getRailOrder(): RailOrder {
  return current();
}

export function setRailOrder(next: { top: string[]; bottom: string[] }): void {
  order = sanitizeRailOrder(next);
  orderCatalog = railTabIds().join('\u001f');
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(RAIL_ORDER_KEY, JSON.stringify(order));
    } catch {
      // Storage failure - the change still applies for this session.
    }
  }
  for (const listener of listeners) listener();
}

/**
 * Place `id` into `section` before `beforeId` (null = the section's end) -
 * the drop half of the rail's drag gesture. Dropping an item onto itself is a
 * no-op, so a same-spot release can't teleport it to the section's end.
 */
export function moveRailTab(id: RailTabId, section: RailSection, beforeId: RailTabId | null): void {
  if (beforeId === id) return;
  const now = current();
  const top = now.top.filter((t) => t !== id);
  const bottom = now.bottom.filter((t) => t !== id);
  const list = section === 'top' ? top : bottom;
  const at = beforeId == null ? -1 : list.indexOf(beforeId);
  list.splice(at === -1 ? list.length : at, 0, id);
  setRailOrder({ top, bottom });
}

export function subscribeRailOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRailOrder(): RailOrder {
  return useSyncExternalStore(subscribeRailOrder, getRailOrder);
}
