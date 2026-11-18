import {
  Archive,
  FileCode,
  FolderGit2,
  FolderKanban,
  FolderTree,
  Keyboard,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * The settings dialog's section list. Core's sections are listed here; the
 * extension registers its own (`settingsSections`), so a section id is core's
 * or any string a registered section carries - a deep link to a section this
 * build does not show opens General. Kept in this data-only module (rather
 * than settings-dialog.tsx) so that component file exports only a component -
 * the react-refresh lint rule - while the Search Everywhere palette can still
 * import the sections to offer them as navigation targets.
 */

/** Core's own sections. */
export type CoreSectionId =
  'general' | 'projects' | 'worktrees' | 'sessions' | 'terminal' | 'editor' | 'files' | 'shortcuts';

/** A section id: core's, or one the extension registered. */
export type SectionId = CoreSectionId | (string & {});

export type SettingsSection = {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Still an experiment: the nav row and the header carry a flask. */
  experimental?: boolean;
};

const ALL_SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    description: 'General preferences.',
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    description:
      'A color per project - its folder in the Projects list, its avatar and, while it is open, the accent color.',
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    icon: FolderGit2,
    description:
      'What a new session’s git worktree gets before the agent starts - per project: the ignored files it needs and the command that sets it up.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: Archive,
    description:
      'What happens to running sessions when double0 quits, when quiet sessions are archived, and when the archive is cleared.',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: SquareTerminal,
    description: 'Color theme, font, and text rendering for the built-in terminal.',
  },
  {
    id: 'editor',
    label: 'Editor',
    icon: FileCode,
    description: 'Color theme, font, syntax colors and language servers for the code editor.',
  },
  {
    id: 'files',
    label: 'File explorer',
    icon: FolderTree,
    description: 'Font for the file explorer tree.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: Keyboard,
    description: 'Add your own keybindings for the actions below.',
  },
];

/**
 * General leads (the dialog draws a divider under it); every other section
 * follows alphabetically by label, so a new section needs no placement call.
 */
export function orderSections(sections: SettingsSection[]): SettingsSection[] {
  const general = sections.filter((s) => s.id === 'general');
  const rest = sections
    .filter((s) => s.id !== 'general')
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return [...general, ...rest];
}

/**
 * Every section this build shows: core's plus the ones the extension
 * registered, in nav order. A function, never a module constant - the
 * registry is installed after every module has loaded.
 */
export function settingsSections(): SettingsSection[] {
  return orderSections([...ALL_SECTIONS, ...(rendererExtension().settingsSections ?? [])]);
}
