/**
 * Workspace files shown in a browser tab (a private plan ›
 * File previews): HTML, SVG, PDF and video load from
 * `d0-preview://<token>/<path>`, a scheme registered on the browser
 * partition only. A token stands for one folder (a session's checkout); the
 * handler serves files under it and nothing else - no `..`, no symlink
 * escape check needed beyond the path (the folder is the user's own), no
 * directory listings. `file://` is never used: a page loaded from it could
 * read every other local file.
 *
 * Tokens outlive a run: a saved tab's URL must still load after a relaunch,
 * so browser.ts persists the token -> folder map (`entries` / `load`), the
 * newest MAX_ROOTS folders. A token still only reaches its own folder.
 *
 * Pure: the protocol handler in browser.ts does the I/O.
 */

import { randomBytes } from 'node:crypto';
import { isAbsolute, join, normalize, posix, relative, sep } from 'node:path';
import { PREVIEW_SCHEME } from './guard';

/** Folders whose tokens are kept; the least recently previewed go first. */
export const MAX_ROOTS = 100;

const TOKEN = /^[0-9a-f]{24}$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** A token's folder - on this machine (`hostId` null) or on a remote host (plan 29 spec › 7.5). */
export type PreviewRoot = { root: string; hostId: string | null };

function keyOf(root: string, hostId: string | null): string {
  if (hostId) return `${hostId}\0${posix.normalize(root).replace(/(.)\/+$/, '$1')}`;
  return normalize(root).replace(/(.)[\\/]+$/, '$1');
}

function rootFromKey(key: string): PreviewRoot {
  const nul = key.indexOf('\0');
  return nul < 0
    ? { root: key, hostId: null }
    : { root: key.slice(nul + 1), hostId: key.slice(0, nul) };
}

export class PreviewRegistry {
  private readonly byToken = new Map<string, string>();
  /** Insertion order is recency: oldest first. */
  private readonly byRoot = new Map<string, string>();
  /** Called when the map changed (a new folder, or one dropped). */
  onChange: (() => void) | null = null;

  /**
   * Restore saved `[token, folder]` / `[token, folder, hostId]` entries
   * (oldest first); bad ones are skipped.
   */
  load(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') continue;
      const [token, root] = e as [string, string];
      const hostId = typeof e[2] === 'string' && HOST_ID.test(e[2]) ? (e[2] as string) : null;
      if (e[2] !== undefined && hostId === null) continue;
      if (!TOKEN.test(token) || this.byToken.has(token)) continue;
      if (hostId ? !root.startsWith('/') || root.includes('\0') : !isAbsolute(root)) continue;
      const key = keyOf(root, hostId);
      if (this.byRoot.has(key)) continue;
      this.byRoot.set(key, token);
      this.byToken.set(token, key);
    }
    this.trim();
  }

  /** Entries to save, oldest first: `[token, folder]`, a host's with its id third. */
  entries(): Array<[string, string] | [string, string, string]> {
    return [...this.byRoot].map(([key, token]) => {
      const { root, hostId } = rootFromKey(key);
      return hostId ? [token, root, hostId] : [token, root];
    });
  }

  /** The token for a folder: minted once, then kept across runs. */
  tokenFor(root: string, hostId: string | null = null): string {
    const key = keyOf(root, hostId);
    let token = this.byRoot.get(key);
    if (token) {
      // Most recent last - the cap drops folders not previewed for longest.
      this.byRoot.delete(key);
      this.byRoot.set(key, token);
      this.onChange?.();
      return token;
    }
    token = randomBytes(12).toString('hex');
    this.byRoot.set(key, token);
    this.byToken.set(token, key);
    this.trim();
    this.onChange?.();
    return token;
  }

  private trim(): void {
    for (const [root, token] of this.byRoot) {
      if (this.byRoot.size <= MAX_ROOTS) break;
      this.byRoot.delete(root);
      this.byToken.delete(token);
    }
  }

  /**
   * `d0-preview://…` for `file`, which must lie inside `root`; null otherwise.
   * A host folder (`hostId`) uses the host's POSIX paths, whatever this
   * machine's are.
   */
  urlFor(root: string, file: string, hostId: string | null = null): string | null {
    const p = hostId ? posix : { isAbsolute, normalize, relative, sep };
    if (!p.isAbsolute(root) || !p.isAbsolute(file)) return null;
    const rel = p.relative(p.normalize(root), p.normalize(file));
    if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) return null;
    const path = rel.split(p.sep).map(encodeURIComponent).join('/');
    return `${PREVIEW_SCHEME}://${this.tokenFor(root, hostId)}/${path}`;
  }

  /** The folder a token stands for (this machine's, or a host's). */
  entryOf(url: string): PreviewRoot | null {
    try {
      const key = this.byToken.get(new URL(url).hostname);
      return key === undefined ? null : rootFromKey(key);
    } catch {
      return null;
    }
  }

  /** The folder a token stands for. */
  rootOf(url: string): string | null {
    return this.entryOf(url)?.root ?? null;
  }

  /** The file a request asks for, or null when it is outside the token's folder. */
  resolve(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== `${PREVIEW_SCHEME}:`) return null;
    const key = this.byToken.get(parsed.hostname);
    if (key === undefined) return null;
    const { root, hostId } = rootFromKey(key);
    let path: string;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    if (path.includes('\0')) return null;
    // Dot files and folders (.env, .git, .ssh) are never served: a previewed
    // page from a cloned repo runs its own scripts (review, 2026-10-06).
    if (path.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
    // The URL parser already folded `.`/`..` segments; `%2f`-encoded ones
    // decode here and are caught by the containment check below.
    const p = hostId ? posix : { join, normalize, relative, isAbsolute };
    const target = p.normalize(p.join(root, path));
    const rel = p.relative(root, target);
    if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) return null;
    return target;
  }
}

/** File previews read over a host's bridge stop here (fs.ts's binary cap). */
export const MAX_HOST_PREVIEW_BYTES = 32 * 1024 * 1024;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
};

/** A host file's Content-Type by extension (this machine's previews get it from `net.fetch`). */
export function previewContentType(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}
