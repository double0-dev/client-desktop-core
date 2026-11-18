import type { Terminal } from '@xterm/xterm';

/**
 * Clear terminal (⌘K): drop the scrollback and the screen above the prompt
 * row, in this window's xterm only - nothing is sent to the shell, so the
 * line being typed stays. A program on the alternate screen (an agent's
 * full-screen UI, vim, less) owns what it shows and keeps no scrollback here:
 * clearing it would only blank the frame until its next repaint, so it is
 * left alone. Returns whether anything was cleared.
 */
export function clearTerminal(term: Pick<Terminal, 'buffer' | 'clear'>): boolean {
  if (term.buffer.active.type === 'alternate') return false;
  term.clear();
  return true;
}
