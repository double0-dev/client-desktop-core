import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fitWindowBounds,
  parseWindowState,
  readWindowState,
  writeWindowState,
  type WindowState,
} from './window-state';

/**
 * `<userData>/window-state.json`: the app window reopens at its last size and
 * position, but never off-screen or larger than the display it lands on.
 */

const MIN = { width: 900, height: 600 };
const PRIMARY = { x: 0, y: 25, width: 1920, height: 1055 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1440 };

const STATE: WindowState = {
  bounds: { x: 100, y: 80, width: 1400, height: 900 },
  maximized: false,
  fullScreen: true,
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'double0-window-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseWindowState', () => {
  it('returns null for a missing, empty or corrupt file', () => {
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState('')).toBeNull();
    expect(parseWindowState('{"bounds": {')).toBeNull();
    expect(parseWindowState('42')).toBeNull();
  });

  it('rejects bounds that are missing, non-numeric or empty', () => {
    expect(parseWindowState(JSON.stringify({ maximized: true }))).toBeNull();
    expect(
      parseWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: '800', height: 600 } })),
    ).toBeNull();
    expect(
      parseWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 600 } })),
    ).toBeNull();
  });

  it('keeps a valid state and defaults the flags to false', () => {
    expect(parseWindowState(JSON.stringify(STATE))).toEqual(STATE);
    expect(
      parseWindowState(JSON.stringify({ bounds: { x: 1.4, y: 2.6, width: 1000, height: 700 } })),
    ).toEqual({
      bounds: { x: 1, y: 3, width: 1000, height: 700 },
      maximized: false,
      fullScreen: false,
    });
  });
});

describe('fitWindowBounds', () => {
  it('keeps bounds that sit on a display', () => {
    expect(fitWindowBounds(STATE.bounds, [PRIMARY, RIGHT], MIN)).toEqual(STATE.bounds);
    const onRight = { x: 2200, y: 100, width: 2000, height: 1200 };
    expect(fitWindowBounds(onRight, [PRIMARY, RIGHT], MIN)).toEqual(onRight);
  });

  it('drops the position when its display is gone, keeping a size that fits', () => {
    const onRight = { x: 2200, y: 100, width: 2000, height: 1200 };
    expect(fitWindowBounds(onRight, [PRIMARY], MIN)).toEqual({ width: 1920, height: 1055 });
  });

  it('clamps to the work area and pulls a window hanging off an edge back in', () => {
    expect(fitWindowBounds({ x: 1500, y: 25, width: 3000, height: 2000 }, [PRIMARY], MIN)).toEqual({
      x: 0,
      y: 25,
      width: 1920,
      height: 1055,
    });
    expect(fitWindowBounds({ x: 1700, y: 500, width: 1000, height: 800 }, [PRIMARY], MIN)).toEqual({
      x: 920,
      y: 280,
      width: 1000,
      height: 800,
    });
  });

  it('never goes below the minimum size', () => {
    expect(fitWindowBounds({ x: 10, y: 30, width: 200, height: 100 }, [PRIMARY], MIN)).toEqual({
      x: 10,
      y: 30,
      width: 900,
      height: 600,
    });
  });

  it('treats a sliver of overlap as off-screen', () => {
    expect(fitWindowBounds({ x: 1890, y: 100, width: 1200, height: 800 }, [PRIMARY], MIN)).toEqual({
      width: 1200,
      height: 800,
    });
  });
});

describe('read/writeWindowState', () => {
  it('round-trips through the file', () => {
    const path = join(dir, 'nested', 'window-state.json');
    expect(writeWindowState(path, STATE)).toBe(true);
    expect(readWindowState(path)).toEqual(STATE);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(STATE);
  });

  it('reads null for a missing or corrupt file', () => {
    expect(readWindowState(join(dir, 'missing.json'))).toBeNull();
    const path = join(dir, 'window-state.json');
    writeFileSync(path, 'not json');
    expect(readWindowState(path)).toBeNull();
  });

  it('reports a failed write instead of throwing', () => {
    // A path under a regular file can't be created.
    const file = join(dir, 'file');
    writeFileSync(file, '');
    expect(writeWindowState(join(file, 'window-state.json'), STATE)).toBe(false);
  });
});
