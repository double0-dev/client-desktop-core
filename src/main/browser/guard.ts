/**
 * The browser preview's security policy (a private plan ›
 * Decisions), pure so it can be tested without Electron.
 *
 * Previewed pages run in `<webview>` guests on their own persistent
 * partition - never `session.defaultSession`, whose CSP headers and request
 * handlers belong to the app. Main checks every attach and fails closed: our
 * partition, a browsable src, no preload, no node, sandboxed.
 */

/** Cookies and storage of every browser tab (one shared profile in v1). */
export const BROWSER_PARTITION = 'persist:double0-browser';

/** Scheme serving workspace files to a preview tab (see preview-protocol.ts). */
export const PREVIEW_SCHEME = 'd0-preview';

/** URLs a browser tab may load or navigate to. */
export function isBrowsableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' ||
    parsed.protocol === 'https:' ||
    parsed.protocol === `${PREVIEW_SCHEME}:`
  );
}

/** Web preferences a guest is allowed to run with - everything else is dropped. */
export type GuestPreferences = {
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  preload?: string;
  /** Electron's internal spelling of a preload on a webview tag. */
  preloadURL?: string;
  javascript?: boolean;
  plugins?: boolean;
  webviewTag?: boolean;
  experimentalFeatures?: boolean;
  enableBlinkFeatures?: string;
  disableBlinkFeatures?: string;
};

/**
 * Decide a `will-attach-webview`: returns the reason to refuse, or null and
 * rewrites `prefs` in place to the locked-down set. `params` are the tag's
 * attributes (`src`, `partition`, ...).
 */
export function vetWebviewAttach(
  prefs: GuestPreferences,
  params: Record<string, string>,
): string | null {
  if (params.partition !== BROWSER_PARTITION) return 'unknown partition';
  const src = params.src ?? '';
  if (src !== '' && !isBrowsableUrl(src)) return 'src not allowed';
  // Strip anything that could give the guest more than a web page has.
  delete prefs.preload;
  delete prefs.preloadURL;
  delete (prefs as Record<string, unknown>).additionalArguments;
  delete (params as Record<string, unknown>).preload;
  // Blink switches can turn on unshipped APIs; a page nesting its own
  // webview would escape these checks (review, 2026-10-06).
  delete prefs.enableBlinkFeatures;
  delete prefs.disableBlinkFeatures;
  delete (params as Record<string, unknown>).blinkfeatures;
  delete (params as Record<string, unknown>).disableblinkfeatures;
  prefs.experimentalFeatures = false;
  prefs.webviewTag = false;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.javascript = true;
  // Chromium's PDF viewer is a plugin; a preview tab opens PDFs.
  prefs.plugins = true;
  return null;
}

/**
 * At most `max` events per `windowMs`, sliding: `allow()` says whether one
 * more may happen now. A page calling `window.open` in a loop gets a few
 * tabs, not hundreds (review, 2026-10-06).
 */
export function rateLimit(max: number, windowMs: number, now: () => number = Date.now) {
  const times: number[] = [];
  return {
    allow(): boolean {
      const t = now();
      while (times.length > 0 && t - times[0] >= windowMs) times.shift();
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
  };
}

/** Popups a page may turn into tabs: this many per window below. */
export const POPUP_LIMIT = 3;
export const POPUP_WINDOW_MS = 2000;

/**
 * Permissions a previewed page may get without asking. Camera, microphone,
 * location, notifications, MIDI, HID, serial and the rest are refused - a dev
 * app that needs them is opened in the system browser.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Keys a focused page keeps for itself; every other primary-modifier combo
 * is the app's (⌘W, ⌘T, ⌘1..8, ⌘⇧B ...) and is handed back to the window.
 * Plain keys, Esc included, always stay with the page.
 */
const PAGE_KEYS = new Set([
  'KeyA',
  'KeyC',
  'KeyV',
  'KeyX',
  'KeyZ',
  'KeyY',
  // Word / line editing and submit (⌘Backspace, Ctrl+Delete, ⌘↩ in a form).
  'Backspace',
  'Delete',
  'Enter',
  'NumpadEnter',
  'Home',
  'End',
]);
/** The same with Shift held: redo, paste as plain text, select to line edge.
 * Not the arrows: ⇧⌘Arrow (Ctrl+Shift+Arrow off macOS) is the app's focus
 * walk, so a page in front could never be left by keyboard - the same trade
 * the code editor makes (selecting to a line edge stays on ⇧Home / ⇧End). */
const PAGE_SHIFT_KEYS = new Set(['KeyZ', 'KeyV', 'Home', 'End', 'Enter']);

/**
 * macOS app-menu accelerators: left alone so the menu still gets them while
 * a page has focus - a prevented key never reaches the menu, and the replay
 * only reaches the page's DOM (review, 2026-10-06). Quit, hide, hide others,
 * minimise, close window (⇧⌘W), zoom in / out / reset, full screen (⌃⌘F).
 */
function isMenuAccelerator(input: GuestKey): boolean {
  switch (input.code) {
    case 'KeyQ':
    case 'KeyM':
      return !input.shift && !input.alt;
    case 'KeyH':
      return !input.shift;
    case 'KeyW':
      return input.shift;
    case 'Equal':
    case 'Minus':
    case 'Digit0':
      return true;
    case 'KeyF':
      return input.control;
    default:
      return false;
  }
}

export type GuestKey = {
  type: string;
  code: string;
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
};

/** Whether a key pressed inside a page belongs to the app. */
export function isAppShortcut(input: GuestKey, isMac: boolean): boolean {
  if (input.type !== 'keyDown') return false;
  const mod = isMac ? input.meta : input.control;
  if (!mod) return false;
  // Off macOS, AltGr arrives as Ctrl+Alt: that is a character being typed
  // (@ { [ on many layouts), never a shortcut (review, 2026-10-06).
  if (!isMac && input.control && input.alt) return false;
  if (isMac && isMenuAccelerator(input)) return false;
  // Text editing (copy, paste, undo, line jumps) stays in the page; ⌘⇧C is
  // the app's Select element, so Shift only keeps the keys listed for it.
  if (input.shift ? PAGE_SHIFT_KEYS.has(input.code) : PAGE_KEYS.has(input.code)) return false;
  if (!input.shift && input.code.startsWith('Arrow')) return false;
  return true;
}
