import type { RailTabId } from '@renderer/lib/workspace/dock-state';

/**
 * Imperative "open this tool window" for places that don't own the dock - one
 * tool's panel pointing at another tool. Every session view
 * stays mounted, so the request is a window event and only the ACTIVE view's
 * chrome acts on it (workspace-chrome.tsx).
 */

const OPEN_TOOL_EVENT = 'double0-open-tool';

export function requestOpenTool(id: RailTabId): void {
  window.dispatchEvent(new CustomEvent<RailTabId>(OPEN_TOOL_EVENT, { detail: id }));
}

/** Subscribe to open requests; returns the unsubscribe. */
export function onOpenToolRequest(fn: (id: RailTabId) => void): () => void {
  const handler = (e: Event): void => fn((e as CustomEvent<RailTabId>).detail);
  window.addEventListener(OPEN_TOOL_EVENT, handler);
  return () => window.removeEventListener(OPEN_TOOL_EVENT, handler);
}
