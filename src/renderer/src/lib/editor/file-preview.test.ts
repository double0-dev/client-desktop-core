import { describe, expect, it } from 'vitest';
import {
  browserPreviewable,
  defaultPreviewMode,
  previewKind,
  previewRoot,
} from '@renderer/lib/editor/file-preview';

describe('previewKind', () => {
  it('sorts files into markdown, web and media', () => {
    expect(previewKind('/a/README.md')).toBe('markdown');
    expect(previewKind('/a/index.HTML')).toBe('web');
    expect(previewKind('/a/logo.svg')).toBe('web');
    expect(previewKind('/a/spec.pdf')).toBe('media');
    expect(previewKind('/a/demo.webm')).toBe('media');
  });

  it('ignores code, extension-less files and dots in folder names', () => {
    expect(previewKind('/a/app.tsx')).toBeNull();
    expect(previewKind('/a/Makefile')).toBeNull();
    expect(previewKind('/a/v1.2/LICENSE')).toBeNull();
  });
});

describe('defaultPreviewMode', () => {
  it('opens media on the preview and everything else on its code', () => {
    expect(defaultPreviewMode('media')).toBe('preview');
    expect(defaultPreviewMode('markdown')).toBe('code');
    expect(defaultPreviewMode('web')).toBe('code');
  });
});

describe('previewRoot', () => {
  it('is the session folder for a file inside it, else the file’s folder', () => {
    expect(previewRoot('/Users/emmaw/acme/docs/a.html', '/Users/emmaw/acme/')).toBe(
      '/Users/emmaw/acme',
    );
    expect(previewRoot('/tmp/x/a.html', '/Users/emmaw/acme')).toBe('/tmp/x');
    expect(previewRoot('/Users/emmaw/acmeX/a.html', '/Users/emmaw/acme')).toBe(
      '/Users/emmaw/acmeX',
    );
    expect(previewRoot('/a.html', null)).toBe('/');
    expect(previewRoot('C:\\Users\\emma\\acme\\docs\\a.html', 'C:\\Users\\emma\\acme')).toBe(
      'C:\\Users\\emma\\acme',
    );
    expect(previewRoot('C:\\tmp\\a.html', null)).toBe('C:\\tmp');
  });
});

describe('browserPreviewable', () => {
  it('offers a browser tab for pages, SVG, PDF and video - not Markdown or code', () => {
    for (const p of ['/a/i.html', '/a/l.svg', '/a/s.pdf', '/a/d.mp4'])
      expect(browserPreviewable(p)).toBe(true);
    for (const p of ['/a/README.md', '/a/app.tsx', '/a/Makefile'])
      expect(browserPreviewable(p)).toBe(false);
  });
});
