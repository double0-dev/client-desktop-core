import { describe, expect, it } from 'vitest';
import { clashTitle, isFileDrag, uploadLabel, uploadReport } from './explorer-upload';

const MB = 1024 * 1024;

describe('isFileDrag', () => {
  it('takes drags carrying files only', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true);
    expect(isFileDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe('uploadLabel', () => {
  it('names the host and the amount, and says when it is still preparing', () => {
    expect(uploadLabel(null, 'build-box')).toBe('Preparing the upload to build-box…');
    expect(uploadLabel(null, null)).toBe('Preparing the copy…');
    expect(
      uploadLabel({ done: 1, total: 3, bytes: 4.2 * MB, totalBytes: 12 * MB }, 'build-box'),
    ).toBe('Uploading 3 files to build-box - 4.2 of 12.0 MB');
    expect(uploadLabel({ done: 0, total: 1, bytes: 0, totalBytes: 300 * MB }, null)).toBe(
      'Copying 1 file - 0.0 of 300 MB',
    );
  });
});

describe('clashTitle', () => {
  it('names the first taken name and how many more', () => {
    expect(clashTitle({ name: '.env', count: 1 }, 'acme')).toBe('“.env” is already in acme');
    expect(clashTitle({ name: 'src', count: 3 }, 'acme')).toBe(
      '“src” and 2 more are already in acme',
    );
  });
});

describe('uploadReport', () => {
  it('says nothing when everything landed, nor for a cancel with nothing left out', () => {
    expect(uploadReport({ ok: true, copied: ['a'], skipped: [], errors: [] }, null)).toBeNull();
    expect(
      uploadReport({ ok: false, cancelled: true, copied: [], skipped: [], errors: [] }, null),
    ).toBeNull();
  });

  it('lists errors before skips, at most eight lines', () => {
    const skipped = Array.from({ length: 9 }, (_, i) => ({
      path: `l${i}`,
      reason: 'a link - not copied',
    }));
    const r = uploadReport(
      { ok: false, copied: [], skipped, errors: [{ path: 'big.iso', message: 'too large' }] },
      'build-box',
    )!;
    expect(r.title).toBe('Some files were not copied');
    const lines = r.description.split('\n');
    expect(lines[0]).toBe('big.iso - too large');
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe('and 2 more');
  });

  it('names the host that went away', () => {
    expect(uploadReport({ unreachable: true, copied: ['a', 'b'] }, 'build-box')).toEqual({
      title: 'The upload stopped',
      description: 'build-box is unreachable - 2 files arrived before it went.',
    });
  });
});
