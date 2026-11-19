import { Fragment, useEffect, useState } from 'react';
import { ChevronLeft, FlaskConical, X, type LucideIcon } from 'lucide-react';
import {
  settingsSections,
  type SectionId,
} from '@renderer/routes/_app/-components/settings/settings-sections';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { cn } from '@renderer/lib/utils';
import { GeneralSettingsSection } from '@renderer/routes/_app/-components/settings/general-section';
import { ProjectsSettingsSection } from '@renderer/routes/_app/-components/settings/projects-section';
import { WorktreesSettingsSection } from '@renderer/routes/_app/-components/settings/worktrees-section';
import {
  SettingsHeaderContext,
  type SettingsHeader,
} from '@renderer/routes/_app/-components/settings/settings-header';
import { TerminalSettingsSection } from '@renderer/routes/_app/-components/settings/terminal-section';
import { EditorSettingsSection } from '@renderer/routes/_app/-components/settings/editor-section';
import { FilesSettingsSection } from '@renderer/routes/_app/-components/settings/files-section';
import { ShortcutsSettingsSection } from '@renderer/routes/_app/-components/settings/shortcuts-section';
import { SessionsSettingsSection } from '@renderer/routes/_app/-components/settings/sessions-section';

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section to show when (re)opened - lets the Search Everywhere palette deep-link. */
  initialSection?: SectionId;
}) {
  const [section, setSection] = useState<SectionId>(initialSection ?? 'general');
  // A section that opened a sub-screen (Worktrees → project) replaces the title
  // block with what it opened; switching sections drops the override.
  const [headerOverride, setHeaderOverride] = useState<SettingsHeader | null>(null);
  useEffect(() => setHeaderOverride(null), [section]);
  const heading = headerOverride ?? null;
  const sections = settingsSections();
  // A section this build does not show (a Pro section's deep link in the core
  // build) opens General.
  const active = sections.find((s) => s.id === section) ?? sections[0];
  const ProBody = rendererExtension().settingsSections?.find((s) => s.id === active.id)?.Body;

  // Deep-link: jump to the requested section when opened (or when it changes
  // while already open). Harmless for the gear button, which passes none.
  useEffect(() => {
    if (open && initialSection) setSection(initialSection);
  }, [open, initialSection]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(640px,85vh)] max-w-[780px] flex-row gap-0 overflow-hidden p-0"
      >
        <nav className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface">
          <DialogTitle className="px-4 pb-3.5 pt-[18px] text-[length:calc(15px*var(--ui-font-scale,1))] font-semibold tracking-[-0.1px]">
            Settings
          </DialogTitle>
          {/* General leads, divided off; the rest scroll once they outgrow the dialog. */}
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {sections.map((s, i) => {
              const Icon = s.icon;
              const selected = s.id === active.id;
              const divided = s.id === 'general' && i < sections.length - 1;
              return (
                <Fragment key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSection(s.id)}
                    aria-current={selected}
                    className={cn(
                      'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-[length:calc(13px*var(--ui-font-scale,1))] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                      selected
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-foreground hover:bg-muted',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4',
                        selected ? 'text-accent-foreground' : 'text-foreground-muted',
                      )}
                    />
                    {s.label}
                    {s.experimental && <ExperimentalMark className="ml-auto" />}
                  </button>
                  {divided && (
                    <div role="separator" className="mx-1 my-1.5 h-px shrink-0 bg-border" />
                  )}
                </Fragment>
              );
            })}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border py-[18px] pl-[22px] pr-5">
            <div className="flex min-w-0 flex-col gap-0.5">
              {heading?.back && (
                <button
                  type="button"
                  onClick={heading.back.onClick}
                  className="flex w-fit items-center gap-[3px] text-xs font-medium text-foreground-muted outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                >
                  <ChevronLeft className="size-3" />
                  {heading.back.label}
                </button>
              )}
              <h2 className="flex items-center gap-1.5 text-[length:calc(16px*var(--ui-font-scale,1))] font-semibold text-foreground">
                {heading?.title ?? active.label}
                {active.experimental && <ExperimentalMark />}
              </h2>
              <DialogDescription className="leading-relaxed">
                {heading?.description ?? active.description}
              </DialogDescription>
            </div>
            <DialogClose className="flex size-7 shrink-0 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-[18px]">
            <SettingsHeaderContext.Provider value={setHeaderOverride}>
              {ProBody ? (
                <SlotBoundary key={active.id} name={`settings-${active.id}`}>
                  <ProBody />
                </SlotBoundary>
              ) : active.id === 'general' ? (
                <GeneralSettingsSection />
              ) : active.id === 'projects' ? (
                <ProjectsSettingsSection />
              ) : active.id === 'worktrees' ? (
                <WorktreesSettingsSection />
              ) : active.id === 'sessions' ? (
                <SessionsSettingsSection />
              ) : active.id === 'terminal' ? (
                <TerminalSettingsSection />
              ) : active.id === 'editor' ? (
                <EditorSettingsSection />
              ) : active.id === 'files' ? (
                <FilesSettingsSection />
              ) : active.id === 'shortcuts' ? (
                <ShortcutsSettingsSection />
              ) : (
                <SectionPlaceholder icon={active.icon} label={active.label} />
              )}
            </SettingsHeaderContext.Provider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionPlaceholder({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 rounded-lg border border-border bg-muted p-6">
      <Icon className="size-6 text-foreground-subtle" />
      <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground-muted">
        Coming soon
      </p>
      <p className="text-xs text-foreground-subtle">{label} preferences will live here.</p>
    </div>
  );
}

/** The flask beside an experimental section's name (nav row and header). */
function ExperimentalMark({ className }: { className?: string }) {
  return (
    <span title="Experimental" className={cn('flex shrink-0 text-foreground-muted', className)}>
      <FlaskConical aria-hidden className="size-3.5" />
      <span className="sr-only">Experimental</span>
    </span>
  );
}
