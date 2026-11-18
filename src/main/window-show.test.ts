import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { showWhenFirstReady } from './window-show';

function fakeWindow() {
  return Object.assign(new EventEmitter(), { show: vi.fn<() => void>() });
}

describe('showWhenFirstReady', () => {
  it('shows the window at its first ready-to-show', () => {
    const win = fakeWindow();
    const after = vi.fn<() => void>();
    showWhenFirstReady(win, after);
    expect(win.show).not.toHaveBeenCalled();
    win.emit('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  // Electron repeats a webview guest's ready-to-show on the window owning
  // it, at every page the guest loads. `show()` activates the app on macOS:
  // shown again there, the app came in front of the one the user worked in
  // whenever a page loaded in a webview.
  it('never shows it again at a later ready-to-show', () => {
    const win = fakeWindow();
    const after = vi.fn<() => void>();
    showWhenFirstReady(win, after);
    win.emit('ready-to-show');
    win.emit('ready-to-show');
    win.emit('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(win.listenerCount('ready-to-show')).toBe(0);
  });

  it('is the only ready-to-show listener main registers', () => {
    const offenders: string[] = [];
    for (const file of ['index.ts', 'project-windows.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      if (/['"]ready-to-show['"]/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
