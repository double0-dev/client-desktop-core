import { describe, expect, it } from 'vitest';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { pathOf, uriOf } from './remote-uri';

describe('remote-uri', () => {
  it('keeps a local file a plain file URI with no authority', () => {
    const uri = uriOf(URI, null, '/Users/emmaw/acme/src/a.ts');
    expect(uri.authority).toBe('');
    expect(uri.toString()).toBe('file:///Users/emmaw/acme/src/a.ts');
    expect(pathOf(uri)).toEqual({ hostId: null, path: '/Users/emmaw/acme/src/a.ts' });
  });

  it('carries the host as the authority', () => {
    const uri = uriOf(URI, 'build-box', '/home/emmaw/acme/src/a.ts');
    expect(uri.scheme).toBe('file');
    expect(uri.authority).toBe('d0-host.build-box');
    expect(uri.toString()).toBe('file://d0-host.build-box/home/emmaw/acme/src/a.ts');
  });

  // The bug this prevents: two hosts' identical paths sharing one model.
  it('gives the same path on two machines two different URIs', () => {
    const a = uriOf(URI, 'build-box', '/home/emmaw/acme/a.ts').toString();
    const b = uriOf(URI, 'other-box', '/home/emmaw/acme/a.ts').toString();
    const local = uriOf(URI, null, '/home/emmaw/acme/a.ts').toString();
    expect(new Set([a, b, local]).size).toBe(3);
  });

  it('round-trips host and path, also through a string', () => {
    for (const [hostId, path] of [
      ['build-box', '/home/emmaw/acme/src/a b.ts'],
      [null, '/home/emmaw/acme/src/a.ts'],
    ] as const) {
      expect(pathOf(uriOf(URI, hostId, path))).toEqual({ hostId, path });
      expect(pathOf(URI.parse(uriOf(URI, hostId, path).toString()))).toEqual({ hostId, path });
    }
  });

  it('never reads a remote path as a UNC share', () => {
    const uri = uriOf(URI, 'build-box', '/srv/acme/x.ts');
    expect(pathOf(uri).path).toBe('/srv/acme/x.ts');
  });

  // A Windows client's own files: a drive path has no authority, a UNC share
  // has one - neither is a remote host.
  it('keeps a Windows drive path and a UNC share local', () => {
    const drive = {
      scheme: 'file',
      authority: '',
      path: '/c:/Users/emmaw/a.ts',
      fsPath: 'c:\\Users\\emmaw\\a.ts',
    };
    expect(pathOf(drive)).toEqual({ hostId: null, path: 'c:\\Users\\emmaw\\a.ts' });
    const unc = {
      scheme: 'file',
      authority: 'fileserver',
      path: '/acme/a.ts',
      fsPath: '\\\\fileserver\\acme\\a.ts',
    };
    expect(pathOf(unc)).toEqual({ hostId: null, path: '\\\\fileserver\\acme\\a.ts' });
    expect(pathOf(URI.file('/x.ts'))).toEqual({ hostId: null, path: '/x.ts' });
  });
});
