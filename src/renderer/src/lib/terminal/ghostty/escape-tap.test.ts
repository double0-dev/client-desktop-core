import { describe, expect, it } from 'vitest';

import { EscapeTap, type TapPiece } from '@renderer/lib/terminal/ghostty/escape-tap';

const tap = (osc: number[] = [6790, 6791], csi: [string, string][] = [['?', 'h']]) =>
  new EscapeTap({
    osc: (id) => osc.includes(id),
    csi: (prefix, final) => csi.some(([p, f]) => p === prefix && f === final),
  });

const texts = (pieces: TapPiece[]): string => pieces.map((p) => p.text).join('');

describe('EscapeTap', () => {
  it('cuts the text right after a wanted OSC, so the handler runs where xterm would run it', () => {
    const pieces = tap().feed('ab\x1b]6791;at;3\x07cd');
    expect(pieces).toEqual([
      { text: 'ab\x1b]6791;at;3\x07', event: { kind: 'osc', id: 6791, data: 'at;3' } },
      { text: 'cd' },
    ]);
  });

  it('passes every character through unchanged, sequences included', () => {
    const input = 'x\x1b]0;title\x07y\x1b]6790;running\x1b\\z\x1b[?1006hw';
    expect(texts(tap().feed(input))).toBe(input);
  });

  it('accepts ST (ESC \\) as the terminator', () => {
    const [first] = tap().feed('\x1b]6790;ended\x1b\\');
    expect(first.event).toEqual({ kind: 'osc', id: 6790, data: 'ended' });
  });

  it('ignores an OSC nobody asked for', () => {
    expect(
      tap()
        .feed('\x1b]0;window title\x07')
        .every((p) => !p.event),
    ).toBe(true);
  });

  it('finds a sequence split across chunks, once', () => {
    const t = tap();
    const a = t.feed('one\x1b]67');
    const b = t.feed('91;cwd;L3RtcA==');
    const c = t.feed('\x07two');
    expect([...a, ...b].every((p) => !p.event)).toBe(true);
    expect(c[0]).toEqual({
      text: '\x07',
      event: { kind: 'osc', id: 6791, data: 'cwd;L3RtcA==' },
    });
    expect(texts([...a, ...b, ...c])).toBe('one\x1b]6791;cwd;L3RtcA==\x07two');
  });

  it('reports an OSC with no payload', () => {
    expect(tap().feed('\x1b]6790\x07')[0].event).toEqual({ kind: 'osc', id: 6790, data: '' });
  });

  it('drops an OSC cancelled by CAN and starts over at a new ESC', () => {
    const pieces = tap().feed('\x1b]6790;run\x18\x1b]6790;idle\x07');
    expect(pieces.filter((p) => p.event).map((p) => p.event)).toEqual([
      { kind: 'osc', id: 6790, data: 'idle' },
    ]);
  });

  it('treats an ESC inside an OSC as the start of the next sequence', () => {
    const pieces = tap().feed('\x1b]6790;broken\x1b]6791;ps\x07');
    expect(pieces.filter((p) => p.event).map((p) => p.event)).toEqual([
      { kind: 'osc', id: 6791, data: 'ps' },
    ]);
  });

  it('reports a wanted DECSET with its parameters', () => {
    const [first] = tap().feed('\x1b[?1000;1006h');
    expect(first.event).toEqual({ kind: 'csi', prefix: '?', final: 'h', params: [1000, 1006] });
  });

  it('ignores CSIs with another final, prefix or an intermediate', () => {
    const pieces = tap().feed('\x1b[?1006l\x1b[1006h\x1b[2J\x1b[?1 h\x1b[5;10H');
    expect(pieces.every((p) => !p.event)).toBe(true);
  });

  it('keeps the head of a sub-parameter and reads an empty one as 0', () => {
    const [first] = tap([], [['', 'm']]).feed('\x1b[4:3;;38m');
    expect(first.event).toEqual({ kind: 'csi', prefix: '', final: 'm', params: [4, 0, 38] });
  });

  it('never collects an oversized payload', () => {
    const huge = 'a'.repeat((1 << 20) + 10);
    const pieces = tap().feed(`\x1b]6790;${huge}\x07after`);
    expect(pieces.some((p) => p.event)).toBe(false);
    expect(texts(pieces)).toBe(`\x1b]6790;${huge}\x07after`);
  });
});
