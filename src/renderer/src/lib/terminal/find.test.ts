import { describe, expect, it } from 'vitest';
import {
  blendHex,
  closeTerminalFind,
  findCountText,
  findDecorations,
  getTerminalFind,
  isValidQuery,
  openTerminalFind,
  subscribeTerminalFind,
} from '@renderer/lib/terminal/find';

let n = 0;
const ptyId = (): string => `find-${++n}`;

describe('find bar open state', () => {
  it('opens per terminal, seeded with the selection', () => {
    const a = ptyId();
    const b = ptyId();
    openTerminalFind(a, 'token');
    expect(getTerminalFind(a)?.seed).toBe('token');
    expect(getTerminalFind(b)).toBeUndefined();
    closeTerminalFind(a);
  });

  it('bumps the nonce on every open, so ⌘F on an open bar refocuses it', () => {
    const id = ptyId();
    openTerminalFind(id);
    const first = getTerminalFind(id)!.nonce;
    openTerminalFind(id);
    expect(getTerminalFind(id)!.nonce).toBeGreaterThan(first);
    closeTerminalFind(id);
  });

  it('ignores a multi-line selection as the seed', () => {
    // The search runs line by line; a two-line query could never match.
    const id = ptyId();
    openTerminalFind(id, 'one\ntwo');
    expect(getTerminalFind(id)?.seed).toBe('');
    closeTerminalFind(id);
  });

  it('notifies on open and close, and not on closing a closed bar', () => {
    const id = ptyId();
    let calls = 0;
    const off = subscribeTerminalFind(() => calls++);
    openTerminalFind(id);
    closeTerminalFind(id);
    closeTerminalFind(id);
    off();
    expect(calls).toBe(2);
  });
});

describe('isValidQuery', () => {
  it('accepts any text when regex is off', () => {
    expect(isValidQuery('a(b', { regex: false })).toBe(true);
  });

  it('rejects a regex that does not compile', () => {
    expect(isValidQuery('a(b', { regex: true })).toBe(false);
    expect(isValidQuery('a(b)', { regex: true })).toBe(true);
  });
});

describe('findCountText', () => {
  it('is empty for an empty query (the design hides it)', () => {
    expect(findCountText('', true, null)).toEqual({ text: '', error: false });
  });

  it('names the current match and the total', () => {
    expect(findCountText('token', true, { index: 1, count: 7 })).toEqual({
      text: '2 of 7',
      error: false,
    });
  });

  it('says No results in the error colour', () => {
    expect(findCountText('token', true, { index: -1, count: 0 })).toEqual({
      text: 'No results',
      error: true,
    });
    expect(findCountText('token', true, null).text).toBe('No results');
  });

  it('says Invalid regex before anything else', () => {
    expect(findCountText('a(', false, { index: 0, count: 3 })).toEqual({
      text: 'Invalid regex',
      error: true,
    });
  });

  it('caps the count once the addon stops counting', () => {
    expect(findCountText('e', true, { index: -1, count: 1500 }).text).toBe('1000+');
  });
});

describe('highlight colours', () => {
  it('pre-blends the accent over the terminal background', () => {
    // The addon accepts only opaque #RRGGBB.
    expect(blendHex('#ffffff', '#000000', 0.25)).toBe('#404040');
    expect(blendHex('#a8c945', '#0d0d0d', 1)).toBe('#a8c945');
    expect(blendHex('#fff', '#000', 0)).toBe('#000000');
  });

  it('follows the design: 25 % for matches, 55 % plus an outline for the current one', () => {
    const d = findDecorations(' #ffffff ', '#000000');
    expect(d.matchBackground).toBe('#404040');
    expect(d.activeMatchBackground).toBe('#8c8c8c');
    expect(d.activeMatchBorder).toBe('#ffffff');
  });

  it('falls back to the default accent when --primary is not a hex colour', () => {
    const d = findDecorations('oklch(0.7 0.1 120)', '#000000');
    expect(d.activeMatchBorder).toBe('#7da82f');
    expect(d.matchBackground).toMatch(/^#[0-9a-f]{6}$/);
  });
});
