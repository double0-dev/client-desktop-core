import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts, type AppCommandId } from '@renderer/lib/use-app-shortcuts';
import { resetAll, setCapturing } from '@renderer/lib/settings/keyboard-shortcuts';
import { setAppLocked } from '@renderer/lib/app-lock';

// Vitest's jsdom UA has no "Mac", so the primary modifier is Ctrl here.
const press = (code: string, extra: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', {
    code,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  window.dispatchEvent(e);
  return e;
};

function Host({ run }: { run: (id: AppCommandId) => void }) {
  useAppShortcuts(run);
  return null;
}

afterEach(() => {
  setCapturing(false);
  resetAll();
  document.body.innerHTML = '';
});

describe('useAppShortcuts', () => {
  it('runs Settings, the palette and Go to file on their keys', () => {
    const run = vi.fn();
    render(<Host run={run} />);
    expect(press('Comma').defaultPrevented).toBe(true);
    press('KeyP', { shiftKey: true });
    press('KeyO', { shiftKey: true });
    expect(run.mock.calls.map(([id]) => id)).toEqual([
      'open-settings',
      'search-everywhere',
      'go-to-file',
    ]);
  });

  it('stands down while something covers the whole window', () => {
    // Settings or the palette opening under the cover would sit unreachable.
    const run = vi.fn();
    render(<Host run={run} />);
    setAppLocked(true);
    try {
      expect(press('Comma').defaultPrevented).toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      setAppLocked(false);
    }
  });

  // Ctrl+P is readline's previous-history: off macOS it must reach the shell.
  it('leaves bare Ctrl+P to the terminal off macOS', () => {
    const run = vi.fn();
    render(<Host run={run} />);
    expect(press('KeyP').defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('works from a text field - none of its keys is typing', () => {
    const run = vi.fn();
    render(<Host run={run} />);
    document.body.insertAdjacentHTML('beforeend', '<input id="field" />');
    const field = document.getElementById('field')!;
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Comma', ctrlKey: true, bubbles: true }),
    );
    expect(run).toHaveBeenCalledWith('open-settings');
  });

  it('stands down while a binding is captured or a dialog is open', () => {
    const run = vi.fn();
    render(<Host run={run} />);
    setCapturing(true);
    press('Comma');
    setCapturing(false);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-slot="dialog-content" data-state="open"></div>',
    );
    press('Comma');
    expect(run).not.toHaveBeenCalled();
  });
});
