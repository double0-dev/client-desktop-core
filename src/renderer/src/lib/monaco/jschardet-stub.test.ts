import { describe, expect, it } from 'vitest';
import stub, { detect } from './jschardet-stub';

/**
 * The stand-in for the LGPL `jschardet` (jschardet-stub.ts): VS Code's
 * `guessEncodingByBuffer` calls `detect(…)` and treats a result without an
 * encoding as "no guess" - the shape must stay that, or a file would open
 * in a made-up encoding.
 */
describe('jschardet stand-in', () => {
  it('never guesses an encoding, through the named and the default export', () => {
    expect(detect()).toEqual({ encoding: null, confidence: 0 });
    expect(stub.detect()).toEqual({ encoding: null, confidence: 0 });
  });
});
