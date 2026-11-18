import { Braces, ChevronDown, FileCode, FolderOpen } from 'lucide-react';
import {
  EXPLORER_BASE_FONT_SIZE,
  UI_FONT_FAMILIES,
  explorerFontSettings,
} from '@renderer/lib/settings/ui-font-settings';
import {
  FontFamilyField,
  FontSizeField,
} from '@renderer/routes/_app/-components/settings/settings-controls';
import { useResolvedSurfaceFont } from '@renderer/routes/_app/-components/settings/settings-form';

/** Settings → File explorer: font family + size for the tree. */
export function FilesSettingsSection() {
  const settings = explorerFontSettings.useValue();
  const preview = useResolvedSurfaceFont(settings, EXPLORER_BASE_FONT_SIZE);

  // min-h-full (not h-full): fills the pane so the preview can stretch, yet
  // still grows with taller content - an exact-height root would make children
  // overflow it and swallow the scroll container's bottom padding.
  return (
    <div className="flex min-h-full flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Font
        </h3>
        <div className="flex gap-2.5">
          <FontFamilyField
            value={settings.fontFamily}
            options={UI_FONT_FAMILIES}
            defaultLabel="App font"
            onChange={(fontFamily) => explorerFontSettings.update({ fontFamily })}
          />
          <FontSizeField
            value={settings.fontSize}
            defaultLabel="App size"
            onChange={(fontSize) => explorerFontSettings.update({ fontSize })}
          />
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
          “App font” / “App size” follow the application font from General; picking a value
          overrides it for the file tree only.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
          Preview
        </h3>
        <div
          className="flex flex-col overflow-hidden rounded-md border border-border bg-surface py-1.5"
          style={{ fontFamily: preview.css, fontSize: preview.size }}
        >
          <div className="flex h-[calc(1em_+_14px)] items-center gap-1.5 px-3 font-semibold text-foreground">
            <ChevronDown className="size-[1em] shrink-0 text-foreground-muted" />
            <FolderOpen className="size-[1em] shrink-0 text-primary" />
            src
          </div>
          <div className="flex h-[calc(1em_+_14px)] items-center gap-1.5 pl-7 pr-3 text-foreground">
            <FileCode className="size-[1em] shrink-0 text-[#60a5fa]" />
            <span className="min-w-0 flex-1 truncate">main.tsx</span>
            <span className="text-[length:calc(1em_-_2px)] font-semibold text-warning">M</span>
          </div>
          <div className="flex h-[calc(1em_+_14px)] items-center gap-1.5 pl-7 pr-3 text-foreground-muted">
            <Braces className="size-[1em] shrink-0 text-[#fbbf24]" />
            <span className="min-w-0 flex-1 truncate">package.json</span>
          </div>
        </div>
      </section>
    </div>
  );
}
