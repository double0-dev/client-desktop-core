/**
 * Stands in for `jschardet` (LGPL-2.1), which the editor's VS Code packages
 * depend on. VS Code imports it in one place - `encoding.ts` ›
 * `guessEncodingByBuffer` - and only to guess a file's encoding while
 * `files.autoGuessEncoding` is on, which this app never turns on. So the
 * library never ran, and shipping it only brought its licence's obligations
 * into a closed app (a private plan › E). electron.vite.config.ts
 * aliases the import here, and the packages leave it out of node_modules
 * (electron-builder `files`, check-app-asar.mjs › LEFT_OUT).
 *
 * If encoding guessing is ever wanted, use a permissively licensed detector
 * here instead.
 */

export type DetectResult = { encoding: string | null; confidence: number };

/** Never guesses: VS Code then keeps the encoding it already had (UTF-8 by default). */
export function detect(): DetectResult {
  return { encoding: null, confidence: 0 };
}

export default { detect };
