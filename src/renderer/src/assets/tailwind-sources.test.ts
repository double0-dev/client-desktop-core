import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailwind generates a class only if it finds it in a file it scans, and it
 * detects sources from the renderer root on its own. Components that live
 * anywhere else must be named with `@source` in globals.css - Pro's screens
 * (the official build, a private plan) went unstyled for days
 * without it: icons at full size, rows wrapped, pills inflated. Nothing
 * failed - an unknown class is just no class.
 */

const CSS = join(__dirname, 'globals.css');
const REPO = resolve(dirname(CSS), '../../../..');

/** The folders outside the renderer root that hold renderer components. */
const COMPONENT_ROOTS = ['the official build'];

function sources(): string[] {
  const text = readFileSync(CSS, 'utf8');
  return [...text.matchAll(/@source\s+['"]([^'"]+)['"]/g)].map((m) =>
    relative(REPO, resolve(dirname(CSS), m[1]))
      .split('\\')
      .join('/'),
  );
}

describe('Tailwind sources', () => {
  it('scan every folder of renderer components outside the renderer root', () => {
    const scanned = sources();
    for (const root of COMPONENT_ROOTS) {
      // The public tree has no pro/: nothing there to scan.
      if (!existsSync(join(REPO, root))) continue;
      expect(
        scanned.some((s) => root === s || root.startsWith(`${s}/`)),
        `globals.css has no @source for ${root}`,
      ).toBe(true);
    }
  });
});
