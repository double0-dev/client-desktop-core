import { Folder, FolderOpen } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { PROJECT_COLOR_PRESETS, useAccentColor } from '@renderer/lib/settings/accent-color';
import { cn } from '@renderer/lib/utils';
import { PresetColorPicker } from '@renderer/routes/_app/-components/settings/settings-controls';

/**
 * The project form body (name / destination picker / description / color) shared by the
 * NewProjectDialog and the EditProjectDialog so the two stay in
 * sync. Fully controlled; the dialogs own the state and submit handling.
 */
export function ProjectFormFields({
  idPrefix,
  name,
  onNameChange,
  path,
  onPathChange,
  description,
  onDescriptionChange,
  color,
  onColorChange,
  nameHint,
  onBrowse,
  pathPlaceholder = '~/Code/production-pipeline',
  pathHelp = 'Sessions will be created as folders inside this location.',
}: {
  /** Prefixes the field ids so two dialogs can coexist without id collisions. */
  idPrefix: string;
  name: string;
  onNameChange: (name: string) => void;
  path: string;
  onPathChange: (path: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  /** Null = no color of its own (follows the app accent color). */
  color: string | null;
  onColorChange: (color: string | null) => void;
  /** Optional helper text under the name field (shown when creating). */
  nameHint?: string;
  /** Replaces the native folder dialog (a remote host's folder picker). */
  onBrowse?: () => void;
  pathPlaceholder?: string;
  pathHelp?: string;
}) {
  async function browse() {
    if (onBrowse) {
      onBrowse();
      return;
    }
    try {
      const selected = await window.api?.selectDirectory();
      if (selected) onPathChange(selected);
    } catch (err) {
      console.error('Folder picker failed', err);
    }
  }

  const accent = useAccentColor();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-name`} className="text-xs">
          Project name
        </Label>
        <Input
          id={`${idPrefix}-name`}
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="production-pipeline"
          className="font-mono"
        />
        {nameHint && (
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
            {nameHint}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-destination`} className="text-xs">
            Project destination
          </Label>
          <span className="text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-foreground-subtle">
            Required
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            id={`${idPrefix}-destination`}
            onClick={browse}
            className="flex h-9 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md border border-border bg-input px-3 text-left outline-none transition-colors hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <Folder className="size-3.5 shrink-0 text-primary" />
            <span
              className={cn(
                'min-w-0 truncate font-mono text-[length:calc(13px*var(--ui-font-scale,1))]',
                path ? 'text-foreground' : 'text-foreground-muted',
              )}
            >
              {path || pathPlaceholder}
            </span>
          </button>
          <Button type="button" variant="outline" onClick={browse}>
            <FolderOpen className="size-3.5" />
            Browse
          </Button>
        </div>
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
          {pathHelp}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-description`} className="text-xs">
          Description
        </Label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What this project is for and what the agents are supposed to do…"
          rows={3}
          className="resize-none rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium leading-none text-foreground">Color</span>
        <PresetColorPicker
          presets={PROJECT_COLOR_PRESETS}
          value={color}
          onChange={onColorChange}
          noun="project"
          noneLabel="No color - follows the accent color"
          customFallback={accent}
        />
        <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
          Tints the folder of this project in the Projects list. Without one it uses the accent
          color.
        </p>
      </div>
    </div>
  );
}
