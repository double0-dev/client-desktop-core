/**
 * Clipboard keys for a terminal off macOS. xterm reads Ctrl+V as the control
 * byte ^V (0x16) and cancels the keydown, so the browser never runs its native
 * paste and nothing lands in the shell - macOS never sees this because ⌘V is
 * not a terminal key. A paste key is let through to the browser (the custom
 * key handler returns false WITHOUT preventDefault), so Chromium fires `paste`
 * on xterm's textarea, which xterm handles itself (bracketed paste included).
 * A copy key is the pool's to run: Chromium binds Ctrl+C to copy but nothing
 * to Ctrl+Shift+C, so it writes the selection itself.
 *
 * - Windows: Ctrl+V and Ctrl+Shift+V paste; Ctrl+Shift+C copies, and plain
 *   Ctrl+C copies only while text is selected - without a selection it stays
 *   the interrupt (^C).
 * - Linux: only the Shift forms, the keys Linux terminals use (2026-10-29).
 *   Ctrl+V is readline's quoted-insert there and Ctrl+C over a selection
 *   stays the interrupt.
 */
export type ClipboardKeyAction = 'paste' | 'copy' | null;

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function terminalClipboardKey(
  event: KeyLike,
  opts: { windows: boolean; linux: boolean; hasSelection: boolean },
): ClipboardKeyAction {
  if (!opts.windows && !opts.linux) return null;
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (opts.linux && !event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'v') return 'paste';
  if (key === 'c' && (event.shiftKey || opts.hasSelection)) return 'copy';
  return null;
}

/**
 * Claude Code's image-paste key on Windows: Alt+V, i.e. ESC v (its keymap binds
 * `chat:imagePaste` to alt+v on Windows and ctrl+v elsewhere, read off 2.1.312).
 * Claude reads the image off the clipboard itself when the key arrives; a
 * terminal paste carries text only, so an image copied on Windows reached the
 * browser's `paste` as an empty string and nothing happened.
 */
export const WINDOWS_IMAGE_PASTE_KEY = '\x1bv';

/**
 * What a terminal sends for a browser `paste` instead of xterm's text paste:
 * on Windows, a clipboard holding an image and no text becomes the image-paste
 * key; anything with text stays an ordinary paste (null). Off Windows Ctrl+V
 * already reaches the program as ^V, which is Claude's key there.
 */
export function terminalPasteOverride(
  types: readonly string[],
  opts: { windows: boolean },
): string | null {
  if (!opts.windows) return null;
  if (types.includes('text/plain')) return null;
  return types.some((t) => t.startsWith('image/') || t === 'Files')
    ? WINDOWS_IMAGE_PASTE_KEY
    : null;
}
