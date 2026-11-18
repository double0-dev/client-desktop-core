import { useMemo } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { projectsCollection } from '@renderer/lib/collections';
import { initialsOf, projectIconStyle } from '@renderer/lib/format';
import { sortProjects } from '@renderer/lib/project-order';
import {
  PROJECT_COLOR_PRESETS,
  updateProjectAccentEnabled,
  useAccentColor,
  useProjectAccentEnabled,
} from '@renderer/lib/settings/accent-color';
import { cn } from '@renderer/lib/utils';
import { PresetColorPicker, SettingToggleRow } from './settings-controls';

/**
 * Settings › Projects: one row per project with its color - the accent presets,
 * a custom color, or none (the project follows the app accent color). The
 * color tints the project's folder in the Projects list and its avatar, and -
 * unless switched off here - is the accent while the project is open.
 */
export function ProjectsSettingsSection() {
  const { data: projects } = useLiveQuery((q) => q.from({ project: projectsCollection }));
  const ordered = useMemo(() => sortProjects(projects ?? []), [projects]);
  const accent = useAccentColor();
  const projectAccent = useProjectAccentEnabled();
  return (
    <div className="flex flex-col gap-6">
      <SettingToggleRow
        title="Use project colors as the accent"
        description="While a project with a color of its own is open, buttons, links and highlights take its color. Off keeps the accent from General everywhere."
        checked={projectAccent}
        onChange={updateProjectAccentEnabled}
      />
      <div className="h-px w-full bg-border" />
      {ordered.length === 0 ? (
        <p className="text-xs text-foreground-subtle">No projects yet.</p>
      ) : (
        <ProjectColorTable projects={ordered} accent={accent} />
      )}
    </div>
  );
}

function ProjectColorTable({
  projects,
  accent,
}: {
  projects: { id: string; name: string; color: string | null }[];
  accent: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
        PROJECT COLORS
      </h3>
      <div className="flex flex-col rounded-md border border-border bg-surface">
        {projects.map((p, i) => (
          <div
            key={p.id}
            role="group"
            aria-label={p.name}
            className={cn('flex items-center gap-2.5 px-3 py-2', i > 0 && 'border-t border-border')}
          >
            <span
              className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[9px] font-bold"
              style={projectIconStyle(p.color)}
            >
              {initialsOf(p.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
              {p.name}
            </span>
            <PresetColorPicker
              presets={PROJECT_COLOR_PRESETS}
              value={p.color}
              onChange={(color) =>
                projectsCollection.update(p.id, (draft) => {
                  draft.color = color;
                })
              }
              noun="project"
              noneLabel="No color - follows the accent color"
              customFallback={accent}
            />
          </div>
        ))}
      </div>
      <p className="text-[length:calc(11.5px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
        A project without a color of its own uses the accent color from General.
      </p>
    </section>
  );
}
