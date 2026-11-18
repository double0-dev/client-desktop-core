import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { hideLinkHint, isLinkActivation, showLinkHint } from '@renderer/lib/terminal/links';
import { isMac } from '@renderer/lib/settings/keyboard-shortcuts';

/**
 * File paths in terminal output as links (design: `client_desktop.pen` ›
 * `Label/Terminal find & links` › FILE LINKS). A compiler error, a test
 * failure or an agent's "Edited src/auth/token.service.ts" names a file; ⌘-click
 * (Ctrl-click off macOS) opens it in an editor tab of the window the terminal
 * sits in - or focuses its tab - at the line and column when the text carries
 * them (`file.ts:42`, `file.ts:42:7`, `file.ts(42,7)`).
 *
 * Only paths that exist are links: a candidate is resolved against the
 * terminal's folder (the session's working directory) and checked on disk
 * through the fs bridge before xterm underlines it, so prose like `e.g.` or a
 * version number never lights up.
 */

export const FILE_LINK_HINT_TEXT = isMac
  ? '⌘-click to open in editor'
  : 'Ctrl-click to open in editor';

export type FilePosition = { line: number; column?: number };

export type FilePathMatch = {
  /** 0-based string index of the first character (path start). */
  start: number;
  /** 0-based string index one past the last character (position suffix included). */
  end: number;
  path: string;
  position?: FilePosition;
};

// A path token: optional ./ ../ or / prefix, then either segments with at
// least one slash, or a single name with an extension that has a letter (so
// `0.4.2` is not a file). Must not continue a word, a URL (`://x/y`) or
// another path. The position suffix is `:line[:col]` or `(line,col)`.
const PATH_RE =
  /(?<![\w/.:~@+\\-])((?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+|(?:\.{1,2}\/)?[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;

/** Every path-like token on one line of terminal text. */
export function findFilePaths(text: string): FilePathMatch[] {
  const out: FilePathMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    let path = m[1];
    // A sentence-final dot is not part of the name.
    while (path.endsWith('.') && !path.endsWith('..')) path = path.slice(0, -1);
    if (!path || path === '.' || path === '..' || path.endsWith('/')) continue;
    const lineText = m[2] ?? m[4];
    const columnText = m[3] ?? m[5];
    const trimmed = path !== m[1];
    const position: FilePosition | undefined =
      lineText && !trimmed
        ? { line: Number(lineText), ...(columnText ? { column: Number(columnText) } : {}) }
        : undefined;
    const start = m.index;
    const end = trimmed ? start + path.length : start + m[0].length;
    out.push({ start, end, path, ...(position ? { position } : {}) });
  }
  return out;
}

/** Collapse `.` / `..` segments of an absolute POSIX path. */
function normalize(abs: string): string {
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/**
 * The absolute path `path` names from `cwd`, or null when it can't be told
 * (a relative path with no known folder). POSIX only - Windows paths are not
 * linked yet.
 */
export function resolveFilePath(path: string, cwd: string | null): string | null {
  if (path.startsWith('/')) return normalize(path);
  if (!cwd || !cwd.startsWith('/')) return null;
  return normalize(`${cwd}/${path}`);
}

// ---------------------------------------------------------------------------
// Existence check: one readDir per folder, cached briefly - xterm asks for the
// links of a row on every hover over it.
// ---------------------------------------------------------------------------

const DIR_CACHE_MS = 5000;
const dirCache = new Map<string, { at: number; files: Promise<Set<string>> }>();

function filesIn(dir: string): Promise<Set<string>> {
  const now = Date.now();
  const hit = dirCache.get(dir);
  if (hit && now - hit.at < DIR_CACHE_MS) return hit.files;
  const files = (window.api?.fs.readDir(dir) ?? Promise.resolve({ entries: [] }))
    .then((res) => new Set((res.entries ?? []).filter((e) => !e.isDirectory).map((e) => e.name)))
    .catch(() => new Set<string>());
  dirCache.set(dir, { at: now, files });
  // Drop listings past their time, or every folder ever hovered stays.
  if (dirCache.size > 64)
    for (const [d, e] of dirCache) if (now - e.at >= DIR_CACHE_MS) dirCache.delete(d);
  return files;
}

/** Whether `abs` is an existing file (folders are not linked). */
export async function isExistingFile(abs: string): Promise<boolean> {
  const slash = abs.lastIndexOf('/');
  const name = abs.slice(slash + 1);
  if (slash < 0 || !name) return false;
  const dir = slash === 0 ? '/' : abs.slice(0, slash);
  return (await filesIn(dir)).has(name);
}

/** Test seam: forget cached folder listings. */
export function clearFileLinkCache(): void {
  dirCache.clear();
}

// ---------------------------------------------------------------------------
// Per-terminal context: the folder paths resolve against and where a click
// opens the file. Set by the TerminalView that shows the terminal, so a click
// lands in that view's window and workspace (a torn-off window included).
// ---------------------------------------------------------------------------

export type FileLinkContext = {
  cwd: string | null;
  open: (path: string, position?: FilePosition) => void;
  /** Open a web link in a browser tab of this view's workspace (dev servers). */
  openUrl?: (url: string) => void;
};

const contexts = new Map<string, FileLinkContext>();

/**
 * Each terminal's current folder, as its shell last reported it (the zsh
 * integration's `cwd` mark). Wins over the tab's starting folder: after a
 * `cd`, a relative path names a file under the new folder (review, 2026-10-06).
 */
const liveCwd = new Map<string, string>();

export function setTerminalCwd(ptyId: string, cwd: string): void {
  liveCwd.set(ptyId, cwd);
}

/** Forget a terminal's folder (it was disposed). */
export function forgetTerminalCwd(ptyId: string): void {
  liveCwd.delete(ptyId);
}

export function setFileLinkContext(ptyId: string, ctx: FileLinkContext): () => void {
  contexts.set(ptyId, ctx);
  return () => {
    if (contexts.get(ptyId) === ctx) contexts.delete(ptyId);
  };
}

/** The 1-based, end-inclusive xterm range of text units [start, end). */
function cellRange(
  buffer: LinkBuffer,
  cells: CellPos[],
  start: number,
  end: number,
): ILink['range'] {
  const a = cells[start];
  const b = cells[end - 1];
  const width = buffer.getLine(b.y)?.getCell(b.x)?.getWidth() ?? 1;
  return { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + width, y: b.y + 1 } };
}

export function getFileLinkContext(ptyId: string): FileLinkContext | undefined {
  return contexts.get(ptyId);
}

/** The slice of an xterm buffer the link provider reads (structural, for tests). */
export type LinkBuffer = {
  getLine(y: number):
    | {
        isWrapped: boolean;
        length: number;
        getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
      }
    | undefined;
};

/** A cell position: 0-based column and buffer row. */
type CellPos = { x: number; y: number };

/**
 * The logical line row `y` (0-based) belongs to: it and the rows soft-wrapped
 * onto it, as one string, plus the cell each UTF-16 unit of it sits in - so
 * a path that wraps is matched whole and a wide character before it does not
 * shift the click range (review, 2026-10-06).
 */
export function logicalLine(buffer: LinkBuffer, y: number): { text: string; cells: CellPos[] } {
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const cells: CellPos[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    let rowText = '';
    const rowCells: CellPos[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      // The second half of a wide character holds nothing.
      if (width === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) rowCells.push({ x, y: row });
      rowText += chars;
    }
    // The last row's empty tail is not text (translateToString(true)).
    if (row === last) {
      const trimmed = rowText.replace(/\s+$/, '');
      rowCells.length = trimmed.length;
      rowText = trimmed;
    }
    text += rowText;
    cells.push(...rowCells);
  }
  return { text, cells };
}

/** xterm link provider for one pooled terminal. Reads the logical line (wrapped
 * rows joined) and maps matches back to cells. */
export function createFileLinkProvider(ptyId: string, term: Terminal): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const ctx = contexts.get(ptyId);
      const buffer = term.buffer.active;
      const { text, cells } = ctx ? logicalLine(buffer, y - 1) : { text: '', cells: [] };
      const candidates = ctx
        ? findFilePaths(text).filter((m) => {
            const a = cells[m.start];
            const b = cells[m.end - 1];
            // Only the links that touch this row - the others come with theirs.
            return !!a && !!b && a.y <= y - 1 && b.y >= y - 1;
          })
        : [];
      if (!ctx || candidates.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(
        candidates.map(async (m): Promise<ILink | null> => {
          const abs = resolveFilePath(m.path, liveCwd.get(ptyId) ?? ctx.cwd);
          if (!abs || !(await isExistingFile(abs))) return null;
          return {
            range: cellRange(buffer, cells, m.start, m.end),
            text: text.slice(m.start, m.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => {
              if (!isLinkActivation(event)) return;
              // Read the context at click time: the tab may have moved windows.
              (contexts.get(ptyId) ?? ctx).open(abs, m.position);
            },
            hover: (event) => showLinkHint(term, event, FILE_LINK_HINT_TEXT),
            leave: () => hideLinkHint(term),
          };
        }),
      ).then((links) => {
        const found = links.filter((l): l is ILink => l !== null);
        callback(found.length > 0 ? found : undefined);
      });
    },
  };
}
