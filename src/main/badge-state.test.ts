import { describe, expect, it } from 'vitest';
import {
  BADGE_COLORS,
  NO_BADGE,
  badgeDescription,
  badgeKind,
  countsFromStatusRows,
  discBitmap,
  paintDisc,
  sameCounts,
} from './badge-state';

/** BGRA of one pixel. */
function px(buf: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

describe('badgeKind', () => {
  it('shows nothing while no session is live', () => {
    expect(badgeKind(NO_BADGE)).toBeNull();
  });

  it('shows the running dot while an agent is working', () => {
    expect(badgeKind({ needsInput: 0, running: 2 })).toBe('running');
  });

  it('shows the waiting dot while an agent is blocked on the user', () => {
    expect(badgeKind({ needsInput: 1, running: 0 })).toBe('needs-input');
  });

  it('lets waiting win over running - the badge is a come-back cue', () => {
    expect(badgeKind({ needsInput: 1, running: 5 })).toBe('needs-input');
  });
});

describe('badgeDescription', () => {
  it('is empty when there is no dot', () => {
    expect(badgeDescription(NO_BADGE)).toBe('');
  });

  it('names the state with its own count, singular and plural', () => {
    expect(badgeDescription({ needsInput: 1, running: 0 })).toBe('1 session waiting for input');
    expect(badgeDescription({ needsInput: 0, running: 3 })).toBe('3 sessions running');
  });

  it('describes only the winning state', () => {
    expect(badgeDescription({ needsInput: 2, running: 3 })).toBe('2 sessions waiting for input');
  });
});

describe('countsFromStatusRows', () => {
  it('is all zeros for no rows', () => {
    expect(countsFromStatusRows([])).toEqual(NO_BADGE);
  });

  it('maps the two live statuses and accepts the driver’s string counts', () => {
    expect(
      countsFromStatusRows([
        { status: 'active', n: '3' },
        { status: 'needs-input', n: 1 },
      ]),
    ).toEqual({ needsInput: 1, running: 3 });
  });

  it('ignores statuses the badge does not track', () => {
    expect(
      countsFromStatusRows([
        { status: 'idle', n: 9 },
        { status: 'archived', n: 2 },
      ]),
    ).toEqual(NO_BADGE);
  });
});

describe('sameCounts', () => {
  it('compares both fields', () => {
    expect(sameCounts({ needsInput: 1, running: 2 }, { needsInput: 1, running: 2 })).toBe(true);
    expect(sameCounts({ needsInput: 1, running: 2 }, { needsInput: 1, running: 3 })).toBe(false);
    expect(sameCounts({ needsInput: 0, running: 2 }, { needsInput: 1, running: 2 })).toBe(false);
  });
});

describe('paintDisc', () => {
  const [red, green, blue] = BADGE_COLORS.running;

  it('paints the centre solid, premultiplied BGRA, and leaves the outside alone', () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    paintDisc(buf, size, size, { cx: 7.5, cy: 7.5, radius: 4, color: BADGE_COLORS.running });
    expect(px(buf, size, 7, 7)).toEqual([blue, green, red, 255]);
    // Four pixels beyond the radius: untouched transparent black.
    expect(px(buf, size, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(buf, size, 15, 7)).toEqual([0, 0, 0, 0]);
  });

  it('blends over an opaque ground instead of replacing it', () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    // Opaque black everywhere (BGRA 0,0,0,255).
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    paintDisc(buf, size, size, { cx: 7.5, cy: 7.5, radius: 4, color: BADGE_COLORS.running });
    expect(px(buf, size, 7, 7)).toEqual([blue, green, red, 255]);
    expect(px(buf, size, 0, 0)).toEqual([0, 0, 0, 255]);
    // (5,4) is ~4.3px from the centre - on the soft rim: the colour is only
    // partly there, but the ground stays opaque.
    const [b, g, r, a] = px(buf, size, 5, 4);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(red);
    expect(g).toBeLessThan(green);
    expect(b).toBeLessThan(blue);
  });

  it('softens the edge over a transparent ground', () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    paintDisc(buf, size, size, { cx: 7.5, cy: 7.5, radius: 4, color: BADGE_COLORS.running });
    // (5,4) is ~4.3px from the centre - on the soft rim.
    const [, , r, a] = px(buf, size, 5, 4);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    // Premultiplied: the colour channel scales with the alpha.
    expect(Math.abs(r - (red * a) / 255)).toBeLessThanOrEqual(1);
  });

  it('clips a disc that overhangs the bitmap', () => {
    const size = 8;
    const buf = Buffer.alloc(size * size * 4);
    const before = Buffer.from(buf);
    expect(() =>
      paintDisc(buf, size, size, {
        cx: 7.5,
        cy: 0.5,
        radius: 3,
        color: BADGE_COLORS['needs-input'],
      }),
    ).not.toThrow();
    expect(px(buf, size, 7, 0)[3]).toBe(255);
    // Nothing outside the disc was written - the far corner is as it was.
    expect(px(buf, size, 0, 7)).toEqual(px(before, size, 0, 7));
  });
});

describe('discBitmap', () => {
  it('is a solid dot of the given colour on a transparent square', () => {
    const size = 32;
    const [red, green, blue] = BADGE_COLORS['needs-input'];
    const buf = discBitmap(size, BADGE_COLORS['needs-input']);
    expect(buf.length).toBe(size * size * 4);
    expect(px(buf, size, 15, 15)).toEqual([blue, green, red, 255]);
    expect(px(buf, size, 16, 16)).toEqual([blue, green, red, 255]);
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      expect(px(buf, size, x, y)).toEqual([0, 0, 0, 0]);
    }
  });
});
