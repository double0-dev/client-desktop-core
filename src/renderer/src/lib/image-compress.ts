/**
 * Shrinks an image to something small enough to attach to a task.
 *
 * Everything runs in the renderer on a canvas - no native image library, no
 * extra dependency. The rules the UI advertises live here so the dialog and the
 * hint text can't drift apart:
 *
 *   · PNG and JPEG only
 *   · at most `MAX_IMAGE_BYTES` on disk
 *   · at most `MAX_IMAGE_EDGE` on the longest side
 *
 * An image that already satisfies all three is stored byte-for-byte - we never
 * re-encode (and lose quality) for nothing. Anything larger is downscaled, and
 * re-encoded only if downscaling alone can't get it under budget.
 *
 * A later backend can reuse this: it produces plain bytes plus the metadata the
 * `task_images` row needs.
 */

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;

/**
 * Floor for the automatic downscale ladder. Below this a UI screenshot stops
 * being readable, so we switch to re-encoding rather than shrinking further.
 */
const MIN_IMAGE_EDGE = 1000;

/** JPEG quality ladder, tried in order once shrinking alone isn't enough. */
const JPEG_QUALITIES = [0.85, 0.72, 0.6, 0.45] as const;

export const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME_TYPES)[number];

/** The `accept` attribute for the file picker - kept next to the mime list. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';

export type CompressedImage = {
  // Pinned to a plain ArrayBuffer (not ArrayBufferLike): a Blob part and a
  // structured-cloned IPC payload both reject a possibly-shared buffer.
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: AcceptedMime;
  /** Storage extension - main builds the on-disk path from this. */
  ext: 'png' | 'jpg';
  width: number;
  height: number;
  /** Original name, normalised to match the format we actually stored. */
  fileName: string;
};

/** Thrown for anything the user should see a message about (wrong type, too big). */
export class ImageRejected extends Error {}

const extFor = (mime: AcceptedMime): 'png' | 'jpg' => (mime === 'image/png' ? 'png' : 'jpg');

/** Human-readable size for hints and error messages ("1 MB", "2.4 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  // A whole number of MB reads better without the ".0" - the budget in the
  // dialog's hint is exactly 1 MB.
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * The blob's format, from its declared type or (for clipboard blobs that arrive
 * untyped) its filename. Returns null for anything we don't accept.
 */
export function detectMime(blob: Blob, fileName: string): AcceptedMime | null {
  const declared = blob.type.toLowerCase();
  if (declared === 'image/png') return 'image/png';
  if (declared === 'image/jpeg' || declared === 'image/jpg') return 'image/jpeg';
  if (declared) return null;
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return null;
}

/** Swap a filename's extension so it matches the format we stored. */
export function renameTo(fileName: string, ext: 'png' | 'jpg'): string {
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${ext}`;
}

/** Draw the bitmap at `scale` onto a fresh canvas. */
function drawScaled(
  bitmap: ImageBitmap,
  scale: number,
  background: string | null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageRejected('This image couldn’t be processed.');
  ctx.imageSmoothingQuality = 'high';
  // JPEG has no alpha channel: without this, transparent areas encode as black.
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, mime: AcceptedMime, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new ImageRejected('This image couldn’t be re-encoded.')),
      mime,
      quality,
    );
  });
}

/** True if any pixel is not fully opaque - decides whether JPEG is safe. */
function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

const bytesOf = async (blob: Blob): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await blob.arrayBuffer());

/**
 * Validate and shrink one image. Resolves with bytes ready to store, or rejects
 * with an {@link ImageRejected} whose message can be shown as-is.
 */
export async function compressImage(blob: Blob, fileName: string): Promise<CompressedImage> {
  const sourceMime = detectMime(blob, fileName);
  if (!sourceMime) {
    throw new ImageRejected(`“${fileName}” isn’t a PNG or JPG.`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ImageRejected(`“${fileName}” couldn’t be read as an image.`);
  }

  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height);

    // Already within budget on both axes - store the original bytes untouched
    // rather than round-tripping them through the encoder.
    if (blob.size <= MAX_IMAGE_BYTES && longestEdge <= MAX_IMAGE_EDGE) {
      return {
        bytes: await bytesOf(blob),
        mimeType: sourceMime,
        ext: extFor(sourceMime),
        width: bitmap.width,
        height: bitmap.height,
        fileName: renameTo(fileName, extFor(sourceMime)),
      };
    }

    const startScale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
    // PNG keeps text crisp, so a PNG source is shrunk as far as MIN_IMAGE_EDGE
    // before we consider throwing away quality by moving to JPEG.
    if (sourceMime === 'image/png') {
      for (let scale = startScale; ; scale *= 0.8) {
        const canvas = drawScaled(bitmap, scale, null);
        const png = await encode(canvas, 'image/png');
        if (png.size <= MAX_IMAGE_BYTES) {
          return {
            bytes: await bytesOf(png),
            mimeType: 'image/png',
            ext: 'png',
            width: canvas.width,
            height: canvas.height,
            fileName: renameTo(fileName, 'png'),
          };
        }
        // Transparency can't survive JPEG, so those keep shrinking as PNG.
        if (Math.max(canvas.width, canvas.height) <= MIN_IMAGE_EDGE && !hasTransparency(canvas)) {
          break;
        }
        if (Math.max(canvas.width, canvas.height) <= 320) {
          throw new ImageRejected(
            `“${fileName}” couldn’t be shrunk below ${formatBytes(MAX_IMAGE_BYTES)}.`,
          );
        }
      }
    }

    // JPEG ladder: drop quality first, then size, until it fits.
    for (let scale = startScale; ; scale *= 0.8) {
      const canvas = drawScaled(bitmap, scale, '#ffffff');
      for (const quality of JPEG_QUALITIES) {
        const jpeg = await encode(canvas, 'image/jpeg', quality);
        if (jpeg.size <= MAX_IMAGE_BYTES) {
          return {
            bytes: await bytesOf(jpeg),
            mimeType: 'image/jpeg',
            ext: 'jpg',
            width: canvas.width,
            height: canvas.height,
            fileName: renameTo(fileName, 'jpg'),
          };
        }
      }
      if (Math.max(canvas.width, canvas.height) <= 320) {
        throw new ImageRejected(
          `“${fileName}” couldn’t be shrunk below ${formatBytes(MAX_IMAGE_BYTES)}.`,
        );
      }
    }
  } finally {
    bitmap.close();
  }
}

/**
 * Pull every image out of a paste or drop. Clipboard screenshots arrive as an
 * unnamed `image/png` blob, so those get a generated name.
 */
export function imagesFromDataTransfer(data: DataTransfer | null): { blob: Blob; name: string }[] {
  if (!data) return [];
  const out: { blob: Blob; name: string }[] = [];
  // `files` covers both dropped files and pasted screenshots; `items` is only
  // consulted when the file list is empty (some sources populate one, not both).
  const files = Array.from(data.files);
  if (files.length > 0) {
    for (const file of files) {
      if (file.type.startsWith('image/')) out.push({ blob: file, name: file.name || 'pasted.png' });
    }
    return out;
  }
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push({ blob: file, name: file.name || 'pasted.png' });
  }
  return out;
}
