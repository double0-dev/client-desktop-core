import { describe, expect, it } from 'vitest';
import { showInFileManagerLabel, thisComputerLabel } from './platform-copy';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

describe('thisComputerLabel', () => {
  it('names the computer the way the running OS does', () => {
    // Settings said "this Mac" on Windows too.
    expect(thisComputerLabel(MAC)).toBe('this Mac');
    expect(thisComputerLabel(WINDOWS)).toBe('this PC');
    expect(thisComputerLabel(LINUX)).toBe('this computer');
  });
});

describe('showInFileManagerLabel', () => {
  it('names the platform file manager, with a neutral label on Linux', () => {
    expect(showInFileManagerLabel(MAC)).toBe('Show in Finder');
    expect(showInFileManagerLabel(WINDOWS)).toBe('Show in File Explorer');
    expect(showInFileManagerLabel(LINUX)).toBe('Show in folder');
  });
});
