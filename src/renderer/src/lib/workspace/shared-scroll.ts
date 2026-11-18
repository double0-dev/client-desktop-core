import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react';

/**
 * One scroll offset per sidebar list, shared by every mounted session view.
 *
 * The host keeps a `WorkspaceView` per visited session (mounted-hidden), and
 * each renders its own copy of the Projects and Sessions lists. Picking a
 * session swaps in another view, whose copy sat wherever it was left - often
 * the top - so a scrolled list jumped under the pointer on every click. The
 * visible copy records its offset here; a copy that becomes visible (or
 * mounts while visible) takes it.
 */
const offsets = new Map<string, number>();

/** Test seam: forget every remembered offset. */
export function resetSharedScroll(): void {
  offsets.clear();
}

export function sharedScrollTop(key: string): number | undefined {
  return offsets.get(key);
}

function apply(el: HTMLElement, key: string): void {
  const top = offsets.get(key);
  if (top !== undefined && el.scrollTop !== top) el.scrollTop = top;
}

/**
 * Attach to a list's scroll container. `active` = this copy is the one on
 * screen: only it records, and turning active restores the shared offset.
 */
export function useSharedScroll(key: string, active: boolean): RefCallback<HTMLElement> {
  const el = useRef<HTMLElement | null>(null);
  const state = useRef({ key, active });

  useLayoutEffect(() => {
    state.current = { key, active };
    if (active && el.current) apply(el.current, key);
  }, [key, active]);

  return useCallback((node: HTMLElement | null) => {
    el.current = node;
    if (!node) return;
    if (state.current.active) apply(node, state.current.key);
    const onScroll = (): void => {
      // A hidden copy has no box; a scroll event it fires (a clamp as it
      // hides) must not overwrite the visible copy's offset.
      if (!state.current.active || node.clientHeight === 0) return;
      offsets.set(state.current.key, node.scrollTop);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      if (el.current === node) el.current = null;
    };
  }, []);
}
