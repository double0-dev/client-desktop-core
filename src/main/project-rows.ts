/**
 * "The projects or sessions table changed" (db/ipc.ts emits it on every write
 * to either). Core has no listener of its own; the integrations (Pro) re-read
 * their project scopes on it - a plain event, so the DB layer never imports a
 * Pro module (a private plan › M4).
 */
const listeners = new Set<() => void>();

export function onProjectRowsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function projectRowsChanged(): void {
  for (const listener of listeners) listener();
}
