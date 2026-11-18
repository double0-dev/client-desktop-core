import { describe, expect, it } from 'vitest';
import { hostOfPath, remoteRootsOf } from './host-of-path';

describe('hostOfPath', () => {
  const roots = remoteRootsOf([
    { path: '/home/emmaw/acme', hostId: 'build-box' },
    { path: '/home/emmaw/acme/vendor/tools/', hostId: 'other-box' },
    { path: '/Users/emmaw/local', hostId: null },
  ]);

  it('keeps only rows with a host, separators trimmed', () => {
    expect(roots).toEqual([
      { hostId: 'build-box', path: '/home/emmaw/acme' },
      { hostId: 'other-box', path: '/home/emmaw/acme/vendor/tools' },
    ]);
  });

  it('resolves a file under a remote project to its host', () => {
    expect(hostOfPath('/home/emmaw/acme/src/a.ts', roots)).toBe('build-box');
    expect(hostOfPath('/home/emmaw/acme', roots)).toBe('build-box');
  });

  it('picks the longest root when two remote projects nest', () => {
    expect(hostOfPath('/home/emmaw/acme/vendor/tools/x.ts', roots)).toBe('other-box');
  });

  // A sibling that shares the prefix must not be read as inside the project.
  it('never matches a sibling sharing a prefix', () => {
    expect(hostOfPath('/home/emmaw/acme-old/a.ts', roots)).toBeNull();
  });

  it('is local for anything else and for no path', () => {
    expect(hostOfPath('/Users/emmaw/local/a.ts', roots)).toBeNull();
    expect(hostOfPath(null, roots)).toBeNull();
    expect(hostOfPath('', roots)).toBeNull();
  });
});
