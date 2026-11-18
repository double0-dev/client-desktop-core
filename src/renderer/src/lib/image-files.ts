import { fileName } from '@renderer/lib/utils';

// Raster formats Chromium renders natively. SVG is intentionally absent - it's
// editable XML, so it keeps opening in the code editor.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

export function imageMime(path: string): string | undefined {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()];
}

/** Whether a path should open in the ImageViewer instead of the code editor. */
export function isImagePath(path: string): boolean {
  return imageMime(path) !== undefined;
}
