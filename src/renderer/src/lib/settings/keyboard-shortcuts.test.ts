import { afterEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import {
  commands,
  comboEquals,
  comboTokens,
  eventToCombo,
  findConflict,
  getDefaultCombo,
  platformDefault,
  getKeymap,
  isCommandListed,
  isValidCombo,
  matchCombo,
  resetAll,
  resetBinding,
  setBinding,
  SHORTCUTS_STORAGE_KEY,
  unbind,
  type CommandId,
  type ExtensionCommandDef,
  type ShortcutCombo,
} from '@renderer/lib/settings/keyboard-shortcuts';

// These run in Vitest's `node` environment, where `isMac` resolves false - so
// `mod` maps to the Ctrl key and modifier glyphs render as words ("Ctrl").
function ev(
  code: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
): KeyboardEvent {
  return {
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  } as unknown as KeyboardEvent;
}

afterEach(() => resetAll());

describe('eventToCombo', () => {
  it('folds the primary modifier into `mod` (Ctrl off-mac)', () => {
    expect(eventToCombo(ev('KeyN', { ctrl: true }))).toEqual({
      key: 'KeyN',
      mod: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
  });

  it('returns null for a modifier-only press', () => {
    expect(eventToCombo(ev('ControlLeft', { ctrl: true }))).toBeNull();
    expect(eventToCombo(ev('ShiftLeft', { shift: true }))).toBeNull();
  });
});

describe('matchCombo', () => {
  const combo: ShortcutCombo = { mod: true, shift: true, key: 'KeyC' };

  it('matches the exact chord', () => {
    expect(matchCombo(ev('KeyC', { ctrl: true, shift: true }), combo)).toBe(true);
  });

  it('rejects a missing modifier or a different key', () => {
    expect(matchCombo(ev('KeyC', { ctrl: true }), combo)).toBe(false);
    expect(matchCombo(ev('KeyX', { ctrl: true, shift: true }), combo)).toBe(false);
    expect(matchCombo(ev('KeyC', { ctrl: true, shift: true, alt: true }), combo)).toBe(false);
  });

  it('never matches a null binding', () => {
    expect(matchCombo(ev('KeyC', { ctrl: true }), null)).toBe(false);
  });
});

describe('comboEquals', () => {
  it('compares fields, treating absent flags as false', () => {
    expect(comboEquals({ key: 'KeyN', mod: true }, { key: 'KeyN', mod: true, shift: false })).toBe(
      true,
    );
    expect(comboEquals({ key: 'KeyN', mod: true }, { key: 'KeyN', mod: true, shift: true })).toBe(
      false,
    );
  });

  it('handles nulls', () => {
    expect(comboEquals(null, null)).toBe(true);
    expect(comboEquals({ key: 'KeyN', mod: true }, null)).toBe(false);
  });
});

describe('isValidCombo', () => {
  it('requires the primary modifier', () => {
    expect(isValidCombo({ key: 'KeyN', mod: true })).toBe(true);
    expect(isValidCombo({ key: 'KeyN' })).toBe(false);
    expect(isValidCombo({ key: 'KeyN', shift: true })).toBe(false);
  });
});

describe('comboTokens', () => {
  it('renders modifiers (off-mac words) then the key glyph', () => {
    expect(comboTokens({ mod: true, shift: true, key: 'KeyC' })).toEqual(['Ctrl', 'Shift', 'C']);
    expect(comboTokens({ mod: true, key: 'Digit1' })).toEqual(['Ctrl', '1']);
    expect(comboTokens({ mod: true, shift: true, key: 'ArrowDown' })).toEqual([
      'Ctrl',
      'Shift',
      '↓',
    ]);
    expect(comboTokens({ mod: true, key: 'Backslash' })).toEqual(['Ctrl', '\\']);
  });

  it('returns no tokens for an unbound command', () => {
    expect(comboTokens(null)).toEqual([]);
  });
});

describe('findConflict', () => {
  it('finds the command already bound to a combo, honouring exceptId', () => {
    const keymap = getKeymap();
    const closeCombo = keymap['close-tab']!;
    expect(findConflict(keymap, closeCombo)).toBe('close-tab');
    expect(findConflict(keymap, closeCombo, 'close-tab')).toBeNull();
    expect(findConflict(keymap, { mod: true, alt: true, shift: true, key: 'F12' })).toBeNull();
  });
});

describe('platform defaults', () => {
  const linux = { mac: false, linux: true };
  const windows = { mac: false, linux: false };
  const mac = { mac: true, linux: false };
  const def = (id: CommandId) => commands().find((c) => c.id === id)!;

  it('moves tabs off the keys GNOME takes for its workspaces on Linux', () => {
    // GNOME switches workspace on Ctrl+Alt+Arrow and moves the window on
    // Ctrl+Shift+Alt+Arrow (its default keybindings, 2026-10-29).
    expect(platformDefault(def('move-tab-vertical'), linux)).toEqual({
      mod: true,
      shift: true,
      key: 'BracketRight',
    });
    expect(platformDefault(def('move-tab-horizontal'), linux)).toEqual({
      mod: true,
      shift: true,
      key: 'PageDown',
    });
    expect(platformDefault(def('move-tab-vertical'), windows)).toEqual({
      mod: true,
      alt: true,
      key: 'ArrowRight',
    });
    expect(platformDefault(def('move-tab-vertical'), mac)).toEqual({
      mod: true,
      ctrl: true,
      key: 'ArrowRight',
    });
  });

  it('gives no two commands the same Linux default, and none a GNOME workspace key', () => {
    const bound = commands().flatMap((c) => {
      const combo = platformDefault(c, linux);
      return combo ? [{ id: c.id, combo }] : [];
    });
    for (let i = 0; i < bound.length; i++) {
      for (let j = i + 1; j < bound.length; j++) {
        expect(comboEquals(bound[i].combo, bound[j].combo), `${bound[i].id} / ${bound[j].id}`).toBe(
          false,
        );
      }
    }
    const gnome = bound.filter(
      ({ combo }) => combo.mod && combo.alt && combo.key.startsWith('Arrow'),
    );
    expect(gnome).toEqual([]);
  });
  // The node test env resolves `isMac` false, so the Windows/Linux `winCombo`
  // overrides apply where present.
  it('uses winCombo off-mac, base combo otherwise', () => {
    expect(getDefaultCombo('close-tab')).toEqual({ mod: true, shift: true, key: 'KeyW' });
    expect(getDefaultCombo('new-tab')).toEqual({ mod: true, shift: true, key: 'KeyT' });
    // ⌘Y on mac, but bare Ctrl+Y is readline yank, so off-mac uses Ctrl+Shift+Y.
    expect(getDefaultCombo('new-tab-vertical')).toEqual({ mod: true, shift: true, key: 'KeyY' });
    // No winCombo → the base combo (its `mod` maps to Ctrl off-mac).
    expect(getDefaultCombo('toggle-projects')).toEqual({ mod: true, key: 'Digit1' });
  });

  // The rail's tools each own one ⌘-digit, numbered in the rail's reading
  // order - the numbering users learn, so a silent shuffle (or a tool left
  // without one) is a regression. An extension's tools take the digits between.
  it("binds core's rail tools to their own ⌘-digits", () => {
    const railDigits: [CommandId, string][] = [
      ['toggle-projects', 'Digit1'],
      ['toggle-sessions', 'Digit2'],
      ['toggle-files', 'Digit4'],
      ['toggle-tabs', 'Digit7'],
    ];
    for (const [id, key] of railDigits) {
      expect(getDefaultCombo(id)).toEqual({ mod: true, key });
    }
    // …and they sit together, in that order, in the Settings list.
    const toggles = commands()
      .map((c) => c.id)
      .filter((id) => id.startsWith('toggle-'));
    expect(toggles).toEqual(railDigits.map(([id]) => id));
  });

  // The keys every editor shares. Off macOS each must dodge the shell: Ctrl+P
  // (previous history), Ctrl+K (kill-line) and Ctrl+T (New tab here) are taken.
  it('gives the common editor keys their usual combos on each platform', () => {
    const expected: [CommandId, ShortcutCombo, ShortcutCombo][] = [
      ['open-settings', { mod: true, key: 'Comma' }, { mod: true, key: 'Comma' }],
      [
        'search-everywhere',
        { mod: true, shift: true, key: 'KeyP' },
        { mod: true, shift: true, key: 'KeyP' },
      ],
      ['go-to-file', { mod: true, key: 'KeyP' }, { mod: true, shift: true, key: 'KeyO' }],
      [
        'reopen-closed-tab',
        { mod: true, shift: true, key: 'KeyT' },
        { mod: true, shift: true, alt: true, key: 'KeyT' },
      ],
      ['next-tab', { mod: true, shift: true, key: 'BracketRight' }, { mod: true, key: 'Tab' }],
      [
        'previous-tab',
        { mod: true, shift: true, key: 'BracketLeft' },
        { mod: true, shift: true, key: 'Tab' },
      ],
      ['terminal-clear', { mod: true, key: 'KeyK' }, { mod: true, shift: true, key: 'KeyK' }],
    ];
    for (const [id, onMac, elsewhere] of expected) {
      expect(platformDefault(def(id), mac), id).toEqual(onMac);
      expect(platformDefault(def(id), windows), id).toEqual(elsewhere);
      expect(platformDefault(def(id), linux), id).toEqual(elsewhere);
    }
  });

  // These fire while a terminal has focus, so a bare Ctrl+letter would take a
  // readline key (Ctrl+P, Ctrl+K, Ctrl+W…) from every shell. Editor-group
  // commands fire only inside Monaco and may use them.
  it('never binds a terminal-reachable command to a bare Ctrl+letter off macOS', () => {
    for (const platform of [windows, linux]) {
      const bare = commands()
        .filter((c) => c.group !== 'editor')
        .filter((c) => {
          const combo = platformDefault(c, platform);
          return !!combo && combo.key.startsWith('Key') && !combo.shift && !combo.alt;
        });
      expect(bare.map((c) => c.id)).toEqual([]);
    }
  });

  it('gives no two commands the same macOS default', () => {
    const bound = commands().flatMap((c) => {
      const combo = platformDefault(c, mac);
      return combo ? [{ id: c.id, combo }] : [];
    });
    for (let i = 0; i < bound.length; i++) {
      for (let j = i + 1; j < bound.length; j++) {
        expect(comboEquals(bound[i].combo, bound[j].combo), `${bound[i].id} / ${bound[j].id}`).toBe(
          false,
        );
      }
    }
  });

  it('leaves New project unbound by default', () => {
    expect(getDefaultCombo('new-project')).toBeNull();
  });

  it('every command resolves to a unique default (no collisions)', () => {
    const seen = new Map<string, string>();
    for (const c of commands()) {
      const combo = getDefaultCombo(c.id);
      if (!combo) continue; // unbound by default (New project) - never collides
      const key = comboTokens(combo).join('+');
      expect(seen.has(key)).toBe(false);
      seen.set(key, c.id);
    }
  });
});

describe('keymap store', () => {
  it('returns the resolved default binding for every command', () => {
    const keymap = getKeymap();
    for (const c of commands()) expect(keymap[c.id]).toEqual(getDefaultCombo(c.id));
  });

  it('setBinding overrides, resetBinding restores, unbind clears', () => {
    const custom: ShortcutCombo = { mod: true, alt: true, key: 'KeyJ' };
    setBinding('new-tab', custom);
    expect(getKeymap()['new-tab']).toEqual(custom);

    unbind('new-tab');
    expect(getKeymap()['new-tab']).toBeNull();

    resetBinding('new-tab');
    expect(getKeymap()['new-tab']).toEqual(getDefaultCombo('new-tab'));
  });
});

// Two stand-in extension commands: a tool toggle placed after Files, and a
// key whose feature this build may lack.
const gadgetCommands = (shown: () => boolean): ExtensionCommandDef[] => [
  {
    id: 'toggle-gadget',
    label: 'Toggle gadget',
    after: 'toggle-files',
    defaultCombo: { mod: true, key: 'Digit5' },
  },
  {
    id: 'gadget-poke',
    label: 'Poke the gadget',
    after: 'toggle-gadget',
    listed: shown,
    defaultCombo: null,
  },
];

describe("an extension's commands", () => {
  afterEach(() => {
    resetRendererExtensionForTest();
    window.localStorage.clear();
    resetAll();
  });

  const install = (shown: () => boolean = () => true): void =>
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      commands: { list: gadgetCommands(shown), useRun: () => () => {} },
    });

  it('sit after the command they name, in the order given', () => {
    install();
    const ids = commands().map((c) => c.id);
    const files = ids.indexOf('toggle-files');
    expect(ids.slice(files, files + 4)).toEqual([
      'toggle-files',
      'toggle-gadget',
      'gadget-poke',
      'toggle-tabs',
    ]);
    expect(getDefaultCombo('toggle-gadget')).toEqual({ mod: true, key: 'Digit5' });
    expect(getKeymap()['toggle-gadget']).toEqual({ mod: true, key: 'Digit5' });
  });

  it('are absent where no extension registered them', () => {
    expect(commands().some((c) => c.id === 'toggle-gadget')).toBe(false);
    expect(getDefaultCombo('toggle-gadget')).toBeNull();
  });

  // The keymap is read on first use, and again when the command list changes,
  // never only at import: the extension is installed after every module
  // loaded, and storage read before that drops every rebinding of an
  // extension's command as an unknown id.
  it("apply a stored rebinding of an extension's command once it is registered", () => {
    const custom: ShortcutCombo = { mod: true, alt: true, key: 'KeyG' };
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ 'toggle-gadget': custom, 'new-tab': null }),
    );
    install();
    expect(getKeymap()['toggle-gadget']).toEqual({
      key: 'KeyG',
      mod: true,
      ctrl: false,
      shift: false,
      alt: true,
    });
    expect(getKeymap()['new-tab']).toBeNull();
  });

  it('are listed only while what they drive is there', () => {
    let shown = false;
    install(() => shown);
    const poke = commands().find((c) => c.id === 'gadget-poke')!;
    expect(isCommandListed(poke)).toBe(false);
    shown = true;
    expect(isCommandListed(poke)).toBe(true);
    // No `listed`: always.
    expect(isCommandListed(commands().find((c) => c.id === 'toggle-gadget')!)).toBe(true);
  });

  it('never hide a core command', () => {
    for (const c of commands()) expect(isCommandListed(c), c.id).toBe(true);
  });
});
