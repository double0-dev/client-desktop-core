import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { MAX_ROOTS, PreviewRegistry } from './preview';

describe('PreviewRegistry', () => {
  it('round-trips a file inside the folder', () => {
    const r = new PreviewRegistry();
    const url = r.urlFor('/Users/emmaw/acme', '/Users/emmaw/acme/docs/my page.html')!;
    expect(url).toMatch(/^d0-preview:\/\/[0-9a-f]{24}\/docs\/my%20page\.html$/);
    expect(r.resolve(url)).toBe(join('/Users/emmaw/acme', 'docs', 'my page.html'));
  });

  it('restores saved tokens, so a saved tab loads after a relaunch', () => {
    const first = new PreviewRegistry();
    const url = first.urlFor('/Users/emmaw/acme', '/Users/emmaw/acme/index.html')!;
    const next = new PreviewRegistry();
    next.load(JSON.parse(JSON.stringify(first.entries())));
    expect(next.resolve(url)).toBe(join('/Users/emmaw/acme', 'index.html'));
  });

  it('skips malformed saved entries', () => {
    const r = new PreviewRegistry();
    r.load([['nothex', '/a'], ['a'.repeat(24), 'relative'], 'junk', ['b'.repeat(24), '/ok']]);
    // Roots are stored normalised with the host's separators.
    expect(r.entries()).toEqual([['b'.repeat(24), join('/ok')]]);
    r.load({ not: 'an array' });
    expect(r.entries()).toHaveLength(1);
  });

  it('keeps the most recently previewed folders and reports changes', () => {
    const r = new PreviewRegistry();
    let changes = 0;
    r.onChange = () => changes++;
    const first = r.tokenFor('/f0');
    for (let i = 1; i <= MAX_ROOTS; i++) r.tokenFor(`/f${i}`);
    expect(r.entries()).toHaveLength(MAX_ROOTS);
    expect(r.rootOf(`d0-preview://${first}/x`)).toBeNull();
    expect(changes).toBe(MAX_ROOTS + 1);
  });

  it('keeps one token per folder', () => {
    const r = new PreviewRegistry();
    expect(r.tokenFor('/Users/emmaw/acme')).toBe(r.tokenFor('/Users/emmaw/acme/'));
    expect(r.tokenFor('/Users/emmaw/acme')).not.toBe(r.tokenFor('/Users/emmaw/other'));
  });

  it('refuses files outside the folder', () => {
    const r = new PreviewRegistry();
    expect(r.urlFor('/Users/emmaw/acme', '/etc/passwd')).toBeNull();
    expect(r.urlFor('/Users/emmaw/acme', '/Users/emmaw/acme')).toBeNull();
    expect(r.urlFor('relative', '/x')).toBeNull();
  });

  it('refuses requests that climb out, unknown tokens and other schemes', () => {
    // A page can request any path under its own token - `..` must not escape.
    const r = new PreviewRegistry();
    const token = r.tokenFor('/Users/emmaw/acme');
    // The URL parser folds encoded dot segments at the root: still inside.
    expect(r.resolve(`d0-preview://${token}/%2e%2e/%2e%2e/etc/passwd`)).toBe(
      join('/Users/emmaw/acme', 'etc', 'passwd'),
    );
    expect(r.resolve(`d0-preview://${token}/..%2f..%2fetc%2fpasswd`)).toBeNull();
    expect(r.resolve(`d0-preview://${token}/a%00b`)).toBeNull();
    expect(r.resolve('d0-preview://0123456789abcdef01234567/index.html')).toBeNull();
    expect(r.resolve(`file:///Users/emmaw/acme/index.html`)).toBeNull();
    expect(r.resolve(`d0-preview://${token}/`)).toBeNull();
    // Dot files and folders are never served.
    expect(r.resolve(`d0-preview://${token}/.env`)).toBeNull();
    expect(r.resolve(`d0-preview://${token}/.git/config`)).toBeNull();
    expect(r.resolve(`d0-preview://${token}/docs/index.html`)).toBe(
      join('/Users/emmaw/acme', 'docs', 'index.html'),
    );
  });
});

describe('host folders (plan 29 spec › 7.5)', () => {
  it("keeps a host's folder apart from this machine's same path, and restores it", async () => {
    const { PreviewRegistry, previewContentType } = await import('./preview');
    const r = new PreviewRegistry();
    const local = r.urlFor('/home/emmaw/acme', '/home/emmaw/acme/index.html');
    const remote = r.urlFor('/home/emmaw/acme', '/home/emmaw/acme/index.html', 'h1');
    expect(local).not.toBe(remote);
    expect(r.entryOf(local!)).toEqual({ root: '/home/emmaw/acme', hostId: null });
    expect(r.entryOf(remote!)).toEqual({ root: '/home/emmaw/acme', hostId: 'h1' });
    expect(r.resolve(remote!)).toBe('/home/emmaw/acme/index.html');
    // Dot files stay refused on a host too.
    expect(r.resolve(remote!.replace('index.html', '.env'))).toBeNull();
    const again = new PreviewRegistry();
    again.load(r.entries());
    expect(again.entryOf(remote!)).toEqual({ root: '/home/emmaw/acme', hostId: 'h1' });
    // A malformed host id is skipped.
    const bad = new PreviewRegistry();
    bad.load([['a'.repeat(24), '/x', '-oProxyCommand=x']]);
    expect(bad.entries()).toEqual([]);
    expect(previewContentType('/x/a.SVG')).toBe('image/svg+xml');
    expect(previewContentType('/x/a.bin')).toBe('application/octet-stream');
  });
});
