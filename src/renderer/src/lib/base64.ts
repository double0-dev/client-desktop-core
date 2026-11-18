/**
 * Bytes ⇄ base64 for embedding binary content in a JSON document (the settings
 * export carries task images this way). `btoa`/`atob` work on binary strings,
 * so the bytes are chunked through `String.fromCharCode` - one call per byte
 * would crawl, one call for the whole array overflows the argument list.
 */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Null when the text is not base64 (a hand-edited or truncated file). */
export function base64ToBytes(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
