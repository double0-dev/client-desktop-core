import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  ensureHostLanguageServers,
  installLanguageServer,
  languageMachines,
  lsKey,
  refreshLanguageServers,
  resetLanguagePrompts,
  uninstallLanguageServer,
  useLanguageServers,
  type LanguageServerInfo,
} from '@renderer/lib/language-server-store';
import { hostsEnabled } from '@renderer/lib/hosts/hosts-enabled';
import { useHostStatuses } from '@renderer/lib/hosts/host-status';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { useAppTheme } from '@renderer/lib/settings/theme';
import {
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  PREBUILT_EDITOR_THEMES,
  SYNTAX_SLOTS,
  resolveEditorFontCss,
  resolveEditorPalette,
  updateEditorSettings,
  useEditorSettings,
  type EditorThemeId,
} from '@renderer/lib/settings/editor-settings';
import { cn } from '@renderer/lib/utils';
import {
  ColorField,
  ColorSwatch,
  FontFamilyField,
  Stepper,
} from '@renderer/routes/_app/-components/settings/settings-controls';

export function EditorSettingsSection() {
  const settings = useEditorSettings();
  const appTheme = useAppTheme();
  const isCustom = settings.themeId === 'custom';

  const cards: { id: EditorThemeId; name: string }[] = [
    { id: 'auto', name: 'Auto' },
    ...PREBUILT_EDITOR_THEMES.map((t) => ({ id: t.id as EditorThemeId, name: t.name })),
    { id: 'custom', name: 'Custom' },
  ];

  const palette = resolveEditorPalette(settings, appTheme);

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
            const c = resolveEditorPalette({ ...settings, themeId: card.id }, appTheme);
            const selected = settings.themeId === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => updateEditorSettings({ themeId: card.id })}
                aria-pressed={selected}
                className={cn(
                  'flex flex-col overflow-hidden rounded-md border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                  selected ? 'border-primary' : 'border-border hover:border-border-strong',
                )}
              >
                <div
                  className="flex h-[60px] w-full flex-col gap-1 p-2 font-mono text-[length:calc(8px*var(--ui-font-scale,1))] leading-none"
                  style={{ backgroundColor: c.background }}
                >
                  <div className="flex gap-1">
                    <span style={{ color: c.syntax.keyword }}>const</span>
                    <span style={{ color: c.foreground }}>x =</span>
                    <span style={{ color: c.syntax.number }}>42</span>
                  </div>
                  <span style={{ color: c.syntax.comment }}>{'// theme'}</span>
                  <div className="flex">
                    <span style={{ color: c.syntax.function }}>render</span>
                    <span style={{ color: c.foreground }}>(</span>
                    <span style={{ color: c.syntax.string }}>{"'ok'"}</span>
                    <span style={{ color: c.foreground }}>)</span>
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
                updateEditorSettings({ themeId: 'custom', custom: { [key]: hex } })
              }
            />
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
            Syntax palette
          </p>
          <div className="flex gap-1.5">
            {settings.custom.syntax.map((color, i) => (
              <ColorSwatch
                key={SYNTAX_SLOTS[i]}
                label={`Syntax: ${SYNTAX_SLOTS[i]}`}
                value={color}
                className="size-[18px] rounded"
                onChange={(hex) => {
                  const syntax = [...settings.custom.syntax];
                  syntax[i] = hex;
                  updateEditorSettings({ themeId: 'custom', custom: { syntax } });
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
        <div className="flex gap-2.5">
          <FontFamilyField
            value={settings.fontFamily}
            options={EDITOR_FONT_FAMILIES}
            onChange={(fontFamily) => updateEditorSettings({ fontFamily })}
          />
          <Stepper
            label="Size"
            value={settings.fontSize}
            display={String(settings.fontSize)}
            {...EDITOR_FONT_SIZE}
            onChange={(fontSize) => updateEditorSettings({ fontSize })}
          />
          <Stepper
            label="Line height"
            value={settings.lineHeight}
            display={settings.lineHeight.toFixed(1)}
            {...EDITOR_LINE_HEIGHT}
            onChange={(lineHeight) => updateEditorSettings({ lineHeight })}
          />
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-subtle">
          Applies to the editor content only - other text uses the application font from General.
        </p>
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Preview
        </h3>
        <div
          className="flex min-h-[96px] flex-1 flex-col overflow-hidden rounded-md border border-border p-3"
          style={{
            backgroundColor: palette.background,
            fontFamily: resolveEditorFontCss(settings),
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
          }}
        >
          <div>
            <span style={{ color: palette.syntax.keyword }}>import</span>
            <span style={{ color: palette.foreground }}>{' { run } '}</span>
            <span style={{ color: palette.syntax.keyword }}>from</span>
            <span style={{ color: palette.syntax.string }}>{" './agent'"}</span>
          </div>
          <span style={{ color: palette.syntax.comment, fontStyle: 'italic' }}>
            {'// launch a session'}
          </span>
          <div>
            <span style={{ color: palette.syntax.keyword }}>const</span>
            <span style={{ color: palette.foreground }}>{' result = '}</span>
            <span style={{ color: palette.syntax.keyword }}>await</span>
            <span style={{ color: palette.syntax.function }}>{' run'}</span>
            <span style={{ color: palette.foreground }}>{'({ retries: '}</span>
            <span style={{ color: palette.syntax.number }}>3</span>
            <span style={{ color: palette.foreground }}>{' })'}</span>
          </div>
          <div className="flex items-center">
            <span style={{ color: palette.foreground }}>result.</span>
            <span style={{ color: palette.syntax.property }}>status</span>
            <span
              className="inline-block w-[2px] animate-pulse"
              style={{ backgroundColor: palette.cursor, height: '1.1em' }}
            />
          </div>
        </div>
      </section>

      <LanguagesSettingsSection />
    </div>
  );
}

/** The Language servers block inside Settings → Editor: the registry -
 * per-language status, install/uninstall/update, and the "don't ask again"
 * prompt reset. Rendered as sibling sections of the Editor section's column. */
function LanguagesSettingsSection() {
  const state = useLanguageServers();
  const dismissedCount = Object.keys(state.dismissed).length;
  // Each machine's servers (plan 29 › M9): this computer, then each host.
  const hosts = useHosts();
  const statuses = useHostStatuses();
  const machines = hostsEnabled() ? languageMachines(hosts, statuses) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const machine = machines.find((m) => m.id === picked && !m.unavailable)?.id ?? null;
  const machineLabel = machines.find((m) => m.id === machine)?.label ?? null;
  useEffect(() => {
    if (!machine) return;
    ensureHostLanguageServers(machine);
    // Re-asked each time the machine is picked: a server put on its PATH
    // by hand meanwhile shows.
    void refreshLanguageServers(machine);
  }, [machine]);
  const list = machine ? state.hosts[machine] : state.languages;

  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Language servers
        </h3>
        {machines.length > 1 && (
          <div role="radiogroup" aria-label="Machine" className="flex flex-wrap items-center gap-1">
            {machines.map((m) => (
              <button
                key={m.id ?? 'local'}
                type="button"
                role="radio"
                aria-checked={m.id === machine}
                disabled={!!m.unavailable}
                title={m.unavailable}
                onClick={() => setPicked(m.id)}
                className={cn(
                  'rounded-sm border px-2 py-0.5 text-[length:calc(11px*var(--ui-font-scale,1))] transition-colors disabled:cursor-default disabled:opacity-50',
                  m.id === machine
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border-strong text-foreground-muted hover:bg-muted hover:text-foreground',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
          {!list ? (
            <div className="px-3 py-3 text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-muted">
              {machineLabel && machine
                ? `Checking ${machineLabel}…`
                : 'Checking installed servers…'}
            </div>
          ) : (
            list.map((info) => (
              <LanguageServerRow
                key={info.id}
                info={info}
                hostId={machine}
                progress={state.progress[lsKey(machine, info.id)]}
                error={state.errors[lsKey(machine, info.id)]}
              />
            ))
          )}
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-subtle">
          {machine && machineLabel
            ? `Servers for files on ${machineLabel} run there. Installs go into ~/.double0 on ${machineLabel}, fetched there (or sent from this computer when it cannot reach the registry). A copy on its PATH is used as-is.`
            : 'Servers power completions, diagnostics and go-to-definition in the editor. Installs go into the app’s own storage - no Node.js or package manager needed. A copy already on your PATH is used as-is.'}
        </p>
      </section>

      {dismissedCount > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
            Editor prompts
          </h3>
          <div className="flex items-center gap-3">
            <p className="text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-muted">
              “Don’t ask again” is set for {dismissedCount}{' '}
              {dismissedCount === 1 ? 'language' : 'languages'}.
            </p>
            <Button variant="outline" size="sm" onClick={() => resetLanguagePrompts()}>
              Reset prompts
            </Button>
          </div>
        </section>
      )}
    </>
  );
}

function LanguageServerRow({
  info,
  hostId,
  progress,
  error,
}: {
  info: LanguageServerInfo;
  /** The machine the row is about (null = this computer). */
  hostId: string | null;
  progress?: { done: number; total: number };
  error?: string;
}) {
  const chip = (text: string, tone: 'muted' | 'success' | 'warning' = 'muted'): React.ReactNode => (
    <span
      className={cn(
        'shrink-0 rounded-sm border px-1.5 py-0.5 text-[length:calc(10px*var(--ui-font-scale,1))]',
        tone === 'success'
          ? 'border-success/40 text-success'
          : tone === 'warning'
            ? 'border-warning/40 text-warning'
            : 'border-border-strong text-foreground-muted',
      )}
    >
      {text}
    </span>
  );

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[length:calc(12px*var(--ui-font-scale,1))] font-medium text-foreground">
            {info.name}
          </span>
          {info.status === 'builtin' && chip('Built-in')}
          {info.status === 'installed' && chip(`Installed v${info.version}`, 'success')}
          {info.status === 'on-path' && chip('Found on PATH', 'success')}
          {info.status === 'installing' &&
            chip(progress ? `Installing ${progress.done}/${progress.total}…` : 'Installing…')}
          {info.status === 'missing-tool' && chip('Needs toolchain', 'warning')}
        </div>
        <span className="truncate font-mono text-[length:calc(10px*var(--ui-font-scale,1))] text-foreground-subtle">
          {error
            ? `Install failed: ${error}`
            : info.status === 'on-path'
              ? info.path
              : info.status === 'missing-tool'
                ? info.installHint
                : info.extensions.map((e) => `.${e}`).join('  ')}
        </span>
      </div>
      {info.status === 'available' && (
        <Button variant="outline" size="sm" onClick={() => installLanguageServer(info.id, hostId)}>
          {error ? 'Retry' : `Install${info.approxMb ? ` (~${info.approxMb} MB)` : ''}`}
        </Button>
      )}
      {info.status === 'installed' && info.updateTo && (
        <Button variant="outline" size="sm" onClick={() => installLanguageServer(info.id, hostId)}>
          Update to v{info.updateTo}
        </Button>
      )}
      {info.status === 'installed' && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => uninstallLanguageServer(info.id, hostId)}
        >
          Uninstall
        </Button>
      )}
    </div>
  );
}
