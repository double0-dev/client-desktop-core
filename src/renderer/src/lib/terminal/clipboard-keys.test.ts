import { describe, expect, it } from 'vitest';
import {
  terminalClipboardKey,
  terminalPasteOverride,
  WINDOWS_IMAGE_PASTE_KEY,
} from './clipboard-keys';

type Mods = Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }>;

const key = (k: string, mods: Mods = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
});

const win = { windows: true, linux: false, hasSelection: false };
const linux = { windows: false, linux: true, hasSelection: false };

describe('terminalClipboardKey', () => {
  it('pastes on Ctrl+V and Ctrl+Shift+V on Windows', () => {
    // xterm would otherwise send ^V and cancel the browser's paste
    expect(terminalClipboardKey(key('v', { ctrl: true }), win)).toBe('paste');
    expect(terminalClipboardKey(key('V', { ctrl: true, shift: true }), win)).toBe('paste');
  });

  it('keeps Ctrl+C the interrupt while nothing is selected', () => {
    expect(terminalClipboardKey(key('c', { ctrl: true }), win)).toBeNull();
  });

  it('copies on Ctrl+C with a selection and on Ctrl+Shift+C always', () => {
    expect(terminalClipboardKey(key('c', { ctrl: true }), { ...win, hasSelection: true })).toBe(
      'copy',
    );
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), win)).toBe('copy');
  });

  it('copies and pastes on the Shift forms on Linux', () => {
    // Ctrl+Shift+C did nothing on Linux: xterm only maps Ctrl+letter without
    // Shift, and Chromium binds no copy to it (2026-10-29).
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), linux)).toBe('copy');
    expect(terminalClipboardKey(key('V', { ctrl: true, shift: true }), linux)).toBe('paste');
  });

  it('keeps the bare Ctrl keys the shell’s on Linux', () => {
    // Ctrl+V is readline's quoted-insert; Ctrl+C over a selection stays the
    // interrupt.
    const selected = { ...linux, hasSelection: true };
    expect(terminalClipboardKey(key('v', { ctrl: true }), selected)).toBeNull();
    expect(terminalClipboardKey(key('c', { ctrl: true }), selected)).toBeNull();
  });

  it('leaves macOS and other combos to xterm', () => {
    const mac = { windows: false, linux: false, hasSelection: true };
    expect(terminalClipboardKey(key('v', { ctrl: true }), mac)).toBeNull();
    expect(terminalClipboardKey(key('c', { ctrl: true }), mac)).toBeNull();
    expect(terminalClipboardKey(key('C', { ctrl: true, shift: true }), mac)).toBeNull();
    expect(
      terminalClipboardKey(key('V', { ctrl: true, shift: true, alt: true }), linux),
    ).toBeNull();
    expect(terminalClipboardKey(key('v', { ctrl: true, alt: true }), win)).toBeNull();
    expect(terminalClipboardKey(key('v'), win)).toBeNull();
    expect(terminalClipboardKey(key('x', { ctrl: true }), win)).toBeNull();
  });
});

describe('terminalPasteOverride', () => {
  it('sends the image-paste key for an image-only clipboard on Windows', () => {
    // Claude reads the image off the clipboard itself on Alt+V; the browser
    // paste carries no text, so it used to paste nothing
    expect(terminalPasteOverride(['image/png'], { windows: true })).toBe(WINDOWS_IMAGE_PASTE_KEY);
    expect(terminalPasteOverride(['Files'], { windows: true })).toBe(WINDOWS_IMAGE_PASTE_KEY);
    expect(WINDOWS_IMAGE_PASTE_KEY).toBe('\x1bv');
  });

  it('keeps a paste with text an ordinary paste', () => {
    // a copied cell from a spreadsheet carries an image AND its text
    expect(terminalPasteOverride(['text/plain', 'image/png'], { windows: true })).toBeNull();
    expect(terminalPasteOverride(['text/plain'], { windows: true })).toBeNull();
    expect(terminalPasteOverride([], { windows: true })).toBeNull();
  });

  it('leaves macOS and Linux to xterm', () => {
    expect(terminalPasteOverride(['image/png'], { windows: false })).toBeNull();
  });
});
