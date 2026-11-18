import { describe, expect, it } from 'vitest';
import { terminalLineEditSequence } from './line-edit-keys';

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('terminalLineEditSequence', () => {
  const mac = { mac: true };

  it('sends Ctrl+U for ⌘⌫ so the line is deleted back to its start', () => {
    expect(terminalLineEditSequence(key('Backspace', { metaKey: true }), mac)).toBe('\x15');
  });

  it('sends Ctrl+A / Ctrl+E for ⌘← / ⌘→ (line start / end)', () => {
    expect(terminalLineEditSequence(key('ArrowLeft', { metaKey: true }), mac)).toBe('\x01');
    expect(terminalLineEditSequence(key('ArrowRight', { metaKey: true }), mac)).toBe('\x05');
  });

  it('leaves a plain Backspace and arrow to xterm', () => {
    expect(terminalLineEditSequence(key('Backspace'), mac)).toBeNull();
    expect(terminalLineEditSequence(key('ArrowLeft'), mac)).toBeNull();
  });

  // ⇧⌘Arrow is the workspace focus walk and ⌃⌘Arrow / ⌥⌘Arrow are app keys:
  // claiming them here would type control bytes into the shell instead.
  it('never claims ⌘ combined with another modifier', () => {
    expect(
      terminalLineEditSequence(key('ArrowLeft', { metaKey: true, shiftKey: true }), mac),
    ).toBeNull();
    expect(
      terminalLineEditSequence(key('ArrowRight', { metaKey: true, ctrlKey: true }), mac),
    ).toBeNull();
    expect(
      terminalLineEditSequence(key('ArrowRight', { metaKey: true, altKey: true }), mac),
    ).toBeNull();
    expect(
      terminalLineEditSequence(key('Backspace', { metaKey: true, altKey: true }), mac),
    ).toBeNull();
  });

  it('ignores other ⌘ keys (copy, paste, find stay the app’s)', () => {
    expect(terminalLineEditSequence(key('c', { metaKey: true }), mac)).toBeNull();
    expect(terminalLineEditSequence(key('ArrowUp', { metaKey: true }), mac)).toBeNull();
  });

  it('does nothing off macOS', () => {
    expect(
      terminalLineEditSequence(key('Backspace', { metaKey: true }), { mac: false }),
    ).toBeNull();
  });
});
