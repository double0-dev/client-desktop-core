import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { viewMenu } from './app-menu';

/** The keys the menu would take from the page: every item that registers one. */
function claimed(items: MenuItemConstructorOptions[]): string[] {
  return items
    .filter((i) => i.role && i.registerAccelerator !== false)
    .map((i) => `${i.role}${i.accelerator ? `=${i.accelerator}` : ''}`);
}

describe('viewMenu', () => {
  it('claims no shell key in a packaged build', () => {
    // A packaged reload on Ctrl+R reloaded the app instead of reverse-searching
    // the shell; the toolkit's workaround took Ctrl+R from the terminal too.
    expect(claimed(viewMenu({ mac: false, dev: false }))).toEqual(['togglefullscreen']);
  });

  it('keeps the macOS zoom keys that always worked', () => {
    // The toolkit swallowed only ⌘- and ⇧⌘=; ⌘0 and ⌘= reached the menu and
    // must keep doing so (review, 2026-10-29).
    expect(claimed(viewMenu({ mac: true, dev: false }))).toEqual([
      'resetZoom',
      'zoomIn',
      'togglefullscreen',
    ]);
  });

  it('keeps reload off Ctrl+R in dev on Windows and Linux', () => {
    expect(claimed(viewMenu({ mac: false, dev: true }))).toEqual([
      'reload=Ctrl+Shift+R',
      'toggleDevTools',
      'togglefullscreen',
    ]);
  });

  it('keeps the macOS reload key in dev', () => {
    // ⌘R is not a shell key, so the default stays.
    expect(claimed(viewMenu({ mac: true, dev: true }))).toEqual([
      'reload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'togglefullscreen',
    ]);
  });

  it('still lists the zoom items off macOS, without their keys', () => {
    const zoom = viewMenu({ mac: false, dev: false }).filter((i) =>
      ['resetZoom', 'zoomIn', 'zoomOut'].includes(i.role ?? ''),
    );
    expect(zoom).toHaveLength(3);
    expect(zoom.every((i) => i.registerAccelerator === false)).toBe(true);
  });
});
