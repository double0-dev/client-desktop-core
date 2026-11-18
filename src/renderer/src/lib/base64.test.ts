import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '@renderer/lib/base64';

describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a payload larger than one chunk', () => {
    // The encoder chunks through String.fromCharCode; a boundary bug would show
    // up as a shifted or truncated tail, not in a tiny input.
    const bytes = new Uint8Array(0x8000 * 3 + 17).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('encodes an empty array to an empty string and back', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array());
  });

  it('returns null for text that is not base64', () => {
    expect(base64ToBytes('not base64!')).toBeNull();
  });
});
