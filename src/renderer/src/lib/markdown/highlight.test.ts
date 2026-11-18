import { describe, expect, it } from 'vitest';
import { highlightCodeLines, languageForPath, markdownHighlighter } from './highlight';

describe('languageForPath', () => {
  it('picks the language by extension or well-known name', () => {
    expect(languageForPath('/repo/src/app.tsx')).toBe('tsx');
    expect(languageForPath('C:\\repo\\main.py')).toBe('python');
    expect(languageForPath('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/repo/.env.local')).toBe('env');
    expect(languageForPath('/repo/notes.unknownext')).toBeNull();
    expect(languageForPath('/repo/Makefile')).toBeNull();
  });
});

describe('highlightCodeLines', () => {
  it('splits the tokens into colored runs per line, keeping every line', () => {
    const lines = highlightCodeLines('const a = "x";\n\nfoo(1)', 'ts')!;
    expect(lines).toHaveLength(3);
    expect(lines[0][0]).toEqual({ text: 'const', className: 'th-token th-keyword' });
    expect(lines[0].map((r) => r.text).join('')).toBe('const a = "x";');
    expect(lines[1]).toEqual([]);
    expect(lines[2].find((r) => r.text === '1')?.className).toBe('th-token th-number');
  });

  it('colors a multi-line token on each of its lines', () => {
    const lines = highlightCodeLines('/* one\ntwo */\nx', 'ts')!;
    expect(lines[0][0].className).toBe('th-token th-comment');
    expect(lines[1][0]).toEqual({ text: 'two */', className: 'th-token th-comment' });
  });

  it('leaves an unknown language or a huge text plain', () => {
    expect(highlightCodeLines('x', null)).toBeNull();
    expect(highlightCodeLines('x'.repeat(300_000), 'ts')).toBeNull();
  });
});

describe('markdownHighlighter', () => {
  it('escapes the source while it colors it', () => {
    const html = markdownHighlighter('const s = "<b>";', 'ts');
    expect(html).toContain('th-keyword');
    expect(html).not.toContain('<b>');
  });
});
