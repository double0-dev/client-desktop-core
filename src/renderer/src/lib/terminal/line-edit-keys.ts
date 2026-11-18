/**
 * macOS line-editing keys for a terminal: ⌘⌫ deletes back to the start of the
 * line, ⌘← / ⌘→ move to its start / end - the keys every macOS text field
 * honours, and the defaults of the common Mac terminals' "natural text
 * editing" sets. xterm itself sends a plain DEL for ⌘⌫ (one character) and
 * nothing at all for ⌘← / ⌘→, because a pty has no ⌘ modifier.
 *
 * Each becomes the readline / zle control byte for the same action, so it
 * works in bash, zsh, fish and in TUIs that follow readline (Claude Code):
 * Ctrl+U (kill to line start; zsh's emacs map kills the whole line), Ctrl+A
 * (line start) and Ctrl+E (line end).
 *
 * macOS only: off macOS Ctrl+U / Ctrl+A / Ctrl+E are already the keys, and the
 * Super key belongs to the window manager.
 */

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const SEQUENCES: Record<string, string> = {
  Backspace: '\x15', // Ctrl+U
  ArrowLeft: '\x01', // Ctrl+A
  ArrowRight: '\x05', // Ctrl+E
};

/** The bytes to send for a macOS ⌘ line-editing key, or null. */
export function terminalLineEditSequence(event: KeyLike, opts: { mac: boolean }): string | null {
  if (!opts.mac) return null;
  // Only bare ⌘: ⇧⌘Arrow is the focus walk, ⌃⌘Arrow and ⌥⌘Arrow are app keys.
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return SEQUENCES[event.key] ?? null;
}
