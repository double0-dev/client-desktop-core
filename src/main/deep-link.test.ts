import { describe, expect, it } from 'vitest';
import { findAppLink } from './deep-link';

const SCHEME = 'com.double0.desktop';

describe('findAppLink', () => {
  it('finds a link on the app scheme among other argv entries', () => {
    const url = `${SCHEME}://open`;
    expect(findAppLink(['/usr/bin/app', '--flag', url], SCHEME)).toBe(url);
  });

  // A prefix match on the bare scheme name would hand another app's link to
  // the extension (`com.double0.desktop-dev:` is a different scheme).
  it('ignores a scheme that only starts with the same name', () => {
    expect(findAppLink([`${SCHEME}-dev://open`], SCHEME)).toBeNull();
    expect(findAppLink(['https://example.com/open'], SCHEME)).toBeNull();
  });

  it('returns null when no link is there', () => {
    expect(findAppLink(['/usr/bin/app', '--flag'], SCHEME)).toBeNull();
  });
});
