/**
 * Find in terminal for the Ghostty engine: the subset of xterm's
 * `SearchAddon` the find bar uses (`findNext` / `findPrevious` /
 * `clearDecorations` / `onDidChangeResults`). Matches are found per buffer
 * row; the current one is selected and scrolled into view, and with
 * `decorations` every match is handed to the host to highlight. As xterm's
 * addon does with decorations on, `refresh()` (the host calls it after new
 * output) counts and highlights again without moving the view.
 */

/** xterm's `ISearchDecorationOptions`, the part the highlights read. */
export type SearchDecorations = {
  matchBackground?: string;
  matchBorder?: string;
  activeMatchBackground?: string;
  activeMatchBorder?: string;
};

export type SearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  incremental?: boolean;
  decorations?: SearchDecorations;
};

export type SearchMatch = { row: number; col: number; length: number };

export type SearchResults = { resultIndex: number; resultCount: number };

/** Matches cap - a one-letter query over a long scrollback stays cheap. */
export const MAX_SEARCH_MATCHES = 1000;

/** A compiled query, or null when it cannot match (empty, a broken regex). */
export function compileQuery(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `\\b${source}\\b`;
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Every match in `rows` (buffer rows top to bottom), in reading order. */
export function findMatches(rows: readonly string[], pattern: RegExp): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (let row = 0; row < rows.length; row++) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rows[row])) !== null) {
      if (m[0].length === 0) {
        pattern.lastIndex += 1; // an empty match (`a*`) would loop forever
        continue;
      }
      matches.push({ row, col: m.index, length: m[0].length });
      if (matches.length >= MAX_SEARCH_MATCHES) return matches;
    }
  }
  return matches;
}

/**
 * Which match comes next. `from` is the current match (or null): forward
 * takes the first match after it, backward the last one before it, both
 * wrapping. `incremental` keeps a match that still starts where the current
 * one did (the query grew by a letter).
 */
export function nextMatchIndex(
  matches: readonly SearchMatch[],
  from: { row: number; col: number } | null,
  direction: 'next' | 'previous',
  incremental = false,
): number {
  if (matches.length === 0) return -1;
  if (!from) return direction === 'next' ? 0 : matches.length - 1;
  const cmp = (m: SearchMatch): number => m.row - from.row || m.col - from.col;
  if (incremental) {
    const same = matches.findIndex((m) => cmp(m) === 0);
    if (same !== -1) return same;
  }
  if (direction === 'next') {
    const i = matches.findIndex((m) => (incremental ? cmp(m) >= 0 : cmp(m) > 0));
    return i === -1 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (cmp(matches[i]) < 0) return i;
  return matches.length - 1;
}

/** What the search needs from the terminal. */
export type SearchHost = {
  /** Every buffer row's text, top to bottom (scrollback included). */
  rows: () => string[];
  /** Scroll `row` into view and select the match there. */
  reveal: (match: SearchMatch) => void;
  clearSelection: () => void;
  /** Show every match, `current` (an index, or -1) set apart. */
  highlight: (
    matches: readonly SearchMatch[],
    current: number,
    decorations: SearchDecorations,
  ) => void;
  clearHighlights: () => void;
};

type Listener = (results: SearchResults) => void;

export class GhosttySearch {
  private current: SearchMatch | null = null;
  /** The last search, kept for `refresh()` until `clearDecorations()`. */
  private last: { query: string; options: SearchOptions } | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly host: SearchHost) {}

  findNext(query: string, options: SearchOptions = {}): boolean {
    return this.find(query, options, 'next');
  }

  findPrevious(query: string, options: SearchOptions = {}): boolean {
    return this.find(query, options, 'previous');
  }

  clearDecorations(): void {
    if (this.current) this.host.clearSelection();
    this.current = null;
    this.last = null;
    this.host.clearHighlights();
  }

  /** Whether a search is showing (output should re-count it). */
  get active(): boolean {
    return this.last !== null;
  }

  /**
   * Count again after the buffer changed: the current match stays where it
   * is (or the next one after it takes its place), the view does not move.
   */
  refresh(): void {
    const last = this.last;
    if (!last) return;
    const pattern = compileQuery(last.query, last.options);
    const matches = pattern ? findMatches(this.host.rows(), pattern) : [];
    const index = this.current ? nextMatchIndex(matches, this.current, 'next', true) : -1;
    this.current = index === -1 ? null : matches[index];
    this.publish(matches, index, last.options);
  }

  onDidChangeResults(listener: Listener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  activate(): void {
    // Made with its terminal - nothing to attach.
  }

  dispose(): void {
    this.listeners.clear();
    this.current = null;
    this.last = null;
  }

  private find(query: string, options: SearchOptions, direction: 'next' | 'previous'): boolean {
    const pattern = compileQuery(query, options);
    const matches = pattern ? findMatches(this.host.rows(), pattern) : [];
    const index = nextMatchIndex(matches, this.current, direction, options.incremental);
    this.current = index === -1 ? null : matches[index];
    this.last = pattern ? { query, options } : null;
    if (this.current) this.host.reveal(this.current);
    else this.host.clearSelection();
    this.publish(matches, index, options);
    return index !== -1;
  }

  private publish(matches: SearchMatch[], index: number, options: SearchOptions): void {
    if (options.decorations && matches.length > 0) {
      this.host.highlight(matches, index, options.decorations);
    } else this.host.clearHighlights();
    const results = { resultIndex: index, resultCount: matches.length };
    for (const listener of this.listeners) listener(results);
  }
}
