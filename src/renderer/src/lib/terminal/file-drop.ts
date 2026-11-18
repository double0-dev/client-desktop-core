/**
 * Files dropped onto a terminal, pure: which drags a terminal takes and the
 * text it types for them. Two sources - rows dragged out of the explorer
 * (`EXPLORER_DRAG_MIME`, which names the machine the paths live on) and
 * files from the OS's file manager (`Files`, paths read through the
 * preload's `files.pathOf`). The text is the paths themselves, absolute,
 * quoted for the shell and followed by a space, pasted like typed input
 * (bracketed paste, so an agent reads it as a paste - Claude Code attaches a
 * dropped image path).
 */

/** The explorer's drag payload: `{ hostId, paths }` as JSON. */
export const EXPLORER_DRAG_MIME = 'application/x-double0-explorer-paths';

export type ExplorerDragPayload = {
  /** The host the paths live on; null = this machine. */
  hostId: string | null;
  paths: string[];
};

export function encodeExplorerDrag(payload: ExplorerDragPayload): string {
  return JSON.stringify(payload);
}

/** The explorer payload, or null for anything malformed. */
export function decodeExplorerDrag(raw: string): ExplorerDragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { hostId, paths } = v as Record<string, unknown>;
    if (hostId !== null && typeof hostId !== 'string') return null;
    if (!Array.isArray(paths)) return null;
    const clean = paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (clean.length === 0) return null;
    return { hostId, paths: clean };
  } catch {
    return null;
  }
}

/** Where a drag comes from, read off `dataTransfer.types` (all dragover sees). */
export type TerminalDragKind = 'explorer' | 'os' | null;

export function terminalDragKind(
  types: readonly string[] | DOMStringList | null | undefined,
): TerminalDragKind {
  if (!types) return null;
  const list = Array.from(types as ArrayLike<string>);
  if (list.includes(EXPLORER_DRAG_MIME)) return 'explorer';
  if (list.includes('Files')) return 'os';
  return null;
}

/**
 * Whether a terminal takes a drag before its payload can be read (dragover).
 * A file from the OS lives on this computer: its path means nothing to a
 * shell on a host, so a host's terminal refuses it.
 */
export function acceptsTerminalDrag(kind: TerminalDragKind, terminalHost: string | null): boolean {
  if (kind === 'explorer') return true;
  if (kind === 'os') return terminalHost === null;
  return false;
}

/** Characters a POSIX shell reads as anything but part of a word. */
const POSIX_SPECIAL = /[^A-Za-z0-9_\-./,:@%+=]/;

/**
 * One path as a shell word. POSIX: backslash-escape every special character
 * (`/a/My\ File\(1\).png`), the form a terminal's own drop types; a newline
 * cannot be backslash-escaped, so such a path is single-quoted. Windows
 * shells (cmd.exe, PowerShell): double quotes when needed.
 */
export function quoteDroppedPath(path: string, style: 'posix' | 'windows'): string {
  if (style === 'windows') return /[\s&()^;,'`%!"]/.test(path) ? `"${path}"` : path;
  if (!POSIX_SPECIAL.test(path)) return path;
  if (/[\n\r]/.test(path)) return `'${path.replace(/'/g, `'\\''`)}'`;
  return path.replace(/[^A-Za-z0-9_\-./,:@%+=]/g, (c) => `\\${c}`);
}

/** The typed text: every path quoted, space-separated, one trailing space. */
export function droppedPathsText(paths: readonly string[], style: 'posix' | 'windows'): string {
  const words = paths.filter((p) => p.length > 0).map((p) => quoteDroppedPath(p, style));
  return words.length === 0 ? '' : `${words.join(' ')} `;
}

/**
 * The paths a drop gives a terminal, or null when it takes none: an
 * explorer drag only onto a terminal of the same machine, OS files only onto
 * a local one. `osPaths` are the dropped files' local paths ('' for a file
 * with none - a browser image, say).
 */
export function terminalDropPaths(
  drop: { explorer: string; osPaths: readonly string[] },
  terminalHost: string | null,
): string[] | null {
  const fromExplorer = decodeExplorerDrag(drop.explorer);
  if (fromExplorer) return fromExplorer.hostId === terminalHost ? fromExplorer.paths : null;
  if (terminalHost !== null) return null;
  const paths = drop.osPaths.filter((p) => p.length > 0);
  return paths.length > 0 ? paths : null;
}
