import { createHighlighter, type HighlightToken } from '@tanstack/highlight/core';
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown';
import * as languages from '@tanstack/highlight/languages';

/**
 * Syntax colors for rendered markdown and diffs: TanStack
 * Highlight - every bundled language (~11 KB gzip), synchronous, no editor
 * stack to wait for, so a diff is colored the moment it lands (and the same
 * code runs in a mobile client later). It emits `th-*` classes; the colors
 * are its GitHub themes in assets/code-highlight.css.
 */
const highlighter = createHighlighter({
  languages: Object.values(languages),
  fallbackLanguage: 'plaintext',
});

/** For TanStack's markdown `TextPart`: highlights an answer's fenced code blocks. */
export const markdownHighlighter = createTanStackMarkdownHighlighter(highlighter);

const BY_EXTENSION: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  go: 'go',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  ejs: 'ejs',
  diff: 'diff',
  patch: 'diff',
  conf: 'nginx',
  scm: 'scheme',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  'cmakelists.txt': 'cmake',
  '.env': 'env',
  '.htaccess': 'apache',
};

/** The highlight language for a file path; null when none fits (plain text then). */
export function languageForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('.env')) return 'env';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
}

/** One line's colored runs: `className` is the token's `th-*` class, absent for plain text. */
export type CodeRun = { text: string; className?: string };

/** Characters past which a side is left uncolored (a whole-file diff of a huge file). */
const MAX_CHARS = 200_000;

/**
 * A text's lines as colored runs, line `i` at index `i` (always at least its
 * raw text, so a caller can index straight into a row). Null for an unknown
 * language or a text too large to color.
 */
export function highlightCodeLines(text: string, lang: string | null): CodeRun[][] | null {
  if (!lang || text.length > MAX_CHARS) return null;
  let tokens: HighlightToken[];
  try {
    tokens = highlighter.tokenize(text, { lang }).tokens;
  } catch {
    return null;
  }
  const lines: CodeRun[][] = [[]];
  for (const token of tokens) {
    const parts = token.value.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      lines[lines.length - 1].push(
        token.className
          ? { text: part, className: `th-token th-${token.className}` }
          : { text: part },
      );
    });
  }
  return lines;
}
