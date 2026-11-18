// Which workspace files get a preview, and how (a private plan ›
// File previews). Pure.

/**
 * - `markdown`: rendered in the app, Code / Preview switch.
 * - `web`: HTML / SVG loaded in a browser page, Code / Preview switch.
 * - `media`: PDF and video - a browser page only (there is no code to edit).
 */
export type PreviewKind = 'markdown' | 'web' | 'media';

const KINDS: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'web',
  htm: 'web',
  svg: 'web',
  pdf: 'media',
  mp4: 'media',
  webm: 'media',
  mov: 'media',
  m4v: 'media',
  ogv: 'media',
};

export function previewKind(path: string): PreviewKind | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return null;
  return KINDS[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Whether a browser tab can show this file (HTML, SVG, PDF, video) - the
 * explorer's "Open in browser tab". Markdown is rendered in the app instead. */
export function browserPreviewable(path: string): boolean {
  const kind = previewKind(path);
  return kind === 'web' || kind === 'media';
}

/** What a file opens on: media only previews; the rest open on their code. */
export function defaultPreviewMode(kind: PreviewKind): 'code' | 'preview' {
  return kind === 'media' ? 'preview' : 'code';
}

/**
 * The folder a preview may read under: the session's folder when the file is
 * inside it (relative links between its pages work), else the file's own folder.
 */
export function previewRoot(file: string, cwd: string | null): string {
  // Either separator (Windows paths too) - a missed one fell back to the
  // drive root, exposing the whole disk to the preview (review, 2026-10-06).
  if (cwd) {
    const base = cwd.replace(/[\\/]+$/, '');
    if (file.startsWith(`${base}/`) || file.startsWith(`${base}\\`)) return base;
  }
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut > 0 ? file.slice(0, cut) : file.slice(0, cut + 1) || '/';
}
