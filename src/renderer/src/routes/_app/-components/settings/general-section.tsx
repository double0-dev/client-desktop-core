import { useEffect, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { SettingsJsonDialog } from '@renderer/routes/_app/-components/settings/settings-json-dialog';
import { ThirdPartyNoticesDialog } from '@renderer/routes/_app/-components/settings/third-party-notices-dialog';
import { Button } from '@renderer/components/ui/button';
import { Logo } from '@renderer/components/logo';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  ACCENT_PRESETS,
  updateAccentColor,
  useAccentColor,
} from '@renderer/lib/settings/accent-color';
import { setVerticalTabs, useVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import {
  LIVE_MOTION_OPTIONS,
  updateLiveMotionSettings,
  useLiveMotionSettings,
  type LiveMotion,
} from '@renderer/lib/settings/live-motion-settings';
import {
  updateHoverScrollSettings,
  useHoverScrollSettings,
} from '@renderer/lib/settings/hover-scroll-settings';
import {
  buildExportDocument,
  importDocument,
  EXPORT_FILE_NAME,
  type ImportResult,
} from '@renderer/lib/settings/settings-transfer';
import { resetAppSettings } from '@renderer/lib/settings/settings-reset';
import {
  DEFAULT_FONT_FAMILY,
  UI_FONT_FAMILIES,
  appFontSettings,
  explorerFontSettings,
  type UiFontSettings,
} from '@renderer/lib/settings/ui-font-settings';
import { cn } from '@renderer/lib/utils';
import {
  FontSelect,
  FontSizeSelect,
  PresetColorPicker,
  SettingActionRow,
  SettingToggleRow,
} from '@renderer/routes/_app/-components/settings/settings-controls';

/**
 * What "Export everything" writes: core's rows, plus what the extension's
 * sections add (`DataTransferSlot.describes`).
 */
function exportDescription(): string {
  const extra = rendererExtension().dataTransfer?.describes;
  return `Every setting, plus projects, sessions${extra ? `, ${extra}` : ''} and workspace layouts - one readable JSON file. Account tokens and SSH keys stay on this machine.`;
}

export function GeneralSettingsSection() {
  const AccountSection = rendererExtension().auth?.AccountSection;
  // The extension's update rows, if any.
  const UpdatesRows = rendererExtension().updates?.SettingsRows;
  const GeneralRows = rendererExtension().generalRows ?? [];
  const appFont = appFontSettings.useValue();
  const explorerFont = explorerFontSettings.useValue();
  const verticalTabs = useVerticalTabs();
  // The File explorer can pin its own font/size and ignore these values - say
  // so here, or the app-wide controls look broken. (The terminal, editor and
  // Changes content are always independent of the app font.)
  const overrides = (s: UiFontSettings): boolean =>
    s.fontFamily !== DEFAULT_FONT_FAMILY || s.fontSize != null;
  const fontOverrides = overrides(explorerFont) ? ['File explorer'] : [];
  const [version, setVersion] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  useEffect(() => {
    void window.api.getAppVersion().then(setVersion);
  }, []);

  async function exportAll(): Promise<void> {
    if (busy || !window.api?.saveTextFile) return;
    setBusy('export');
    try {
      const content = await buildExportDocument();
      const result = await window.api.saveTextFile(EXPORT_FILE_NAME, content);
      if (result.error) {
        await alertDialog({ title: 'Export failed', description: result.error });
      } else if (result.path) {
        await alertDialog({ title: 'Export complete', description: `Saved to ${result.path}` });
      }
    } catch (err) {
      await alertDialog({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Could not gather the data.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function importAll(): Promise<void> {
    if (busy || !window.api?.openTextFile) return;
    setBusy('import');
    try {
      const picked = await window.api.openTextFile();
      if (picked.canceled) return;
      if (picked.error || picked.content == null) {
        await alertDialog({
          title: 'Import failed',
          description: picked.error ?? 'Could not read the file.',
        });
        return;
      }
      setImportResult(await importDocument(picked.content));
    } finally {
      setBusy(null);
    }
  }

  // Design `Screen/Settings - General · Reset confirm`: nothing happens until
  // the destructive action in the dialog is taken. The reset itself is
  // synchronous and live (every section re-renders on its store's default).
  async function resetAll(): Promise<void> {
    const ok = await confirmDialog({
      title: 'Reset all settings?',
      description:
        'Every section goes back to its defaults on this machine. Projects, sessions, task boards and account connections are kept. Export first if you want a copy.',
      confirmLabel: 'Reset settings',
      destructive: true,
      icon: RotateCcw,
    });
    if (ok) resetAppSettings();
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {/* The signed-in account - Pro (a private plan: login is Pro); the core build has none. */}
      {AccountSection && (
        <>
          <AccountSection />
          <div className="h-px w-full bg-border" />
        </>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          APPLICATION
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#242429] bg-[#0f0f12]">
            <Logo className="h-[22px] w-auto fill-electric-400" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="text-[length:calc(14px*var(--ui-font-scale,1))] font-semibold text-foreground">
              double0
            </p>
            <p className="text-xs text-foreground-subtle">Desktop client</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <p className="min-w-0 flex-1 text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
            App version
          </p>
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-xs font-medium text-foreground-muted">
            {version ? `v${version}` : '-'}
          </span>
        </div>
        {/* Updates rows + the auto-check toggle (design `Label/Settings ·
            Update states`) - the extension's, if any. */}
        {UpdatesRows && <UpdatesRows />}
        {/* The extension's rows (the official build's crash-report switch). */}
        {GeneralRows.map((Row, i) => (
          <Row key={i} />
        ))}
        <SettingActionRow
          title="Open-source licences"
          description="The open-source packages double0 is built with, and their licences."
          buttonLabel="View…"
          onClick={() => setNoticesOpen(true)}
        />
        <SettingsTransferRow
          title="Edit all settings as JSON"
          description="Every section as one editable document, tokens and keys excluded - validated before anything applies."
          buttonLabel="Open editor…"
          onClick={() => setJsonOpen(true)}
        />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          WORKSPACE
        </h3>
        <SettingToggleRow
          title="Vertical tabs"
          description="Show open tabs in a vertical list in the sidebar instead of the horizontal tab strip."
          checked={verticalTabs}
          onChange={setVerticalTabs}
        />
        <LiveMotionRow />
        <HoverScrollRow />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          ACCENT COLOR
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
              Accent color
            </p>
            <p className="text-xs leading-relaxed text-foreground-subtle">
              Primary color for buttons, links and highlights. Projects without a color of their own
              use it too.
            </p>
          </div>
          <AccentColorControl />
        </div>
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          FONT
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
              Application font
            </p>
            <p className="text-xs leading-relaxed text-foreground-subtle">
              Family and size apply to the whole app except the terminal, the code editor and the
              diff in Changes. The File explorer can override both for its content.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <FontSelect
              value={appFont.fontFamily}
              options={UI_FONT_FAMILIES}
              defaultLabel="Default"
              onChange={(fontFamily) => appFontSettings.update({ fontFamily })}
              className="w-[150px]"
            />
            <FontSizeSelect
              value={appFont.fontSize}
              defaultLabel="Default"
              onChange={(fontSize) => appFontSettings.update({ fontSize })}
              className="w-[92px]"
            />
          </div>
        </div>
        {fontOverrides.length > 0 && (
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-warning">
            {fontOverrides.join(' and ')} currently override{fontOverrides.length === 1 ? 's' : ''}{' '}
            this - set their Font controls back to “App font” / “App size” to follow these values.
          </p>
        )}
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          IMPORT &amp; EXPORT
        </h3>
        <SettingsTransferRow
          title="Export everything"
          description={exportDescription()}
          buttonLabel={busy === 'export' ? 'Exporting…' : 'Export…'}
          onClick={() => void exportAll()}
        />
        <SettingsTransferRow
          title="Import from a file"
          description="Restores settings and syncs projects/sessions into the local database (matched by id). Problems are reported per item."
          buttonLabel={busy === 'import' ? 'Importing…' : 'Choose file…'}
          onClick={() => void importAll()}
        />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          RESET
        </h3>
        <SettingsTransferRow
          title="Reset all settings"
          description="Every section goes back to its defaults on this machine - appearance, fonts, terminal, editor, shortcuts and the rest. Projects, sessions, task boards and account connections are kept."
          buttonLabel="Reset…"
          destructive
          onClick={() => void resetAll()}
        />
      </section>

      <SettingsJsonDialog open={jsonOpen} onOpenChange={setJsonOpen} />
      <ThirdPartyNoticesDialog open={noticesOpen} onOpenChange={setNoticesOpen} />
      <ImportResultDialog result={importResult} onClose={() => setImportResult(null)} />
    </div>
  );
}

/** Outcome of an import: what landed, what was skipped and why. */
function ImportResultDialog({
  result,
  onClose,
}: {
  result: ImportResult | null;
  onClose: () => void;
}) {
  if (!result) return null;
  const failed = !!result.fatal?.length;
  const summary: string[] = failed
    ? []
    : [
        result.settings === 'applied'
          ? 'Settings applied.'
          : result.settings === 'invalid'
            ? 'Settings were invalid - skipped (see below).'
            : 'No settings in the file.',
        `Projects: ${result.projectsCreated} added, ${result.projectsUpdated} updated.`,
        `Sessions: ${result.sessionsCreated} added, ${result.sessionsUpdated} updated.`,
        ...result.extension.summary,
        `Workspace layouts restored: ${result.layoutsSaved}.`,
        ...(result.skippedSections.length > 0
          ? [`Not used by this version, skipped: ${result.skippedSections.join(', ')}.`]
          : []),
      ];
  const problems = failed ? (result.fatal ?? []) : result.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{failed ? 'Import failed' : 'Import complete'}</DialogTitle>
          {failed && (
            <DialogDescription>Nothing was imported - the file has problems:</DialogDescription>
          )}
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
          {summary.length > 0 && (
            <div className="flex flex-col gap-1">
              {summary.map((line, i) => (
                <p
                  key={i}
                  className="text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground"
                >
                  {line}
                </p>
              ))}
            </div>
          )}
          {problems.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              {!failed && (
                <p className="text-xs font-medium text-warning">
                  {problems.length} item{problems.length === 1 ? '' : 's'} skipped:
                </p>
              )}
              {problems.map((error, i) => (
                <p
                  key={i}
                  className={cn(
                    'break-words font-mono text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed',
                    failed ? 'text-destructive' : 'text-foreground-muted',
                  )}
                >
                  {error}
                </p>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" autoFocus onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One import/export/reset row - the shared `SettingActionRow` with this
 * section's prop names kept, so its call sites read as they always did.
 */
function SettingsTransferRow({
  title,
  description,
  buttonLabel,
  destructive = false,
  onClick,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <SettingActionRow
      title={title}
      description={description}
      buttonLabel={buttonLabel}
      destructive={destructive}
      onClick={onClick}
    />
  );
}

/** Accent color row (design: sec-accent) over the shared preset picker. */
function AccentColorControl() {
  const accent = useAccentColor();
  return (
    <PresetColorPicker
      presets={ACCENT_PRESETS}
      value={accent}
      onChange={(hex) => {
        if (hex) updateAccentColor(hex);
      }}
      noun="accent"
    />
  );
}

/**
 * "Scroll long names on hover" (lib/settings/hover-scroll-settings.ts): rows
 * whose text does not fit slide it sideways while hovered.
 */
function HoverScrollRow() {
  const { enabled } = useHoverScrollSettings();
  return (
    <SettingToggleRow
      title="Scroll long names on hover"
      description="When a name does not fit its row (a session, a branch, a tag), slide it sideways while the pointer is over the row. Off keeps the name cut short, with the full name in the tooltip."
      checked={enabled}
      onChange={(next) => updateHoverScrollSettings({ enabled: next })}
    />
  );
}

/**
 * "Animate live status" (lib/settings/live-motion-settings.ts): the breathing
 * status dots and row bands cost a steady share of GPU while a session is
 * live, so the motion is the user's to tone down.
 */
function LiveMotionRow() {
  const { motion } = useLiveMotionSettings();
  return (
    <div className="flex items-center gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <label
          htmlFor="live-motion"
          className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground"
        >
          Animate live status
        </label>
        <p className="text-xs leading-relaxed text-foreground-subtle">
          How the dots and row highlights of live sessions move. Reduced pulses a few times when a
          session starts working or starts waiting on you, then holds still - the colour keeps
          showing the state. Always breathes for as long as a session is live and uses noticeably
          more power.
        </p>
      </div>
      <div className="relative w-[150px] shrink-0">
        <select
          id="live-motion"
          value={motion}
          onChange={(e) => updateLiveMotionSettings({ motion: e.target.value as LiveMotion })}
          className="h-8 w-full appearance-none rounded-md border border-border bg-input pl-2.5 pr-8 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          {LIVE_MOTION_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-muted" />
      </div>
    </div>
  );
}
