import { useSyncExternalStore } from 'react';
import type { ISearchDecorationOptions } from '@xterm/addon-search';

/**
 * Find in terminal (design: `client_desktop.pen` › `Screen/Workspace - Terminal
 * Find` and `Label/Terminal find & links`). The search itself is the xterm
 * search addon each pooled terminal carries (`pool.ts`); this module holds
 * which terminals have their find bar open, the pure bits the bar renders
 * (count text, query validity) and the highlight colours.
 *
 * Open state is per `ptyId` and per window (renderer memory), like the rest of
 * a terminal's view state. ⌘F is caught by the terminal's own key handler, so
 * it only ever opens the bar of the terminal that has focus.
 */

export type FindRequest = {
  /** Bumped by every open request, so ⌘F on an open bar refocuses its field. */
  nonce: number;
  /** The terminal's selection at the time of the request (single line only). */
  seed: string;
};

const open = new Map<string, FindRequest>();
const listeners = new Set<() => void>();
let nonce = 0;

function emit(): void {
  for (const l of listeners) l();
}

/** Open (or refocus) the find bar of `ptyId`, seeded with its selection. */
export function openTerminalFind(ptyId: string, selection = ''): void {
  // A multi-line selection is not a useful query (the addon searches line by
  // line); keep the previous query instead.
  const seed = selection.includes('\n') ? '' : selection;
  open.set(ptyId, { nonce: ++nonce, seed });
  emit();
}

export function closeTerminalFind(ptyId: string): void {
  if (!open.delete(ptyId)) return;
  emit();
}

export function getTerminalFind(ptyId: string): FindRequest | undefined {
  return open.get(ptyId);
}

export function subscribeTerminalFind(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The find request of `ptyId` while its bar is open, else undefined. */
export function useTerminalFind(ptyId: string): FindRequest | undefined {
  return useSyncExternalStore(subscribeTerminalFind, () => open.get(ptyId));
}

export type FindOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };

/** Whether `query` can be searched: a regex query must compile. */
export function isValidQuery(query: string, options: Pick<FindOptions, 'regex'>): boolean {
  if (!options.regex) return true;
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

/** The addon's highlight cap; past it the addon reports index -1. */
export const FIND_HIGHLIGHT_LIMIT = 1000;

export type FindResults = { index: number; count: number };

/**
 * The count text right of the toggles. Empty for an empty query (the design
 * hides it), `Invalid regex` / `No results` in the destructive colour, and
 * `N+` once the addon stopped counting.
 */
export function findCountText(
  query: string,
  valid: boolean,
  results: FindResults | null,
): { text: string; error: boolean } {
  if (!query) return { text: '', error: false };
  if (!valid) return { text: 'Invalid regex', error: true };
  if (!results || results.count === 0) return { text: 'No results', error: true };
  if (results.index < 0) return { text: `${FIND_HIGHLIGHT_LIMIT}+`, error: false };
  return { text: `${results.index + 1} of ${results.count}`, error: false };
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * `color` at `alpha` over `background`, as `#RRGGBB` - the addon accepts only
 * opaque colours, so the design's primary-tinted highlights are pre-blended
 * against the terminal background. Unparseable input falls back to `color`.
 */
export function blendHex(color: string, background: string, alpha: number): string {
  const fg = parseHex(color);
  const bg = parseHex(background);
  if (!fg || !bg) return color;
  const mix = fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The default accent, for a `--primary` that is not a hex colour. */
const FALLBACK_PRIMARY = '#7da82f';

/** Highlights per the design: every match primary at 25 %, the current one at
 * 55 % with a primary outline. The addon wants `#RRGGBB`, so a primary or
 * background it cannot read falls back to the default accent / black. */
export function findDecorations(
  primaryCss: string,
  backgroundCss: string,
): ISearchDecorationOptions {
  const primary = parseHex(primaryCss) ? primaryCss.trim() : FALLBACK_PRIMARY;
  const background = parseHex(backgroundCss) ? backgroundCss.trim() : '#000000';
  return {
    matchBackground: blendHex(primary, background, 0.25),
    activeMatchBackground: blendHex(primary, background, 0.55),
    activeMatchBorder: primary,
    matchOverviewRuler: primary,
    activeMatchColorOverviewRuler: primary,
  };
}
