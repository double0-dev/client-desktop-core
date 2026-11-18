import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { useAppTheme } from '@renderer/lib/settings/theme';
import { chosenTerminalEngine, terminalEngine } from '@renderer/lib/terminal/engine';
import {
  ANSI_SLOTS,
  PREBUILT_TERMINAL_THEMES,
  TERMINAL_ENGINES,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK,
  TERMINAL_SCROLL_SPEED,
  resolveTerminalFontCss,
  resolveTerminalTheme,
  updateTerminalSettings,
  useTerminalSettings,
  type TerminalEngine,
  type TerminalThemeId,
} from '@renderer/lib/settings/terminal-settings';
import { cn } from '@renderer/lib/utils';
import {
  ColorField,
  ColorSwatch,
  FontFamilyField,
  SettingToggleRow,
  Stepper,
} from '@renderer/routes/_app/-components/settings/settings-controls';

/** Preview line colors derived from a theme, for the mini cards + live preview. */
function previewColors(theme: ReturnType<typeof resolveTerminalTheme>) {
  return {
    bg: theme.background ?? '#0d0d0d',
    fg: theme.foreground ?? '#e4e4e7',
    accent: theme.green ?? '#4ade80',
    dir: theme.blue ?? '#60a5fa',
    muted: theme.brightBlack ?? '#52525b',
    cursor: theme.cursor ?? '#a8c945',
  };
}

export function TerminalSettingsSection() {
  const settings = useTerminalSettings();
  const appTheme = useAppTheme();
  const isCustom = settings.themeId === 'custom';

  const cards: { id: TerminalThemeId; name: string }[] = [
    { id: 'auto', name: 'Auto' },
    ...PREBUILT_TERMINAL_THEMES.map((t) => ({ id: t.id as TerminalThemeId, name: t.name })),
    { id: 'custom', name: 'Custom' },
  ];

  const activeTheme = resolveTerminalTheme(settings, appTheme);
  const preview = previewColors(activeTheme);

  // min-h-full (not h-full): fills the pane so the preview can stretch, yet
  // still grows with taller content - an exact-height root would make children
  // overflow it and swallow the scroll container's bottom padding.
  return (
    <div className="flex min-h-full flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Theme
        </h3>
        <div className="grid grid-cols-4 gap-2.5">
          {cards.map((card) => {
            const c = previewColors(
              resolveTerminalTheme({ ...settings, themeId: card.id }, appTheme),
            );
            const selected = settings.themeId === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => updateTerminalSettings({ themeId: card.id })}
                aria-pressed={selected}
                className={cn(
                  'flex flex-col overflow-hidden rounded-md border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                  selected ? 'border-primary' : 'border-border hover:border-border-strong',
                )}
              >
                <div
                  className="flex h-[60px] w-full flex-col gap-1 p-2 font-mono text-[length:calc(8px*var(--ui-font-scale,1))] leading-none"
                  style={{ backgroundColor: c.bg }}
                >
                  <div className="flex gap-1">
                    <span style={{ color: c.accent }}>➜</span>
                    <span style={{ color: c.fg }}>git status</span>
                  </div>
                  <span style={{ color: c.muted }}>On branch main</span>
                  <div className="flex gap-1">
                    <span style={{ color: c.accent }}>✓</span>
                    <span style={{ color: c.fg }}>working tree clean</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 bg-surface px-2.5 py-[7px]">
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs text-foreground',
                      selected && 'font-semibold',
                    )}
                  >
                    {card.name}
                  </span>
                  {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
          Auto follows the app’s light/dark appearance; the other themes stay fixed.
        </p>
      </section>

      <section className={cn('flex flex-col gap-2', !isCustom && 'opacity-60')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
            Custom colors
          </h3>
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
            Applies when Custom is selected
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          {(
            [
              ['Background', 'background'],
              ['Foreground', 'foreground'],
              ['Cursor', 'cursor'],
              ['Selection', 'selection'],
            ] as const
          ).map(([label, key]) => (
            <ColorField
              key={key}
              label={label}
              value={settings.custom[key]}
              onChange={(hex) =>
                updateTerminalSettings({ themeId: 'custom', custom: { [key]: hex } })
              }
            />
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
            ANSI palette
          </p>
          <div className="flex gap-1.5">
            {settings.custom.ansi.map((color, i) => (
              <ColorSwatch
                key={ANSI_SLOTS[i]}
                label={`ANSI ${ANSI_SLOTS[i]}`}
                value={color}
                className="size-[18px] rounded"
                onChange={(hex) => {
                  const ansi = [...settings.custom.ansi];
                  ansi[i] = hex;
                  updateTerminalSettings({ themeId: 'custom', custom: { ansi } });
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Font
        </h3>
        {/* Family + Size share the first row; the numeric fields fill a second
            row so five controls never overflow into a single line. */}
        <div className="flex gap-2.5">
          <FontFamilyField
            value={settings.fontFamily}
            options={TERMINAL_FONT_FAMILIES}
            onChange={(fontFamily) => updateTerminalSettings({ fontFamily })}
          />
          <Stepper
            label="Size"
            value={settings.fontSize}
            display={String(settings.fontSize)}
            {...TERMINAL_FONT_SIZE}
            onChange={(fontSize) => updateTerminalSettings({ fontSize })}
          />
        </div>
        <div className="flex gap-2.5">
          <Stepper
            label="Line height"
            value={settings.lineHeight}
            display={settings.lineHeight.toFixed(1)}
            {...TERMINAL_LINE_HEIGHT}
            fill
            onChange={(lineHeight) => updateTerminalSettings({ lineHeight })}
          />
          <Stepper
            label="Scrollback"
            value={settings.scrollback}
            display={String(settings.scrollback)}
            {...TERMINAL_SCROLLBACK}
            fill
            onChange={(scrollback) => updateTerminalSettings({ scrollback })}
          />
          <Stepper
            label="Scroll speed"
            value={settings.scrollSpeed}
            display={`${settings.scrollSpeed}×`}
            {...TERMINAL_SCROLL_SPEED}
            fill
            onChange={(scrollSpeed) => updateTerminalSettings({ scrollSpeed })}
          />
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-subtle">
          Applies to the terminal content only - other text uses the application font from General.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <TerminalEngineRow />
        <SettingToggleRow
          title="Shell integration"
          description="Lets zsh (and bash on Linux) report each command and its exit status to the Inputs list in the status bar. Applies to terminals opened from now on."
          checked={settings.shellIntegration}
          onChange={(shellIntegration) => updateTerminalSettings({ shellIntegration })}
        />
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Preview
        </h3>
        <div
          className="flex min-h-[96px] flex-1 flex-col overflow-hidden rounded-md border border-border p-3"
          style={{
            backgroundColor: preview.bg,
            fontFamily: resolveTerminalFontCss(settings),
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight * 1.2,
          }}
        >
          <div className="flex items-center gap-1.5">
            <span style={{ color: preview.accent }}>➜</span>
            <span style={{ color: preview.dir }}>double0</span>
            <span style={{ color: preview.fg }}>npm run dev</span>
          </div>
          <span style={{ color: preview.muted }}>&gt; electron-vite v3.0.0 dev server running</span>
          <div className="flex items-center gap-1.5">
            <span style={{ color: preview.accent }}>✓</span>
            <span style={{ color: preview.fg }}>renderer compiled in 184 ms</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span style={{ color: preview.accent }}>➜</span>
            <span style={{ color: preview.dir }}>double0</span>
            <span
              className="inline-block w-[0.55em] animate-pulse"
              style={{ backgroundColor: preview.cursor, height: '1.1em' }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Renderer (lib/terminal/engine.ts): xterm.js or the Ghostty engine. A window
 * picks its engine when it boots, so a change offers a reload.
 */
function TerminalEngineRow() {
  const { engine } = useTerminalSettings();
  const running = terminalEngine();
  const failed = chosenTerminalEngine() === 'ghostty' && running === 'xterm';
  const pending = engine !== running && !(failed && engine === 'ghostty');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <label
            htmlFor="terminal-engine"
            className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground"
          >
            Renderer
          </label>
          <p className="text-xs leading-relaxed text-foreground-subtle">
            The engine that runs and draws terminals. Ghostty is Ghostty&apos;s terminal core
            compiled to WebAssembly and is experimental: it draws without the GPU, and a theme
            change redraws each terminal from its recent output. Applies when the window reloads.
          </p>
        </div>
        <div className="relative w-[190px] shrink-0">
          <select
            id="terminal-engine"
            value={engine}
            onChange={(e) => updateTerminalSettings({ engine: e.target.value as TerminalEngine })}
            className="h-8 w-full appearance-none rounded-md border border-border bg-input pl-2.5 pr-8 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {TERMINAL_ENGINES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-muted" />
        </div>
      </div>
      {failed && engine === 'ghostty' && (
        <p className="text-xs leading-relaxed text-warning">
          The Ghostty engine failed to load - this window runs xterm.js.
        </p>
      )}
      {pending && (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground-subtle">
            This window still runs {running === 'ghostty' ? 'Ghostty' : 'xterm.js'}. Reloading keeps
            every shell running.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="text-[length:calc(13px*var(--ui-font-scale,1))]"
            onClick={() => window.location.reload()}
          >
            Reload now
          </Button>
        </div>
      )}
    </div>
  );
}
