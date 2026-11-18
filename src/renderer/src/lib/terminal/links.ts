import type { ILinkHandler, Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { isMac } from '@renderer/lib/settings/keyboard-shortcuts';
import { isLoopbackUrl } from '@renderer/lib/url';
import { getFileLinkContext } from '@renderer/lib/terminal/file-links';

/**
 * Clickable links in terminals (design: `client_desktop.pen` › `Label/Terminal
 * find & links`). Two sources feed the same behaviour: plain URLs found in the
 * output (the web-links addon) and OSC 8 hyperlinks a program emits (xterm's
 * `linkHandler`). A link opens only on ⌘-click (Ctrl-click off macOS) - a bare
 * click in a terminal selects text or reaches a TUI, and must never launch a
 * browser by accident. Hovering shows the hint naming the modifier.
 *
 * Opening goes through `window.open`, which main's window-open handler turns
 * into `shell.openExternal` for http(s) only - a `file://` or custom-scheme
 * link printed by a program never reaches the OS.
 */

/** The hint text under the pointer while a link is hovered. */
export const LINK_HINT_TEXT = isMac ? '⌘-click to open' : 'Ctrl-click to open';

/** Whether a click carries the modifier that opens a link. */
export function isLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** Only web URLs are opened; anything else a program prints stays text. */
export function isOpenableUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Where a clicked link opens (a private plan › Terminal
 * links): a page on this machine (a dev server) in a browser tab here,
 * anything else in the system browser; ⇧ (Shift) held inverts it once.
 * Not ⌥: xterm reads an Alt-click as "move the cursor here" and types arrow
 * keys into the shell (review, 2026-10-06).
 */
export function linkDestination(uri: string, invert: boolean): 'app' | 'system' {
  return isLoopbackUrl(uri) !== invert ? 'app' : 'system';
}

/** Open `uri` when the click carries the modifier: in a browser tab of the
 * terminal's workspace for a dev server, else in the system browser. */
export function activateTerminalLink(event: MouseEvent, uri: string, ptyId?: string): boolean {
  if (!isLinkActivation(event) || !isOpenableUrl(uri)) return false;
  if (linkDestination(uri, event.shiftKey) === 'app' && ptyId) {
    const open = getFileLinkContext(ptyId)?.openUrl;
    if (open) {
      open(uri);
      return true;
    }
  }
  window.open(uri);
  return true;
}

const HINT_CLASS = 'terminal-link-hint';

/**
 * Show the hint just below-right of the pointer. It lives inside the terminal
 * element with xterm's `xterm-hover` class, so moving onto it never counts as
 * leaving the link (xterm's documented recipe for DOM hover tooltips).
 */
export function showLinkHint(term: Terminal, event: MouseEvent, text = LINK_HINT_TEXT): void {
  const host = term.element;
  if (!host) return;
  let hint = host.querySelector<HTMLDivElement>(`.${HINT_CLASS}`);
  if (!hint) {
    hint = document.createElement('div');
    hint.className = `${HINT_CLASS} xterm-hover pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-border bg-surface-elevated px-2 py-1 text-[length:calc(11px*var(--ui-font-scale,1))] leading-none text-foreground shadow-md`;
    host.appendChild(hint);
  }
  hint.textContent = text;
  const rect = host.getBoundingClientRect();
  hint.style.left = `${event.clientX - rect.left + 12}px`;
  hint.style.top = `${event.clientY - rect.top + 16}px`;
}

export function hideLinkHint(term: Terminal): void {
  term.element?.querySelector(`.${HINT_CLASS}`)?.remove();
}

/** OSC 8 hyperlinks: same modifier rule and hint as plain URLs. Without this
 * xterm's default asks `window.confirm` on every click. */
export function createOsc8LinkHandler(term: Terminal, ptyId?: string): ILinkHandler {
  return {
    activate: (event, text) => {
      activateTerminalLink(event, text, ptyId);
    },
    hover: (event) => showLinkHint(term, event),
    leave: () => hideLinkHint(term),
    allowNonHttpProtocols: false,
  };
}

/** Plain URLs in the output. */
export function createWebLinksAddon(term: Terminal, ptyId?: string): WebLinksAddon {
  return new WebLinksAddon((event, uri) => activateTerminalLink(event, uri, ptyId), {
    hover: (event) => showLinkHint(term, event),
    leave: () => hideLinkHint(term),
  });
}
