import { describe, expect, it } from 'vitest';

import {
  encodeMouse,
  encodeWheel,
  reports,
  WheelAccumulator,
} from '@renderer/lib/terminal/ghostty/mouse-report';

const base = { col: 9, row: 4, shift: false, alt: false, ctrl: false };

describe('encodeWheel', () => {
  it('encodes SGR wheel reports with 1-based cells', () => {
    expect(encodeWheel({ ...base, direction: 'up', sgr: true })).toBe('\x1b[<64;10;5M');
    expect(encodeWheel({ ...base, direction: 'down', sgr: true })).toBe('\x1b[<65;10;5M');
  });

  it('adds the modifier bits', () => {
    expect(
      encodeWheel({ ...base, direction: 'up', shift: true, alt: true, ctrl: true, sgr: true }),
    ).toBe('\x1b[<92;10;5M');
  });

  it('falls back to X10 bytes, clamped past what one byte can say', () => {
    expect(encodeWheel({ ...base, direction: 'up', sgr: false })).toBe('\x1b[M`*%');
    const far = encodeWheel({ ...base, col: 500, row: 300, direction: 'down', sgr: false });
    expect(far).toBe(`\x1b[Ma${String.fromCharCode(255)}${String.fromCharCode(255)}`);
  });
});

describe('encodeMouse', () => {
  const at = { ...base, sgr: true };

  it('reports a press and its release by button in SGR', () => {
    expect(encodeMouse({ ...at, action: 'press', button: 0 })).toBe('\x1b[<0;10;5M');
    expect(encodeMouse({ ...at, action: 'release', button: 0 })).toBe('\x1b[<0;10;5m');
    expect(encodeMouse({ ...at, action: 'press', button: 2 })).toBe('\x1b[<2;10;5M');
  });

  it('gives X10 one release code for every button', () => {
    expect(encodeMouse({ ...base, sgr: false, action: 'release', button: 2 })).toBe('\x1b[M#*%');
  });

  it('marks motion with 32: a drag keeps its button, plain motion is 3', () => {
    expect(encodeMouse({ ...at, action: 'move', button: 0 })).toBe('\x1b[<32;10;5M');
    expect(encodeMouse({ ...at, action: 'move', button: null })).toBe('\x1b[<35;10;5M');
  });

  it('adds the modifier bits', () => {
    expect(encodeMouse({ ...at, action: 'press', button: 0, alt: true, ctrl: true })).toBe(
      '\x1b[<24;10;5M',
    );
  });
});

describe('reports', () => {
  const press = { action: 'press', button: 0 } as const;
  const release = { action: 'release', button: 0 } as const;
  const drag = { action: 'move', button: 0 } as const;
  const hover = { action: 'move', button: null } as const;

  it('sends what each mode asks for, as xterm does', () => {
    const table = (mode: Parameters<typeof reports>[0]) =>
      [press, release, drag, hover].map((r) => reports(mode, r));
    expect(table('none')).toEqual([false, false, false, false]);
    expect(table('press')).toEqual([true, false, false, false]);
    expect(table('click')).toEqual([true, true, false, false]);
    expect(table('drag')).toEqual([true, true, true, false]);
    expect(table('any')).toEqual([true, true, true, true]);
  });
});

describe('WheelAccumulator', () => {
  it('turns pixel deltas into lines and carries the remainder', () => {
    const acc = new WheelAccumulator();
    // 10 px on 16 px cells: nothing yet, then the carried 0.625 completes a line.
    expect(acc.take(10, 0, 16, 40, 1)).toBe(0);
    expect(acc.take(10, 0, 16, 40, 1)).toBe(1);
  });

  it('scales by the sensitivity and keeps the sign (negative = up)', () => {
    expect(new WheelAccumulator().take(-2, 1, 16, 40, 3)).toBe(-6);
  });

  it('reads page deltas as rows and caps one event', () => {
    expect(new WheelAccumulator().take(1, 2, 16, 40, 1)).toBe(WheelAccumulator.MAX_STEPS);
  });

  it('forgets the remainder on reset', () => {
    const acc = new WheelAccumulator();
    acc.take(15, 0, 16, 40, 1);
    acc.reset();
    expect(acc.take(2, 0, 16, 40, 1)).toBe(0);
  });
});
