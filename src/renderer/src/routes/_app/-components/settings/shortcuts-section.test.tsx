import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShortcutsSettingsSection } from './shortcuts-section';
import { setAppLocked } from '@renderer/lib/app-lock';
import { getKeymap, resetAll } from '@renderer/lib/settings/keyboard-shortcuts';

afterEach(() => {
  cleanup();
  setAppLocked(false);
  resetAll();
});

describe('ShortcutsSettingsSection capture', () => {
  it('stands down while something covers the whole window', () => {
    // A capture armed when the cover arrived swallowed every key meant for it
    // and could rebind a command unseen.
    render(<ShortcutsSettingsSection />);
    // The first command row (a div with role=button) starts a capture.
    const row = screen.getAllByRole('button').find((b) => b.tagName === 'DIV')!;
    fireEvent.click(row);
    const before = JSON.stringify(getKeymap());
    setAppLocked(true);
    const press = new KeyboardEvent('keydown', {
      code: 'KeyJ',
      key: 'j',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(JSON.stringify(getKeymap())).toBe(before);
    setAppLocked(false);
    const after = new KeyboardEvent('keydown', {
      code: 'KeyJ',
      key: 'j',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
    expect(JSON.stringify(getKeymap())).not.toBe(before);
  });
});
