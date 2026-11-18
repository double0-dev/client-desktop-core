import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseThemeHint, readThemeHint, writeThemeHint } from './theme-hint';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'theme-hint-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('theme hint', () => {
  it('is dark-first: only an explicit "light" reads as light', () => {
    expect(parseThemeHint('light\n')).toBe('light');
    expect(parseThemeHint('dark')).toBe('dark');
    expect(parseThemeHint('')).toBe('dark');
    expect(parseThemeHint('auto')).toBe('dark');
  });

  it('falls back to dark when no hint was ever written (first launch)', () => {
    expect(readThemeHint(join(scratch(), 'theme-hint'))).toBe('dark');
  });

  it('round-trips through the file the next launch reads', async () => {
    const path = join(scratch(), 'theme-hint');
    await writeThemeHint(path, 'light');
    expect(readFileSync(path, 'utf8')).toBe('light\n');
    expect(readThemeHint(path)).toBe('light');
    await writeThemeHint(path, 'dark');
    expect(readThemeHint(path)).toBe('dark');
  });

  it('swallows a failed write - a hint is never worth an error', async () => {
    await expect(
      writeThemeHint(join(scratch(), 'missing-dir', 'theme-hint'), 'light'),
    ).resolves.toBeUndefined();
  });
});
