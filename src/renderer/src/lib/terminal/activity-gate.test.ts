import { describe, expect, it } from 'vitest';
import { containsCommitKey, containsInterruptKey } from '@renderer/lib/terminal/activity-gate';

const ESC = String.fromCharCode(27);

describe('containsCommitKey', () => {
  it('detects Enter, digits, and y/n - the keys that answer a prompt', () => {
    expect(containsCommitKey('\r')).toBe(true);
    expect(containsCommitKey('2')).toBe(true);
    expect(containsCommitKey('y')).toBe(true);
    expect(containsCommitKey('N')).toBe(true);
  });

  it('detects a bare Esc (cancel) as a commit', () => {
    expect(containsCommitKey(ESC)).toBe(true);
  });

  it('ignores plain typing without commit characters', () => {
    expect(containsCommitKey('hello world')).toBe(false);
  });

  it('ignores arrow/nav keys - dialog navigation is not an answer', () => {
    expect(containsCommitKey(`${ESC}[A`)).toBe(false); // up
    expect(containsCommitKey(`${ESC}[1;2D`)).toBe(false); // modified arrow (has digits!)
    expect(containsCommitKey(`${ESC}OB`)).toBe(false); // SS3 down
  });

  it('ignores SGR mouse reports despite their digit parameters', () => {
    expect(containsCommitKey(`${ESC}[<35;12;40M`)).toBe(false); // motion
    expect(containsCommitKey(`${ESC}[<0;7;3m`)).toBe(false); // release
  });

  it('ignores legacy X10 mouse reports (arbitrary payload bytes)', () => {
    expect(containsCommitKey(`${ESC}[M C5`)).toBe(false);
  });

  it('ignores focus reports and bracketed-paste markers', () => {
    expect(containsCommitKey(`${ESC}[I`)).toBe(false);
    expect(containsCommitKey(`${ESC}[O`)).toBe(false);
    expect(containsCommitKey(`${ESC}[200~abc${ESC}[201~`)).toBe(false);
  });

  it('still finds the Enter that submits a bracketed paste', () => {
    expect(containsCommitKey(`${ESC}[200~fix it${ESC}[201~\r`)).toBe(true);
  });
});

describe('containsInterruptKey', () => {
  it('detects Esc, Esc Esc and Ctrl+C - the keys that stop a turn', () => {
    expect(containsInterruptKey(ESC)).toBe(true);
    expect(containsInterruptKey(`${ESC}${ESC}`)).toBe(true);
    expect(containsInterruptKey(String.fromCharCode(3))).toBe(true);
  });

  it('ignores sequences that merely start with ESC', () => {
    // Arrows (CSI and SS3), focus reports, SGR and legacy mouse reports,
    // paste brackets - none is the Esc key.
    expect(containsInterruptKey(`${ESC}[A`)).toBe(false);
    expect(containsInterruptKey(`${ESC}OB`)).toBe(false);
    expect(containsInterruptKey(`${ESC}[I${ESC}[O`)).toBe(false);
    expect(containsInterruptKey(`${ESC}[<0;12;5M${ESC}[<0;12;5m`)).toBe(false);
    expect(containsInterruptKey(`${ESC}[M ${ESC}!`)).toBe(false);
    expect(containsInterruptKey(`${ESC}[200~text${ESC}[201~`)).toBe(false);
  });

  it('reads ESC plus a character as Alt+key, not a cancel', () => {
    expect(containsInterruptKey(`${ESC}b`)).toBe(false);
    expect(containsInterruptKey('plain typing')).toBe(false);
  });
});
