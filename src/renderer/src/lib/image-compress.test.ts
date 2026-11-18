import { describe, expect, it } from 'vitest';
import {
  detectMime,
  formatBytes,
  imagesFromDataTransfer,
  renameTo,
} from '@renderer/lib/image-compress';

// The canvas half of the shrinker needs a real renderer, so these cover the
// pure decisions around it: what we accept, what we call it, and how a paste or
// drop is unpacked.

const blob = (type: string): Blob => new Blob(['x'], { type });

/** Minimal DataTransfer stand-in - only `files` and `items` are ever read. */
function transfer(
  files: { name: string; type: string }[],
  items: { kind: string; type: string; file: { name: string; type: string } | null }[] = [],
): DataTransfer {
  return {
    files,
    items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file })),
  } as unknown as DataTransfer;
}

describe('detectMime', () => {
  it('accepts the two supported types by their declared mime', () => {
    expect(detectMime(blob('image/png'), 'a.png')).toBe('image/png');
    expect(detectMime(blob('image/jpeg'), 'a.jpg')).toBe('image/jpeg');
  });

  it('normalises the non-standard image/jpg some tools declare', () => {
    expect(detectMime(blob('image/jpg'), 'a.jpg')).toBe('image/jpeg');
  });

  it('rejects other image types even when the extension looks right', () => {
    expect(detectMime(blob('image/gif'), 'a.gif')).toBeNull();
    expect(detectMime(blob('image/webp'), 'a.png')).toBeNull();
    expect(detectMime(blob('application/pdf'), 'a.pdf')).toBeNull();
  });

  it('falls back to the extension for untyped blobs (some clipboard sources)', () => {
    expect(detectMime(blob(''), 'shot.PNG')).toBe('image/png');
    expect(detectMime(blob(''), 'shot.jpeg')).toBe('image/jpeg');
    expect(detectMime(blob(''), 'notes.txt')).toBeNull();
    expect(detectMime(blob(''), 'noextension')).toBeNull();
  });
});

describe('renameTo', () => {
  it('swaps the extension to the format actually stored', () => {
    expect(renameTo('screenshot.png', 'jpg')).toBe('screenshot.jpg');
    expect(renameTo('screenshot.jpeg', 'jpg')).toBe('screenshot.jpg');
    expect(renameTo('shot.png', 'png')).toBe('shot.png');
  });

  it('appends one when the name has no extension', () => {
    expect(renameTo('pasted', 'png')).toBe('pasted.png');
  });

  it('keeps dots inside the name', () => {
    expect(renameTo('v1.2.final.png', 'jpg')).toBe('v1.2.final.jpg');
  });

  it('never produces a bare extension', () => {
    expect(renameTo('.png', 'png')).toBe('image.png');
  });
});

describe('formatBytes', () => {
  it('scales the unit to the size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB');
  });

  it('drops a pointless decimal on whole megabytes (the 1 MB budget)', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4 MB');
  });
});

describe('imagesFromDataTransfer', () => {
  it('returns nothing without a transfer', () => {
    expect(imagesFromDataTransfer(null)).toEqual([]);
  });

  it('takes the dropped image files and skips everything else', () => {
    const found = imagesFromDataTransfer(
      transfer([
        { name: 'a.png', type: 'image/png' },
        { name: 'notes.txt', type: 'text/plain' },
        { name: 'b.jpg', type: 'image/jpeg' },
      ]),
    );
    expect(found.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
  });

  it('names an unnamed clipboard screenshot', () => {
    const found = imagesFromDataTransfer(transfer([{ name: '', type: 'image/png' }]));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('pasted.png');
  });

  it('falls back to items when the file list is empty', () => {
    const found = imagesFromDataTransfer(
      transfer(
        [],
        [
          { kind: 'string', type: 'text/plain', file: null },
          { kind: 'file', type: 'image/png', file: { name: 'c.png', type: 'image/png' } },
        ],
      ),
    );
    expect(found.map((f) => f.name)).toEqual(['c.png']);
  });

  it('ignores a plain-text paste entirely (so typing still pastes text)', () => {
    const found = imagesFromDataTransfer(
      transfer([], [{ kind: 'string', type: 'text/plain', file: null }]),
    );
    expect(found).toEqual([]);
  });
});
