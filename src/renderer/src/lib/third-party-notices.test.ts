import { describe, expect, it } from 'vitest';
import { filterNotices, noticeKey, type NoticePackage } from './third-party-notices';

const p = (name: string, license: string | null, version = '1.0.0'): NoticePackage => ({
  name,
  version,
  license,
  files: [],
});

const PACKAGES = [
  p('@xterm/xterm', 'MIT'),
  p('drizzle-orm', 'Apache-2.0'),
  p('jschardet', 'LGPL-2.1+'),
  p('react', 'MIT'),
];

describe('filterNotices', () => {
  it('shows every package for an empty query, in the document’s order', () => {
    expect(filterNotices(PACKAGES, '  ').map((x) => x.name)).toEqual([
      '@xterm/xterm',
      'drizzle-orm',
      'jschardet',
      'react',
    ]);
  });

  it('matches the name or the licence, case-insensitively', () => {
    expect(filterNotices(PACKAGES, 'XTERM').map((x) => x.name)).toEqual(['@xterm/xterm']);
    expect(filterNotices(PACKAGES, 'apache').map((x) => x.name)).toEqual(['drizzle-orm']);
  });

  it('needs every word to match', () => {
    expect(filterNotices(PACKAGES, 'mit react').map((x) => x.name)).toEqual(['react']);
    expect(filterNotices(PACKAGES, 'mit drizzle')).toEqual([]);
  });

  it('copes with a package whose licence is not stated', () => {
    expect(filterNotices([p('bare', null)], 'bare')).toHaveLength(1);
  });
});

describe('noticeKey', () => {
  it('tells two versions of one package apart', () => {
    expect(noticeKey(p('a', 'MIT', '1.0.0'))).not.toBe(noticeKey(p('a', 'MIT', '2.0.0')));
  });
});
