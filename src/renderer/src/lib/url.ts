// What a browser tab's address bar shows and loads (a private plan). Pure.

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(:\d+)?(\/|$)/i;

/**
 * Turn what was typed into a URL to load, or null when it can't be one:
 * `localhost:5173/x` and `:3000` get `http://`; anything with a dot and no
 * spaces gets `https://`; a full http(s) / preview URL passes. There is no
 * search engine - this is a dev browser.
 */
export function addressToUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|d0-preview):\/\//i.test(text)) {
    try {
      return new URL(text).toString();
    } catch {
      return null;
    }
  }
  if (/^about:blank$/i.test(text)) return 'about:blank';
  if (/\s/.test(text)) return null;
  if (/^:\d{1,5}(\/|$)/.test(text)) return `http://localhost${text}`;
  if (/^\d{2,5}$/.test(text)) return `http://localhost:${text}`;
  if (LOOPBACK.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return null;
}

export type AddressParts = { origin: string; path: string };

/** The address bar's two tones: the origin bright, the rest dim. */
export function addressParts(url: string): AddressParts {
  if (!url) return { origin: '', path: '' };
  try {
    const u = new URL(url);
    if (u.protocol === 'd0-preview:') {
      return { origin: '', path: decodeURIComponent(u.pathname.replace(/^\//, '')) };
    }
    const origin = u.protocol === 'https:' ? u.host : `${u.host}`;
    const path = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    return { origin, path };
  } catch {
    return { origin: url, path: '' };
  }
}

/** Query keys that carry credentials (OAuth codes, tokens, signatures). */
const SECRET_PARAM = /token|code|secret|session|auth|key|sig|password|state/i;

/**
 * A URL safe to keep (the recent list, a saved tab): credential-looking
 * query parameters and any fragment are dropped - an OAuth redirect's
 * `?code=` or `#access_token=` must not land in storage (review, 2026-10-06).
 */
export function storableUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()])
      if (SECRET_PARAM.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Whether a URL is served by this machine (a dev server). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.host + '/');
  } catch {
    return false;
  }
}

/** `http://localhost:5173` for any URL on that server. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** A tab's title before the page names itself: `localhost:5173`, or the file name. */
export function provisionalTitle(url: string): string {
  if (!url) return 'New tab';
  const { origin, path } = addressParts(url);
  if (!origin) return path.split('/').pop() || 'Preview';
  return origin;
}
