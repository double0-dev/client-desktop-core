import { rendererExtension } from '@renderer/lib/extension/registry';
import type { RailTabId } from '@renderer/lib/workspace/dock-state';
import type { Tab } from '@renderer/lib/workspace/layout';
import { useSyncExternalStore } from 'react';
import { SETTINGS_APPLIED_EVENT } from '@renderer/lib/settings/settings-events';

/**
 * Workspace keyboard shortcuts (design: `Screen/Settings - Keyboard Shortcuts`).
 *
 * A flat registry of commands, each with a default key combo, plus a
 * module-level store of the user's rebindings - persisted to localStorage and
 * read live by the global key handler (`workspace-shortcuts.tsx`) and the
 * Settings list. Mirrors `lib/terminal-settings.ts`: own writes fan out to
 * subscribers, and a `storage` / `SETTINGS_APPLIED_EVENT` listener re-reads
 * external writes (import, the JSON editor, another window) so rebindings apply
 * without a restart.
 */

// The primary modifier is ⌘ on macOS, Ctrl elsewhere; glyphs follow suit.
export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
export const isWindows =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
export const isLinux = typeof navigator !== 'undefined' && !isMac && !isWindows;

/** Core's own commands. */
export type CoreCommandId =
  | 'open-settings'
  | 'search-everywhere'
  | 'go-to-file'
  | 'new-session'
  | 'new-project'
  | 'new-tab'
  | 'new-tab-vertical'
  | 'new-tab-horizontal'
  | 'move-tab-vertical'
  | 'move-tab-horizontal'
  | 'focus-pane-left'
  | 'focus-pane-right'
  | 'focus-pane-up'
  | 'focus-pane-down'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'toggle-projects'
  | 'toggle-sessions'
  | 'toggle-files'
  | 'toggle-tabs'
  | 'editor-save'
  | 'editor-format'
  | 'editor-go-to-definition'
  | 'editor-find-references'
  | 'editor-rename'
  | 'editor-quick-fix'
  | 'editor-toggle-comment'
  | 'editor-go-to-line'
  | 'editor-move-line-up'
  | 'editor-move-line-down'
  | 'editor-duplicate-line'
  | 'terminal-find'
  | 'terminal-clear';

/**
 * A command id: core's, or one the extension registered (`commands`). Ids are
 * stored (a rebinding names its command), so a registered id never changes.
 */
export type CommandId = CoreCommandId | (string & {});

/**
 * A key combo. `key` is a `KeyboardEvent.code` (layout-independent, e.g.
 * `KeyN`, `Digit1`, `Backslash`, `ArrowDown`, `Enter`). `mod` is the primary
 * modifier (⌘ on macOS, Ctrl elsewhere); `ctrl` is the literal Control key,
 * only distinct from `mod` on macOS - elsewhere a Control press folds into `mod`.
 */
export type ShortcutCombo = {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type CommandDef = {
  id: CommandId;
  label: string;
  /**
   * Editor-group commands run inside a focused Monaco editor (handled by the
   * editor's own key listener, see components/ui/monaco-editor.tsx) - the
   * global workspace handler skips them. Terminal-group commands run inside a
   * focused terminal (its custom key handler in lib/terminal/pool.ts - so
   * they reach detached windows too); the global handler skips them as well,
   * though the palette can still run them on the active tab. App-group
   * commands work with no session open (the no-project workspace) and are
   * handled by the app-level palette host (search-everywhere.tsx); the
   * Settings list shows them with the workspace commands. Absent =
   * workspace command.
   */
  group?: 'editor' | 'terminal' | 'app';
  /** macOS default (⌘ = `mod`); null = unbound by default (e.g. pull/push). */
  defaultCombo: ShortcutCombo | null;
  /**
   * Windows/Linux default, where it must differ. On those platforms `mod` is
   * Ctrl, and several mac ⌘-combos land on keys the shell owns: bare Ctrl+W/T/N
   * (readline), Ctrl+Y (yank), Ctrl+G (abort). Since the handler fires even with
   * the terminal focused, those move to free combos here. Absent = reuse
   * `defaultCombo` (its `mod` already maps to Ctrl).
   */
  winCombo?: ShortcutCombo;
  /**
   * Linux default where even winCombo collides: GNOME takes Ctrl+Alt+Arrow
   * and Ctrl+Shift+Alt+Arrow for its workspaces (read off its default
   * keybindings, 2026-10-29). Absent = winCombo, then defaultCombo.
   */
  linuxCombo?: ShortcutCombo;
};

// Order here is the order shown in the Settings list. Labels mirror the user's
// vocabulary; per the chosen convention, "vertically" splits side-by-side (a new
// pane to the right) and "horizontally" stacks (a new pane below).
export const CORE_COMMANDS: readonly CommandDef[] = [
  // App-wide (group 'app'): the keys every editor shares. ⌘, is free in every
  // shell off macOS too. ⌘P / ⇧⌘P: bare Ctrl+P is readline's previous-history,
  // so off macOS both take Shift - and Ctrl+Shift+P is the palette, so Go to
  // file moves to Ctrl+Shift+O.
  {
    id: 'open-settings',
    label: 'Open settings',
    group: 'app',
    defaultCombo: { mod: true, key: 'Comma' },
  },
  {
    id: 'search-everywhere',
    label: 'Search everywhere',
    group: 'app',
    defaultCombo: { mod: true, shift: true, key: 'KeyP' },
  },
  {
    id: 'go-to-file',
    label: 'Go to file…',
    group: 'app',
    defaultCombo: { mod: true, key: 'KeyP' },
    winCombo: { mod: true, shift: true, key: 'KeyO' },
  },
  {
    id: 'new-session',
    label: 'New session',
    defaultCombo: { mod: true, key: 'KeyN' },
    winCombo: { mod: true, shift: true, key: 'KeyN' },
  },
  {
    // The workspace's way in besides the Projects panel's "+" (which may be
    // closed). Unbound by default: every free combo is some shell's key.
    id: 'new-project',
    label: 'New project',
    defaultCombo: null,
  },
  {
    id: 'new-tab',
    label: 'New tab',
    defaultCombo: { mod: true, key: 'KeyT' },
    winCombo: { mod: true, shift: true, key: 'KeyT' },
  },
  {
    id: 'new-tab-vertical',
    label: 'New tab vertically',
    // ⌘Y on macOS (⌘V/⌘H - the V/H mnemonics - are reserved by Paste/Hide). Bare
    // Ctrl+Y is readline's yank, so Win/Linux take Ctrl+Shift+Y (the ⌘X→Ctrl+Shift+X
    // pattern used above) - same Y mnemonic, without stealing yank from the shell.
    defaultCombo: { mod: true, key: 'KeyY' },
    winCombo: { mod: true, shift: true, key: 'KeyY' },
  },
  {
    id: 'new-tab-horizontal',
    label: 'New tab horizontally',
    // ⌘G on macOS; bare Ctrl+G is readline's abort, so Win/Linux take Ctrl+Shift+G
    // - same G mnemonic, without stealing abort from the shell.
    defaultCombo: { mod: true, key: 'KeyG' },
    winCombo: { mod: true, shift: true, key: 'KeyG' },
  },
  {
    id: 'move-tab-vertical',
    label: 'Move tab vertically',
    // A side-by-side split lives to the right, so → moves the tab there. ⌃⌘→ on
    // macOS: ⇧⌘→ now switches pane focus (the focus-pane commands below). ⌃⌘ has
    // no Win/Linux equivalent (there `mod` IS Ctrl), so those take Ctrl+Alt+→,
    // leaving Ctrl+Shift+→ free for focus-switching.
    defaultCombo: { mod: true, ctrl: true, key: 'ArrowRight' },
    winCombo: { mod: true, alt: true, key: 'ArrowRight' },
    // GNOME switches workspace on Ctrl+Alt+→; ] points right.
    linuxCombo: { mod: true, shift: true, key: 'BracketRight' },
  },
  {
    id: 'move-tab-horizontal',
    label: 'Move tab horizontally',
    // A stacked split sits below, so ↓ moves the tab there. ⌃⌘↓ on macOS,
    // Ctrl+Alt+↓ on Win/Linux - mirrors move-tab-vertical above.
    defaultCombo: { mod: true, ctrl: true, key: 'ArrowDown' },
    winCombo: { mod: true, alt: true, key: 'ArrowDown' },
    // GNOME switches workspace on Ctrl+Alt+↓; Page Down for the pane below.
    linuxCombo: { mod: true, shift: true, key: 'PageDown' },
  },
  // Move keyboard focus in the arrow's direction: to the split pane on that side,
  // or - when the workspace isn't split (or nothing lies that way) - to the
  // previous/next tab in the active pane's strip (left/right only; the strip is
  // horizontal), and past the edge of the surface into the sidebar regions:
  // the file explorer and the dock's panels (projects / sessions / tabs, which
  // ↑/↓ walk top→bottom) - see lib/workspace/focus-regions.ts. Inside a panel,
  // plain ↑/↓ then pick the previous/next session, project or file. ⇧⌘Arrow on
  // macOS, Ctrl+Shift+Arrow on Win/Linux (`mod` = Ctrl there) - both
  // shell-safe, and the handler lets them through even while a terminal is
  // focused. The ids keep their original `focus-pane-*` names so existing
  // rebindings stay valid.
  {
    id: 'focus-pane-left',
    label: 'Focus left (pane, tab, sidebar)',
    defaultCombo: { mod: true, shift: true, key: 'ArrowLeft' },
  },
  {
    id: 'focus-pane-right',
    label: 'Focus right (pane, tab, sidebar)',
    defaultCombo: { mod: true, shift: true, key: 'ArrowRight' },
  },
  {
    id: 'focus-pane-up',
    label: 'Focus up (pane, sidebar panel)',
    defaultCombo: { mod: true, shift: true, key: 'ArrowUp' },
  },
  {
    id: 'focus-pane-down',
    label: 'Focus down (pane, sidebar panel)',
    defaultCombo: { mod: true, shift: true, key: 'ArrowDown' },
  },
  {
    id: 'close-tab',
    label: 'Close tab',
    defaultCombo: { mod: true, key: 'KeyW' },
    winCombo: { mod: true, shift: true, key: 'KeyW' },
  },
  {
    // Editor and browser tabs come back (file / page); a closed shell is gone
    // with its process, so terminal tabs are not remembered. Ctrl+Shift+T is
    // New tab off macOS, so the reopen key adds Alt there.
    id: 'reopen-closed-tab',
    label: 'Reopen closed tab',
    defaultCombo: { mod: true, shift: true, key: 'KeyT' },
    winCombo: { mod: true, shift: true, alt: true, key: 'KeyT' },
  },
  // Cycle the active pane's tabs, wrapping at either end. ⇧⌘] / ⇧⌘[ on macOS;
  // elsewhere Ctrl+Tab / Ctrl+Shift+Tab (no shell reads them, and Linux's
  // move-tab-vertical already holds Ctrl+Shift+]).
  {
    id: 'next-tab',
    label: 'Next tab',
    defaultCombo: { mod: true, shift: true, key: 'BracketRight' },
    winCombo: { mod: true, key: 'Tab' },
  },
  {
    id: 'previous-tab',
    label: 'Previous tab',
    defaultCombo: { mod: true, shift: true, key: 'BracketLeft' },
    winCombo: { mod: true, shift: true, key: 'Tab' },
  },
  // One ⌘-digit per rail tool, numbered in the rail's own reading order; an
  // extension's tools take the digits between (its `commands` place them).
  // Tabs shows only with the vertical-tabs setting: while it is hidden the
  // shortcut is inert, so ⌘7 never opens a panel with no rail tab to close it
  // (the host's `toggleDock` holds that gate).
  // Digit combos carry no shell clash, so Win/Linux reuse them (Ctrl+1…9) with
  // no winCombo override.
  { id: 'toggle-projects', label: 'Open projects', defaultCombo: { mod: true, key: 'Digit1' } },
  { id: 'toggle-sessions', label: 'Toggle sessions', defaultCombo: { mod: true, key: 'Digit2' } },
  { id: 'toggle-files', label: 'Toggle file explorer', defaultCombo: { mod: true, key: 'Digit4' } },
  { id: 'toggle-tabs', label: 'Toggle tabs panel', defaultCombo: { mod: true, key: 'Digit7' } },
  // Editor group: fire only inside a focused file editor (the editor's own
  // capture-phase listener consults these; the global handler skips them).
  {
    id: 'editor-save',
    label: 'Save file',
    group: 'editor',
    defaultCombo: { mod: true, key: 'KeyS' },
  },
  {
    id: 'editor-format',
    label: 'Format document',
    group: 'editor',
    // VS Code's ⇧⌥F. No primary modifier, which is fine editor-locally - the
    // combo never fires while a terminal or the workspace has focus.
    defaultCombo: { shift: true, alt: true, key: 'KeyF' },
  },
  // The remaining editor commands trigger Monaco actions (see the action map
  // in components/ui/monaco-editor.tsx). Defaults mirror VS Code; rebinding
  // adds the new combo - Monaco's own default keybinding stays live too.
  {
    id: 'editor-go-to-definition',
    label: 'Go to definition',
    group: 'editor',
    defaultCombo: { key: 'F12' },
  },
  {
    id: 'editor-find-references',
    label: 'Find references',
    group: 'editor',
    defaultCombo: { shift: true, key: 'F12' },
  },
  { id: 'editor-rename', label: 'Rename symbol', group: 'editor', defaultCombo: { key: 'F2' } },
  {
    id: 'editor-quick-fix',
    label: 'Quick fix',
    group: 'editor',
    defaultCombo: { mod: true, key: 'Period' },
  },
  {
    id: 'editor-toggle-comment',
    label: 'Toggle line comment',
    group: 'editor',
    defaultCombo: { mod: true, key: 'Slash' },
  },
  {
    id: 'editor-go-to-line',
    label: 'Go to line…',
    group: 'editor',
    // ⌃G on macOS (VS Code); Ctrl+G elsewhere (`ctrl` never matches off-mac).
    defaultCombo: { ctrl: true, key: 'KeyG' },
    winCombo: { mod: true, key: 'KeyG' },
  },
  {
    id: 'editor-move-line-up',
    label: 'Move line up',
    group: 'editor',
    defaultCombo: { alt: true, key: 'ArrowUp' },
  },
  {
    id: 'editor-move-line-down',
    label: 'Move line down',
    group: 'editor',
    defaultCombo: { alt: true, key: 'ArrowDown' },
  },
  {
    id: 'editor-duplicate-line',
    label: 'Duplicate line',
    group: 'editor',
    defaultCombo: { shift: true, alt: true, key: 'ArrowDown' },
  },
  // Terminal group: fire only inside a focused terminal (see `group`).
  {
    id: 'terminal-find',
    label: 'Find in terminal',
    group: 'terminal',
    defaultCombo: { mod: true, key: 'KeyF' },
    // Ctrl+F is readline's forward-char and less / vim's page forward - the
    // terminal swallows the find key, so off macOS it takes Ctrl+Shift+F.
    winCombo: { mod: true, shift: true, key: 'KeyF' },
  },
  {
    // Scrollback and screen of a plain shell, kept to the prompt row - the
    // usual terminal ⌘K. Ctrl+K is readline's kill-line, so off macOS it takes
    // Ctrl+Shift+K. A full-screen program (an agent's UI) is left alone: it
    // owns its screen and would only repaint over it.
    id: 'terminal-clear',
    label: 'Clear terminal',
    group: 'terminal',
    defaultCombo: { mod: true, key: 'KeyK' },
    winCombo: { mod: true, shift: true, key: 'KeyK' },
  },
];

export type Keymap = Record<string, ShortcutCombo | null>;

/** The platform-appropriate default for a command (Linux, then Win/Linux
 * override, or mac); null for commands left unbound by default (pull/push). */
export function platformDefault(
  c: CommandDef,
  platform: { mac: boolean; linux: boolean } = { mac: isMac, linux: isLinux },
): ShortcutCombo | null {
  if (platform.mac) return c.defaultCombo;
  return (platform.linux ? c.linuxCombo : undefined) ?? c.winCombo ?? c.defaultCombo;
}

/** A command the extension adds, placed in the Settings list after `after`. */
export type ExtensionCommandDef = CommandDef & {
  /** The command it follows in the Settings list (core's or an earlier one of its own). */
  after: CommandId;
  /** Whether this build shows it - the feature it drives is there. Absent = always. */
  listed?: () => boolean;
};

/** What the active session's key handler hands an extension's command. */
export type CommandRunContext = {
  /** The active pane's tab. */
  activeTab: Tab | undefined;
  /** The overlay tool that is up, if any. */
  openOverlay: string | null;
  /** Toggle a rail tool (inert while the tool is hidden). */
  toggleTool(id: RailTabId): void;
  /** Toggle the bottom panel. */
  toggleBottomPanel(): void;
  /** Open a page tab, where this build has them. */
  openPage?: (url: string) => void;
};

/** The extension's commands (`RendererExtension.commands`). */
export type ExtensionCommands = {
  list: readonly ExtensionCommandDef[];
  /**
   * A hook, called on every render of the active session's key handler: the
   * runner for its commands (a key, or the palette).
   */
  useRun(): (id: CommandId, ctx: CommandRunContext) => void;
};

type Catalog = {
  source: readonly ExtensionCommandDef[] | undefined;
  list: readonly CommandDef[];
  ids: ReadonlySet<string>;
  defaults: ReadonlyMap<string, ShortcutCombo | null>;
};
let catalogCache: Catalog | null = null;

/** Core's commands with the extension's placed among them. */
function placeCommands(extra: readonly ExtensionCommandDef[]): CommandDef[] {
  const list: CommandDef[] = [...CORE_COMMANDS];
  for (const c of extra) {
    const at = list.findIndex((d) => d.id === c.after);
    list.splice(at < 0 ? list.length : at + 1, 0, c);
  }
  return list;
}

function catalog(): Catalog {
  const source = rendererExtension().commands?.list;
  if (catalogCache && catalogCache.source === source) return catalogCache;
  const list = placeCommands(source ?? []);
  catalogCache = {
    source,
    list,
    ids: new Set(list.map((c) => c.id)),
    defaults: new Map(list.map((c) => [c.id, platformDefault(c)])),
  };
  return catalogCache;
}

/**
 * Every command of this build, in Settings-list order. A function, never a
 * module constant - the extension is installed after every module has loaded.
 */
export function commands(): readonly CommandDef[] {
  return catalog().list;
}

/** The active default binding for a command (what "reset" restores); null for
 * commands that are unbound by default. */
export function getDefaultCombo(id: CommandId): ShortcutCombo | null {
  return catalog().defaults.get(id) ?? null;
}

// Pressing only a modifier ('⌘' on its own) is never a binding.
const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
]);

// ---------------------------------------------------------------------------
// Pure helpers (event <-> combo, display, conflicts)
// ---------------------------------------------------------------------------

function norm(c: ShortcutCombo): Required<ShortcutCombo> {
  return { key: c.key, mod: !!c.mod, ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt };
}

/** The combo a keydown represents, or null for a modifier-only press. */
export function eventToCombo(e: KeyboardEvent): ShortcutCombo | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return {
    key: e.code,
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac ? e.ctrlKey : false,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

export function comboEquals(a: ShortcutCombo | null, b: ShortcutCombo | null): boolean {
  if (!a || !b) return a === b;
  const x = norm(a);
  const y = norm(b);
  return (
    x.key === y.key &&
    x.mod === y.mod &&
    x.ctrl === y.ctrl &&
    x.shift === y.shift &&
    x.alt === y.alt
  );
}

export function matchCombo(e: KeyboardEvent, combo: ShortcutCombo | null): boolean {
  if (!combo) return false;
  const c = norm(combo);
  return (
    c.key === e.code &&
    c.mod === (isMac ? e.metaKey : e.ctrlKey) &&
    c.ctrl === (isMac ? e.ctrlKey : false) &&
    c.shift === e.shiftKey &&
    c.alt === e.altKey
  );
}

/**
 * A binding must carry the primary modifier - a bare key (or Shift+key) would
 * fire while typing. Used to reject invalid captures in the Settings list.
 */
export function isValidCombo(combo: ShortcutCombo): boolean {
  return (!!combo.mod || !!combo.ctrl) && !MODIFIER_CODES.has(combo.key);
}

const CODE_GLYPHS: Record<string, string> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  NumpadEnter: '↩',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: isMac ? '⌫' : 'Backspace',
  Delete: isMac ? '⌦' : 'Del',
  Tab: isMac ? '⇥' : 'Tab',
  PageUp: isMac ? '⇞' : 'PgUp',
  PageDown: isMac ? '⇟' : 'PgDn',
};

function keyGlyph(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.slice(6);
  return CODE_GLYPHS[code] ?? code;
}

/**
 * Display tokens for a combo - each rendered as its own Kbd chip - in
 * platform-standard modifier order (macOS: ⌃⌥⇧⌘; otherwise Ctrl/Alt/Shift).
 */
export function comboTokens(combo: ShortcutCombo | null): string[] {
  if (!combo) return [];
  const tokens: string[] = [];
  if (isMac) {
    if (combo.ctrl) tokens.push('⌃');
    if (combo.alt) tokens.push('⌥');
    if (combo.shift) tokens.push('⇧');
    if (combo.mod) tokens.push('⌘');
  } else {
    if (combo.mod || combo.ctrl) tokens.push('Ctrl');
    if (combo.alt) tokens.push('Alt');
    if (combo.shift) tokens.push('Shift');
  }
  tokens.push(keyGlyph(combo.key));
  return tokens;
}

/**
 * Whether the Settings list and the palette show a command: core's always, an
 * extension's while what it drives is there (`ExtensionCommandDef.listed`).
 */
export function isCommandListed(c: CommandDef): boolean {
  const listed = (c as Partial<ExtensionCommandDef>).listed;
  return listed ? listed() : true;
}

/** The command already bound to `combo` (other than `exceptId`), or null. */
export function findConflict(
  keymap: Keymap,
  combo: ShortcutCombo,
  exceptId?: CommandId,
): CommandId | null {
  for (const c of commands()) {
    if (c.id === exceptId) continue;
    if (comboEquals(keymap[c.id], combo)) return c.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store (rebindings persisted to localStorage, like terminal-settings.ts)
// ---------------------------------------------------------------------------

export const SHORTCUTS_STORAGE_KEY = 'double0-keyboard-shortcuts';

// Only commands the user changed are stored; `null` means "explicitly unbound"
// (distinct from "absent" → fall back to the default).
type Overrides = Partial<Record<CommandId, ShortcutCombo | null>>;

function sanitizeCombo(raw: unknown): ShortcutCombo | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string') return undefined;
  return {
    key: r.key,
    mod: r.mod === true,
    ctrl: r.ctrl === true,
    shift: r.shift === true,
    alt: r.alt === true,
  };
}

/** Validate a raw overrides blob (from storage or a settings import): unknown
 * command ids and malformed combos are dropped. */
function sanitizeOverrides(parsed: unknown): Overrides {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Overrides = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!catalog().ids.has(id)) continue;
    const combo = sanitizeCombo(value);
    if (combo !== undefined) out[id as CommandId] = combo;
  }
  return out;
}

function loadOverrides(): Overrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    return raw ? sanitizeOverrides(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function resolve(o: Overrides): Keymap {
  const map: Keymap = {};
  for (const c of commands()) map[c.id] = c.id in o ? (o[c.id] ?? null) : getDefaultCombo(c.id);
  return map;
}

// Read on first use, never at module load: which ids are known depends on the
// extension, installed after every module has loaded. A different command
// list (a test installing another extension) reads storage again.
let overrides: Overrides = {};
let keymap: Keymap | null = null;
let keymapOf: readonly CommandDef[] | null = null;
const listeners = new Set<(keymap: Keymap) => void>();

function current(): Keymap {
  const list = commands();
  if (!keymap || keymapOf !== list) {
    overrides = loadOverrides();
    keymap = resolve(overrides);
    keymapOf = list;
  }
  return keymap;
}

function reload(): void {
  keymap = null;
  const next = current();
  for (const l of listeners) l(next);
}

if (typeof window !== 'undefined') {
  // Cross-window writes (a torn-off window) and external writes (import / JSON
  // editor, which emit SETTINGS_APPLIED_EVENT) both re-read so rebindings apply
  // live, matching the other localStorage-backed settings stores.
  window.addEventListener('storage', (e) => {
    if (e.key === SHORTCUTS_STORAGE_KEY) reload();
  });
  window.addEventListener(SETTINGS_APPLIED_EVENT, reload);
}

function persist(): void {
  keymap = resolve(overrides);
  keymapOf = commands();
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage failure - the rebinding still applies for this session.
  }
  for (const l of listeners) l(keymap);
}

export function getKeymap(): Keymap {
  return current();
}

export function setBinding(id: CommandId, combo: ShortcutCombo): void {
  current();
  overrides = { ...overrides, [id]: combo };
  persist();
}

export function unbind(id: CommandId): void {
  current();
  overrides = { ...overrides, [id]: null };
  persist();
}

export function resetBinding(id: CommandId): void {
  current();
  const next = { ...overrides };
  delete next[id];
  overrides = next;
  persist();
}

export function resetAll(): void {
  overrides = {};
  persist();
}

/** The user's rebindings (only the commands they changed) - for settings export. */
export function getShortcutOverrides(): Record<string, ShortcutCombo | null> {
  current();
  const out: Record<string, ShortcutCombo | null> = {};
  for (const [id, combo] of Object.entries(overrides)) {
    if (combo !== undefined) out[id] = combo;
  }
  return out;
}

/**
 * Replace every rebinding at once (settings import / restore). Unknown command
 * ids and malformed combos are dropped; commands absent from `value` fall back
 * to their defaults - so importing a saved set restores it exactly.
 */
export function importShortcutOverrides(value: unknown): void {
  overrides = sanitizeOverrides(value);
  persist();
}

export function subscribeKeymap(listener: (keymap: Keymap) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribeKeymap, getKeymap);
}

// Set while a Settings row is capturing a new combo, so the global handler
// stands down (and doesn't run a command as the user presses the keys to bind).
let capturing = false;

export function setCapturing(value: boolean): void {
  capturing = value;
}

export function isCapturing(): boolean {
  return capturing;
}
