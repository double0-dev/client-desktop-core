import { describe, expect, it } from 'vitest';

import { folderHandlerFound } from './file-manager';

describe('folderHandlerFound', () => {
  it('reads an empty xdg-mime answer as no file manager', () => {
    // What WSL and a bare window manager answer: exit 0, nothing printed.
    expect(folderHandlerFound('')).toBe(false);
    expect(folderHandlerFound('\n')).toBe(false);
  });

  it('finds the registered file manager', () => {
    expect(folderHandlerFound('org.gnome.Nautilus.desktop\n')).toBe(true);
  });

  it('never blocks the reveal on a failed query', () => {
    expect(folderHandlerFound(null)).toBe(true);
  });
});
