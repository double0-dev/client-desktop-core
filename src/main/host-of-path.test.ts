import { describe, expect, it } from 'vitest';
import { hostOfPath, hostRootsOf, projectPathConflict } from './host-of-path';

const roots = [
  { hostId: 'build-box', path: '/home/emmaw/acme' },
  { hostId: 'gpu-box', path: '/home/emmaw/acme/models' },
  { hostId: 'build-box', path: '/srv/production-pipeline' },
];

describe('hostOfPath', () => {
  it('answers by the longest remote root containing the path', () => {
    expect(hostOfPath('/home/emmaw/acme', roots)).toBe('build-box');
    expect(hostOfPath('/home/emmaw/acme/.worktree/fix-login', roots)).toBe('build-box');
    // A project nested in another host's project folder wins for its own subtree.
    expect(hostOfPath('/home/emmaw/acme/models/v2', roots)).toBe('gpu-box');
    expect(hostOfPath('/srv/production-pipeline/src', roots)).toBe('build-box');
  });

  it('is local (null) outside every remote root, on path boundaries only', () => {
    expect(hostOfPath('/home/emmaw/acme-old', roots)).toBeNull();
    expect(hostOfPath('/Users/emmaw/acme', roots)).toBeNull();
    expect(hostOfPath(null, roots)).toBeNull();
    expect(hostOfPath('', roots)).toBeNull();
    expect(hostOfPath('/home/emmaw/acme', [])).toBeNull();
  });

  it("matches realpath'd roots exactly, a trailing slash aside", () => {
    // Roots are stored realpath'd at add time (`fsReadDir` answers the realpath),
    // so a path under the realpath resolves; the symlinked spelling does not.
    const real = [{ hostId: 'build-box', path: '/data/emmaw/acme/' }];
    expect(hostOfPath('/data/emmaw/acme/src', real)).toBe('build-box');
    expect(hostOfPath('/data/emmaw/acme', real)).toBe('build-box');
    expect(hostOfPath('/home/emmaw/acme/src', real)).toBeNull();
  });
});

describe('hostRootsOf', () => {
  it('keeps only rows with a host and a path', () => {
    expect(
      hostRootsOf([
        { id: 'p1', name: 'acme', path: '/home/emmaw/acme', hostId: 'build-box' },
        { id: 'p2', name: 'local', path: '/Users/emmaw/local', hostId: null },
        { id: 'p3', name: 'nopath', path: null, hostId: 'build-box' },
      ]),
    ).toEqual([
      { hostId: 'build-box', path: '/home/emmaw/acme', projectId: 'p1', projectName: 'acme' },
    ]);
  });
});

describe('projectPathConflict', () => {
  const projects = [
    { name: 'acme', path: '/home/emmaw/acme', hostId: 'build-box' },
    { name: 'notes', path: '/Users/emmaw/notes', hostId: null },
  ];
  const label = (id: string): string => (id === 'build-box' ? 'Build box' : id);

  it('refuses a local project under (or over) a remote project at the same path', () => {
    expect(projectPathConflict('/home/emmaw/acme/web', null, projects, label)).toBe(
      "That folder belongs to Build box's project acme",
    );
    expect(projectPathConflict('/home/emmaw', null, projects, label)).toBe(
      "That folder belongs to Build box's project acme",
    );
  });

  it('refuses a remote project over a local one at the same path', () => {
    expect(projectPathConflict('/Users/emmaw/notes', 'build-box', projects, label)).toBe(
      "That folder belongs to this machine's project notes",
    );
  });

  it('lets projects on the same machine nest as before, and disjoint paths through', () => {
    expect(projectPathConflict('/home/emmaw/acme/web', 'build-box', projects, label)).toBeNull();
    expect(projectPathConflict('/Users/emmaw/other', null, projects, label)).toBeNull();
  });
});
