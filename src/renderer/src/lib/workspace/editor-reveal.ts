/**
 * "Open this file at line N": a pending caret position per file path, taken by
 * the file's editor tab once its editor is ready (a tab just opened) or at once
 * (a tab already open - it is subscribed). Fed by terminal file links
 * (`lib/terminal/file-links.ts`); any other opener with a position can use it.
 */

export type RevealPosition = { line: number; column?: number };

/**
 * How long a request waits for its editor. An open that fails (a binary or
 * unreadable file, a tab closed before it was ready) never takes it, and a
 * later, unrelated open of the same file must not jump to that old line.
 */
const REVEAL_TTL_MS = 10_000;

const pending = new Map<string, RevealPosition & { at: number }>();
const listeners = new Set<() => void>();

/** Ask the editor of `filePath` to put the caret at `position`. Call before
 * opening the file, so a tab created by the open finds it waiting. */
export function requestEditorReveal(filePath: string, position: RevealPosition): void {
  pending.set(filePath, { ...position, at: Date.now() });
  for (const l of listeners) l();
}

/** The pending position for `filePath`, removed as it is taken. */
export function takeEditorReveal(filePath: string): RevealPosition | undefined {
  const entry = pending.get(filePath);
  pending.delete(filePath);
  if (!entry || Date.now() - entry.at > REVEAL_TTL_MS) return undefined;
  const { at: _at, ...position } = entry;
  void _at;
  return position;
}

export function subscribeEditorReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
