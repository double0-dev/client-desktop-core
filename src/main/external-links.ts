/**
 * What an app window may hand to the operating system when its page opens a
 * link (`window.open`, `target="_blank"`; main's `setWindowOpenHandler`): web
 * pages, and an email to an address (`mailto:` - the support address on the
 * sign-in screen, the lock and Settings). Anything else - `file://`, a custom
 * scheme, another OS handler - never reaches `shell.openExternal`. The window
 * itself never navigates away (main's `will-navigate`).
 */
const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

/** The URL to pass to `shell.openExternal`, or null when the window may not open it. */
export function externalOpenUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!OPENABLE.has(parsed.protocol)) return null;
  // A mail link names an address; a bare `mailto:` opens nothing useful.
  if (parsed.protocol === 'mailto:') {
    let address: string;
    try {
      address = decodeURIComponent(parsed.pathname);
    } catch {
      // A broken escape (`%E0%A4%A`): this runs in main's window-open handler,
      // which must never throw.
      return null;
    }
    // `?`, `&` and `#` too: an encoded query (`a@b.com%3Fbody=…`) decodes into
    // the address and would come back out as a query (final review 2026-11-18).
    if (!/^[^@\s?&#]+@[^@\s?&#]+$/.test(address)) return null;
    // The address alone: a query (cc, bcc, body, attach) is the page's word,
    // not the user's, and some mail apps act on more than they show.
    return `mailto:${encodeURI(address)}`;
  }
  return url;
}
