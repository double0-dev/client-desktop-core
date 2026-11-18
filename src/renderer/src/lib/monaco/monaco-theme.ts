import { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';

import {
  DEFAULT_ACCENT_COLOR,
  buildAccentPalette,
  getAccentColor,
  subscribeAccentColor,
} from '@renderer/lib/settings/accent-color';
import {
  getEditorSettings,
  resolveEditorPalette,
  subscribeEditorSettings,
  type EditorPalette,
} from '@renderer/lib/settings/editor-settings';
import { resolveStoredTheme, subscribeTheme } from '@renderer/lib/settings/theme';

/**
 * Bridges Settings → Editor (editor-settings.ts) onto Monaco's VS Code theme
 * service. The palette model stays exactly what the settings UI edits - the 8
 * syntax slots plus chrome colors - and lands here as VS Code color/token
 * customizations layered over the stock Modern themes. TextMate scopes below
 * cover the palette's 8 slots with VS Code scopes, so the Monaco editor, the
 * Changes diff (colorized by Monaco, see diff-highlight.ts), and the settings
 * preview cards all speak the same palette.
 *
 * Monaco themes are global to the window: this module applies them once via
 * user-configuration updates, not per editor instance. Fonts stay per-editor
 * options (monaco-editor.tsx) - they follow the same settings store but are
 * instance-scoped in Monaco's API.
 */

function tokenRules(p: EditorPalette): { scope: string[]; settings: Record<string, string> }[] {
  const s = p.syntax;
  return [
    {
      scope: [
        'keyword',
        'keyword.control',
        'storage',
        'storage.type',
        'storage.modifier',
        'variable.language',
        'entity.other.attribute-name',
      ],
      settings: { foreground: s.keyword },
    },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: s.string } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
      settings: { foreground: s.function },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
      ],
      settings: { foreground: s.type },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.character',
        'constant.character.escape',
        'string.regexp',
      ],
      settings: { foreground: s.number },
    },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: s.comment, fontStyle: 'italic' },
    },
    {
      scope: [
        'variable.other.property',
        'variable.other.object.property',
        'support.type.property-name',
        'meta.object-literal.key',
        'entity.name.tag.yaml',
      ],
      settings: { foreground: s.property },
    },
    { scope: ['entity.name.tag', 'invalid'], settings: { foreground: s.tag } },
    {
      scope: ['keyword.operator', 'punctuation', 'meta.brace'],
      settings: { foreground: p.punctuation },
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: s.string, fontStyle: 'bold' },
    },
    {
      scope: ['markup.underline.link', 'string.other.link'],
      settings: { foreground: s.function, fontStyle: 'underline' },
    },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ];
}

/**
 * `--accent` / `--accent-foreground` for the requested mode - the pair the
 * app's own menus highlight with. At the default accent these are the
 * hand-tuned globals.css values (the accent override tag is absent then, see
 * accent-color.ts); any other accent uses the same derived tokens the app does.
 * The mode follows the EDITOR palette, not the app theme: Monaco's menu chrome
 * (Dark/Light Modern + widgetBg below) tracks the editor's darkness, and a
 * dark menu must not pick up light-mode accent tints.
 */
function menuAccent(dark: boolean): { background: string; foreground: string } {
  const color = getAccentColor();
  if (color === DEFAULT_ACCENT_COLOR) {
    return dark
      ? { background: '#1f2d0c', foreground: '#d4e290' }
      : { background: '#f7fae8', foreground: '#4a661f' };
  }
  const tokens = buildAccentPalette(color)[dark ? 'dark' : 'light'];
  return { background: tokens.accent, foreground: tokens.accentForeground };
}

function colorCustomizations(p: EditorPalette): Record<string, string> {
  const widgetBg = p.dark ? '#16161b' : '#ffffff';
  const widgetBorder = p.dark ? '#262629' : '#d4d4d8';
  const thumb = p.dark ? '#ffffff26' : '#00000026';
  const thumbHover = p.dark ? '#ffffff40' : '#00000040';
  const accent = menuAccent(p.dark);
  return {
    'editor.background': p.background,
    'editor.foreground': p.foreground,
    'editorCursor.foreground': p.cursor,
    'editor.selectionBackground': p.selection,
    'editor.inactiveSelectionBackground': p.selection,
    'editor.selectionHighlightBackground': p.selection,
    // Same subtle wash the pre-Monaco editor used for the active line.
    'editor.lineHighlightBackground': p.dark ? '#ffffff06' : '#00000009',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': p.syntax.comment,
    'editorLineNumber.activeForeground': p.foreground,
    'editorBracketMatch.background': p.selection,
    'editorBracketMatch.border': '#00000000',
    'editorGutter.background': p.background,
    'editorWidget.background': widgetBg,
    'editorWidget.border': widgetBorder,
    'editorHoverWidget.background': widgetBg,
    'editorHoverWidget.border': widgetBorder,
    'editorSuggestWidget.background': widgetBg,
    'editorSuggestWidget.border': widgetBorder,
    'editorSuggestWidget.foreground': p.foreground,
    'editorSuggestWidget.selectedBackground': p.selection,
    'scrollbarSlider.background': thumb,
    'scrollbarSlider.hoverBackground': thumbHover,
    'scrollbarSlider.activeBackground': thumbHover,
    // Right-click context menu: same chrome as the widgets above, highlight
    // matching the app's menus (accent tokens) instead of stock VS Code blue.
    'menu.background': widgetBg,
    'menu.foreground': p.foreground,
    'menu.border': widgetBorder,
    'menu.separatorBackground': widgetBorder,
    'menu.selectionBackground': accent.background,
    'menu.selectionForeground': accent.foreground,
    'menu.selectionBorder': '#00000000',
  };
}

let lastApplied = '';

function apply(): void {
  const p = resolveEditorPalette(getEditorSettings(), resolveStoredTheme());
  const json = JSON.stringify({
    'workbench.colorTheme': p.dark ? 'Default Dark Modern' : 'Default Light Modern',
    'workbench.colorCustomizations': colorCustomizations(p),
    'editor.tokenColorCustomizations': { textMateRules: tokenRules(p) },
    // Keep in sync with the initial userConfiguration in monaco.ts (this
    // update replaces the whole user-config JSON).
    'editor.experimental.asyncTokenization': false,
  });
  if (json === lastApplied) return;
  lastApplied = json;
  void updateUserConfiguration(json);
}

let started = false;

/** Called once by initMonaco() after the services are up; keeps the global
 * Monaco theme following Settings → Editor, the app light/dark toggle, and
 * the Settings → General accent color (context-menu highlight). */
export function startMonacoThemeSync(): void {
  if (started) return;
  started = true;
  apply();
  subscribeEditorSettings(apply);
  subscribeTheme(apply);
  subscribeAccentColor(apply);
}
