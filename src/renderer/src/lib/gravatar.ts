import { useEffect, useState } from 'react';

/**
 * Gravatar lookups for commit avatars (changes-graph.tsx). The avatar URL is
 * the SHA-256 of the normalized email; `d=404` makes Gravatar answer 404 for
 * emails without a picture, so callers keep their initials fallback. Email
 * hashes are cached, and URLs that already failed (404 or offline) are
 * remembered so repeated rows for the same author render initials immediately
 * instead of re-requesting.
 */

const hashCache = new Map<string, string>();
/**
 * Failed avatar URLs → when they failed. The memory expires: a failure is
 * usually permanent (the author has no picture) but it can equally be a
 * moment offline, and remembering that for the whole session left the graph
 * on initials until the app was restarted.
 */
const failedUrls = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The Gravatar URL for an email once its hash is computed - null while
 * hashing, for blank emails, and when SubtleCrypto is unavailable.
 */
export function useGravatarUrl(email: string | null | undefined, sizePx: number): string | null {
  const normalized = (email ?? '').trim().toLowerCase();
  const [known, setKnown] = useState<{ email: string; hash: string } | null>(() => {
    const hash = hashCache.get(normalized);
    return hash ? { email: normalized, hash } : null;
  });

  useEffect(() => {
    if (!normalized || !crypto.subtle) return;
    const cached = hashCache.get(normalized);
    if (cached) {
      setKnown({ email: normalized, hash: cached });
      return;
    }
    let live = true;
    void sha256Hex(normalized).then((hash) => {
      hashCache.set(normalized, hash);
      if (live) setKnown({ email: normalized, hash });
    });
    return () => {
      live = false;
    };
  }, [normalized]);

  // The `email` check drops a stale hash while a new email is still hashing.
  if (!normalized || known?.email !== normalized) return null;
  // Request 2× the rendered size so the image stays sharp on retina displays.
  return `https://www.gravatar.com/avatar/${known.hash}?s=${sizePx * 2}&d=404`;
}

/** Remember any avatar URL that 404'd or failed to load (provider or Gravatar). */
export function markAvatarUrlFailed(url: string): void {
  failedUrls.set(url, Date.now());
}

/** True while a past failure is still fresh - after that the URL is retried. */
export function isAvatarUrlFailed(url: string): boolean {
  const at = failedUrls.get(url);
  if (at == null) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  failedUrls.delete(url);
  return false;
}
