/**
 * A tiny bridge so non-palette UI (the top bar's search box) can open the global
 * Search Everywhere palette - which otherwise only opens on the double-Shift
 * gesture. The palette is mounted once app-level and registers its opener on
 * mount; callers just invoke `openSearchEverywhere()`.
 */
let opener: (() => void) | null = null;

/** Called by the palette to register its open function; returns an unregister. */
export function registerSearchOpener(fn: () => void): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Open the Search Everywhere palette from anywhere (e.g. the top-bar search box). */
export function openSearchEverywhere(): void {
  opener?.();
}
