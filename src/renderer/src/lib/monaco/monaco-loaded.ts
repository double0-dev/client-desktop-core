// Tiny shared flag OUTSIDE the lazy Monaco chunk: lets app-chunk code (the
// language-server store) ask "is the editor stack up?" without importing the
// multi-megabyte module - importing it just to check would defeat the point.
let loaded = false;
const waiting = new Set<() => void>();

export function markMonacoLoaded(): void {
  if (loaded) return;
  loaded = true;
  const fns = [...waiting];
  waiting.clear();
  for (const fn of fns) fn();
}

export function isMonacoLoaded(): boolean {
  return loaded;
}

/**
 * Run `fn` once the Monaco stack is up - synchronously if it already is.
 * The Changes diff uses this to color a file that was opened during the
 * editor layer's idle warmup, instead of leaving it plain until reopened.
 * Returns an unsubscribe.
 */
export function onMonacoLoaded(fn: () => void): () => void {
  if (loaded) {
    fn();
    return () => {};
  }
  waiting.add(fn);
  return () => {
    waiting.delete(fn);
  };
}
