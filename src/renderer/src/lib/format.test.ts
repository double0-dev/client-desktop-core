import { describe, expect, it } from 'vitest';
import { initialsOf, ms, projectIconStyle, relativeShort } from '@renderer/lib/format';

describe('ms', () => {
  it('converts a Date', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(ms(d)).toBe(d.getTime());
  });

  it('converts an ISO string (Electric rows arrive as strings)', () => {
    expect(ms('2026-01-02T03:04:05.000Z')).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  });
});

describe('relativeShort', () => {
  const now = Date.parse('2026-01-02T12:00:00.000Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000);

  it('renders seconds under a minute', () => {
    expect(relativeShort(ago(0), now)).toBe('0s');
    expect(relativeShort(ago(59), now)).toBe('59s');
  });

  it('renders minutes under an hour', () => {
    expect(relativeShort(ago(60), now)).toBe('1m');
    expect(relativeShort(ago(59 * 60 + 59), now)).toBe('59m');
  });

  it('renders hours under a day', () => {
    expect(relativeShort(ago(60 * 60), now)).toBe('1h');
    expect(relativeShort(ago(23 * 60 * 60), now)).toBe('23h');
  });

  it('renders days from 24h up', () => {
    expect(relativeShort(ago(24 * 60 * 60), now)).toBe('1d');
    expect(relativeShort(ago(72 * 60 * 60), now)).toBe('3d');
  });

  it('clamps future timestamps to 0s', () => {
    expect(relativeShort(ago(-30), now)).toBe('0s');
  });
});

describe('initialsOf', () => {
  it('uses the first letters of the first two words', () => {
    expect(initialsOf('production pipeline')).toBe('PP');
  });

  it('splits on dots, underscores, and dashes', () => {
    expect(initialsOf('my-project')).toBe('MP');
    expect(initialsOf('my_project')).toBe('MP');
    expect(initialsOf('my.project')).toBe('MP');
  });

  it('falls back to the first two characters of a single word', () => {
    expect(initialsOf('solo')).toBe('SO');
  });
});

describe('projectIconStyle', () => {
  it('uses white text on arbitrary colours', () => {
    expect(projectIconStyle('#6366f1')).toEqual({ backgroundColor: '#6366f1', color: '#ffffff' });
  });

  it('uses the dark olive ink on the moss green for contrast', () => {
    expect(projectIconStyle('#a8c945')).toEqual({
      backgroundColor: '#a8c945',
      color: '#1f2d0c',
    });
  });

  // Luminance, not one hard-coded green: amber and teal presets are as light
  // as the moss and washed out under white text.
  it('uses the ink on every light colour and white on the darker presets', () => {
    expect(projectIconStyle('#e0a63c').color).toBe('#1f2d0c');
    expect(projectIconStyle('#2fbfa5').color).toBe('#1f2d0c');
    expect(projectIconStyle('#4f9cf7').color).toBe('#ffffff');
    expect(projectIconStyle('#e5484d').color).toBe('#ffffff');
  });

  it('follows the app accent tokens when the project has no colour', () => {
    expect(projectIconStyle(null)).toEqual({
      backgroundColor: 'var(--primary)',
      color: 'var(--primary-foreground)',
    });
  });
});
