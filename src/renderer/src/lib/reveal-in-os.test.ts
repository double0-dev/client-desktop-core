import { describe, expect, it } from 'vitest';
import { revealInOsLabel } from './reveal-in-os';

describe('revealInOsLabel', () => {
  it('names the platform file manager so it never reads like the in-app explorer', () => {
    expect(
      revealInOsLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'),
    ).toBe('Reveal in Finder');
    expect(revealInOsLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe(
      'Reveal in File Explorer',
    );
  });

  it('falls back to a file-manager-neutral label on Linux', () => {
    // Linux has no single file manager to name.
    expect(revealInOsLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe(
      'Open containing folder',
    );
  });
});
