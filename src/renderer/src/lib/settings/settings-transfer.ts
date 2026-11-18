import { z } from 'zod';
import {
  getAccentColor,
  getProjectAccentEnabled,
  updateAccentColor,
  updateProjectAccentEnabled,
} from '@renderer/lib/settings/accent-color';
import {
  getTerminalSettings,
  updateTerminalSettings,
  type TerminalSettings,
} from '@renderer/lib/settings/terminal-settings';
import {
  getEditorSettings,
  updateEditorSettings,
  type EditorSettings,
} from '@renderer/lib/settings/editor-settings';
import { appFontSettings, explorerFontSettings } from '@renderer/lib/settings/ui-font-settings';
import {
  getShortcutOverrides,
  importShortcutOverrides,
} from '@renderer/lib/settings/keyboard-shortcuts';
import {
  getDismissedLanguagePrompts,
  importDismissedLanguagePrompts,
} from '@renderer/lib/language-server-store';
import {
  getSessionTemplateSettings,
  importSessionTemplateSettings,
} from '@renderer/lib/session/templates';
import {
  decodeFlag,
  dockToolDocField,
  dockToolStorageKey,
  decodeDockPanels,
  decodeDockWidth,
} from '@renderer/lib/workspace/dock-state';
import { resolveStoredTheme, THEME_STORAGE_KEY } from '@renderer/lib/settings/theme';
import { emitSettingsApplied } from '@renderer/lib/settings/settings-events';
import { projectSchema, agentSessionSchema } from '@renderer/lib/collections';
import { rendererExtension } from '@renderer/lib/extension/registry';
import type { SettingsDocSection } from '@renderer/lib/extension/types';
import { LOCAL_OWNER } from '@renderer/lib/local-user';
import {
  getLiveMotionSettings,
  updateLiveMotionSettings,
  type LiveMotion,
} from '@renderer/lib/settings/live-motion-settings';
import {
  getHoverScrollSettings,
  updateHoverScrollSettings,
} from '@renderer/lib/settings/hover-scroll-settings';
import {
  getSessionCleanupSettings,
  updateSessionCleanupSettings,
  type SessionCleanupSettings,
} from '@renderer/lib/settings/session-cleanup-settings';
import {
  getSessionDaemonSettings,
  updateSessionDaemonSettings,
} from '@renderer/lib/settings/session-daemon-settings';
import { getVerticalTabs, setVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import { getRailOrder, setRailOrder } from '@renderer/lib/rail-order';

/**
 * Settings-as-data + export/import (Settings → General).
 *
 * One typed document covers every user-tweakable setting; it backs both the
 * JSON settings editor and the export file. The export file additionally
 * carries the database content worth moving between machines (projects,
 * sessions, per-session workspace layouts) and the extension's own sections
 * (`RendererExtension.dataTransfer`). Validation is zod end-to-end so a
 * hand-edited file fails with names, not crashes.
 *
 * An extension adds its own sections to the settings document
 * (`SettingsDocSection` - Pro's Settings › Integrations choices, never their
 * credentials) and to the export file (`RendererExtension.dataTransfer`).
 *
 * Deliberately NOT in the document:
 *  - Installed language servers (binaries in app storage). The *choice* the
 *    Editor section persists - dismissed install prompts - does travel, as
 *    `languages.dismissedPrompts`.
 *  - Per-path UI memory that means nothing on another machine: the file
 *    explorer's expanded folders and the last-opened session per project.
 *
 * Adding a setting? It needs a schema field here, a line in `collectAppSettings`
 * and one in `applyAppSettings` - new fields are `.optional()` so files written
 * by older builds keep importing (absent = keep the current value).
 */

const HEX = /^#[0-9a-f]{6}$/i;
const hexColor = z.string().regex(HEX, 'must be a #rrggbb color');

// --- The settings document -----------------------------------------------------

// Family + size for one UI surface (File explorer / Changes); null size =
// follow the app size. Optional in the document so exports from before these
// settings existed still import cleanly.
const surfaceFontSchema = z.object({
  fontFamily: z.string(),
  fontSize: z.number().nullable(),
});

// One rebound shortcut. `key` is a KeyboardEvent.code; the modifier flags are
// optional (absent = false). See lib/keyboard-shortcuts.ts.
const shortcutComboSchema = z.object({
  key: z.string(),
  mod: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  shift: z.boolean().optional(),
  alt: z.boolean().optional(),
});

/** The workspace section's own fields (an extension tool's flags ride beside them). */
const workspaceShape = {
  dockPanels: z.array(z.enum(['projects', 'sessions', 'tabs'])),
  // An extension rail tool's open flag rides as `<tool>Open` (dockToolDocField),
  // kept by `keepToolFlags` below - absent (an older export, a build without
  // the tool) = keep current.
  dockWidth: z.number(),
  // No explorerOpen: the explorer is remembered per session now
  // (lib/workspace/explorer-open.ts, machine-local). An older export's
  // global flag is stripped on validate.
  explorerWidth: z.number(),
  // No projectRailCollapsed: the project page and its rail are gone
  // (a private plan). An older export's flag is stripped on
  // validate.
  // The per-session changes drawer's width (px) - shared across sessions, like
  // the sidebars above. Optional (absent in older exports → keep current).
  changesDrawerWidth: z.number().optional(),
  // Optional (absent in older exports → keep current): the bottom panel's
  // open state and the session sidebar's Archived group.
  commandsOpen: z.boolean().optional(),
  archivedOpen: z.boolean().optional(),
  // Torn-off session windows keep their own sidebar widths (px), separate
  // from the main window's dockWidth/explorerWidth above.
  detachedDockWidth: z.number().optional(),
  detachedExplorerWidth: z.number().optional(),
  detachedChangesDrawerWidth: z.number().optional(),
  // Optional (absent in older exports → keep current): open tabs listed in a
  // dock panel instead of the horizontal tab strip.
  verticalTabs: z.boolean().optional(),
  // Optional (absent in older exports → keep current): the icon rail's tool
  // order - the top cluster + the bottom one next to the Commands toggle.
  // Loose strings so an export from a newer build validates; the store drops
  // ids it doesn't know.
  railOrder: z.object({ top: z.array(z.string()), bottom: z.array(z.string()) }).optional(),
};

/**
 * The workspace section's extra keys, kept only as an extension rail tool's
 * `<tool>Open` flag (a boolean, for a tool this build has): everything else an
 * older export carried (a global `explorerOpen`, say) is dropped, as zod drops
 * an unknown key.
 */
function keepToolFlags<T extends Record<string, unknown>>(workspace: T): T {
  const flags = new Set(rendererExtension().railTools.map((t) => dockToolDocField(t.id)));
  const known = new Set(Object.keys(workspaceShape));
  return Object.fromEntries(
    Object.entries(workspace).filter(
      ([key, value]) => known.has(key) || (flags.has(key) && typeof value === 'boolean'),
    ),
  ) as T;
}

export const appSettingsSchema = z.object({
  appearance: z.object({
    theme: z.enum(['dark', 'light']),
    /** App-wide font family id ('default' = built-in fonts). */
    fontFamily: z.string().optional(),
    /** Base size for the size-aware surfaces (null = their built-in sizes). */
    fontSize: z.number().nullable().optional(),
    /** App accent color (#rrggbb); every primary-green token derives from it. */
    accentColor: hexColor.optional(),
    /** An open project with a color of its own paints the accent with it. */
    projectAccent: z.boolean().optional(),
  }),
  explorer: surfaceFontSchema.optional(),
  terminal: z.object({
    themeId: z.string(),
    // Optional so exports from before the per-mode "auto" choices import
    // cleanly (absent = the store's defaults; it validates the values).
    autoDark: z.string().optional(),
    autoLight: z.string().optional(),
    custom: z.object({
      background: hexColor,
      foreground: hexColor,
      cursor: hexColor,
      selection: hexColor,
      ansi: z.array(hexColor),
    }),
    fontFamily: z.string(),
    fontSize: z.number(),
    lineHeight: z.number(),
    // Optional so exports from before these settings import cleanly
    // (absent = keep current; the store clamps the value).
    scrollback: z.number().optional(),
    scrollSpeed: z.number().optional(),
    shellIntegration: z.boolean().optional(),
    // The store validates it (an unknown engine reads as xterm.js).
    engine: z.string().optional(),
  }),
  editor: z.object({
    themeId: z.string(),
    custom: z.object({
      background: hexColor,
      foreground: hexColor,
      cursor: hexColor,
      selection: hexColor,
      syntax: z.array(hexColor),
    }),
    fontFamily: z.string(),
    fontSize: z.number(),
    lineHeight: z.number(),
  }),
  workspace: z.object(workspaceShape).catchall(z.unknown()).transform(keepToolFlags),
  // New Session dialog templates: the user's saved templates plus which deletable
  // built-ins they removed. Optional so older exports import cleanly.
  sessionTemplates: z
    .object({
      user: z.array(z.object({ id: z.string(), name: z.string(), startCommand: z.string() })),
      hiddenBuiltins: z.array(z.string()),
    })
    .optional(),
  // Custom keyboard shortcuts: only the commands the user rebound (combo, or
  // null = unbound). Optional + loose keys so older exports import cleanly and a
  // future command id round-trips without failing validation.
  shortcuts: z.record(z.string(), shortcutComboSchema.nullable()).optional(),
  // Settings → Editor → "Editor prompts": the languages whose install banner the
  // user dismissed with "Don't ask again". The installed servers themselves are
  // binaries in app storage, so they are deliberately NOT part of the document -
  // only this choice is. Optional so older exports import cleanly.
  languages: z.object({ dismissedPrompts: z.array(z.string()) }).optional(),
  // Settings → Sessions: auto-archive + auto-delete rules. Optional so older
  // exports import cleanly; amounts and units are loose (the store clamps and
  // sanitizes them).
  sessionCleanup: z
    .object({
      autoArchive: z.boolean(),
      archiveAfter: z.object({ amount: z.number(), unit: z.string() }),
      autoDelete: z.boolean(),
      deleteAfter: z.object({ amount: z.number(), unit: z.string() }),
      removeWorktree: z.boolean(),
    })
    .optional(),
  // Settings → Sessions → After quit: keep sessions running after quit
  // (a private plan). Optional so older exports import cleanly.
  sessionDaemon: z.object({ keepRunning: z.boolean() }).optional(),
  // Settings → General → "Animate live status". Optional so older exports
  // import cleanly.
  liveMotion: z.object({ motion: z.enum(['always', 'change', 'off']) }).optional(),
  // Settings → General → "Scroll long names on hover". Optional so older
  // exports import cleanly.
  hoverScroll: z.object({ enabled: z.boolean() }).optional(),
  // Legacy: saved run-commands used to be a single global list here. They now live
  // in the database, scoped per project (see lib/saved-commands), so this field is
  // no longer exported or imported - kept optional only so older export files still
  // validate.
  savedCommands: z
    .array(z.object({ id: z.string(), name: z.string(), command: z.string() }))
    .optional(),
});

/**
 * The document: core's settings, plus each extension section under its own
 * key (`SettingsDocSection` - Pro's integrations), validated by its schema.
 */
export type AppSettingsDoc = z.infer<typeof appSettingsSchema> & { [section: string]: unknown };

/** The extension's sections of the document - read at call time, never at module load. */
function extensionSections(): SettingsDocSection[] {
  const extension = rendererExtension();
  const integrations = extension.integrations?.settings;
  return [...(extension.settingsDocSections ?? []), ...(integrations ? [integrations] : [])];
}

/** Resolves once every extension section can be collected (the JSON editor and export await it). */
export function ensureSettingsSectionsLoaded(): Promise<void> {
  return Promise.all(extensionSections().map((section) => section.ensureLoaded())).then(
    () => undefined,
  );
}

// Workspace-chrome storage keys (the same ones the host/components persist to).
const KEYS = {
  dockPanels: 'double0-workspace-dock-panels',
  dockWidth: 'double0-workspace-dock-width',
  explorerWidth: 'double0-workspace-explorer-width',
  commandsOpen: 'double0-workspace-commands-open',
  archivedOpen: 'double0-sidebar-archived-open',
  detachedDockWidth: 'double0-detached-dock-width',
  detachedExplorerWidth: 'double0-detached-explorer-width',
  detachedChangesDrawerWidth: 'double0-detached-session-changes-width',
  changesDrawerWidth: 'double0-session-changes-width',
} as const;

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Mirrors the explorer-width decode in workspace-surface.tsx. */
function decodeExplorerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return 240;
  return Math.min(480, Math.max(180, width));
}

/** Mirrors the changes-drawer width decode in workspace-surface.tsx. */
function decodeChangesDrawerWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return 360;
  return Math.min(640, Math.max(280, width));
}

/**
 * Snapshot every app setting as one editable document. Synchronous: every
 * store is either localStorage or an already-seeded in-memory mirror.
 */
export function collectAppSettings(): AppSettingsDoc {
  const doc: AppSettingsDoc = {
    appearance: {
      theme: resolveStoredTheme(),
      accentColor: getAccentColor(),
      projectAccent: getProjectAccentEnabled(),
      ...appFontSettings.get(),
    },
    explorer: explorerFontSettings.get(),
    terminal: getTerminalSettings(),
    editor: getEditorSettings(),
    workspace: {
      dockPanels: decodeDockPanels(read(KEYS.dockPanels)),
      ...Object.fromEntries(
        rendererExtension().railTools.map((t) => [
          dockToolDocField(t.id),
          decodeFlag(read(dockToolStorageKey(t.id))),
        ]),
      ),
      dockWidth: decodeDockWidth(read(KEYS.dockWidth)),
      explorerWidth: decodeExplorerWidth(read(KEYS.explorerWidth)),
      commandsOpen: read(KEYS.commandsOpen) === '1',
      archivedOpen: read(KEYS.archivedOpen) !== '0',
      // Same decode as the main window's widths (defaults + clamps match the
      // detached-window component's).
      detachedDockWidth: decodeDockWidth(read(KEYS.detachedDockWidth)),
      detachedExplorerWidth: decodeExplorerWidth(read(KEYS.detachedExplorerWidth)),
      detachedChangesDrawerWidth: decodeChangesDrawerWidth(read(KEYS.detachedChangesDrawerWidth)),
      changesDrawerWidth: decodeChangesDrawerWidth(read(KEYS.changesDrawerWidth)),
      verticalTabs: getVerticalTabs(),
      railOrder: getRailOrder(),
    },
    sessionTemplates: getSessionTemplateSettings(),
    shortcuts: getShortcutOverrides(),
    sessionCleanup: getSessionCleanupSettings(),
    sessionDaemon: getSessionDaemonSettings(),
    liveMotion: getLiveMotionSettings(),
    hoverScroll: getHoverScrollSettings(),
    languages: { dismissedPrompts: getDismissedLanguagePrompts() },
  };
  for (const section of extensionSections()) {
    const value = section.collect();
    if (value !== undefined) doc[section.key] = value;
  }
  return doc;
}

/** Zod issues → readable "path - message" lines. */
export function issueLines(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${prefix}${path || '(document)'} - ${issue.message}`;
  });
}

export function validateAppSettings(
  raw: unknown,
): { doc: AppSettingsDoc; errors?: undefined } | { doc?: undefined; errors: string[] } {
  const parsed = appSettingsSchema.safeParse(raw);
  if (!parsed.success) return { errors: issueLines(parsed.error) };
  const doc: AppSettingsDoc = parsed.data;
  const errors: string[] = [];
  // Each extension section validates itself; one absent = keep. A section no
  // extension here reads (another edition's) is dropped, like any unknown key.
  for (const section of extensionSections()) {
    const value = (raw as Record<string, unknown>)[section.key];
    if (value === undefined) continue;
    const checked = section.schema.safeParse(value);
    if (checked.success) doc[section.key] = checked.data;
    else errors.push(...issueLines(checked.error, `${section.key}.`));
  }
  return errors.length > 0 ? { errors } : { doc };
}

/**
 * Write a validated settings document into every store. The terminal/editor
 * stores sanitize + fan out live themselves; the localStorage-backed chrome
 * settings live-apply via the SETTINGS_APPLIED_EVENT listeners.
 */
export function applyAppSettings(doc: AppSettingsDoc): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, doc.appearance.theme);
    window.localStorage.setItem(KEYS.dockPanels, JSON.stringify(doc.workspace.dockPanels));
    for (const tool of rendererExtension().railTools) {
      const open = (doc.workspace as Record<string, unknown>)[dockToolDocField(tool.id)];
      if (typeof open === 'boolean') {
        window.localStorage.setItem(dockToolStorageKey(tool.id), open ? '1' : '0');
      }
    }
    window.localStorage.setItem(KEYS.dockWidth, String(doc.workspace.dockWidth));
    window.localStorage.setItem(KEYS.explorerWidth, String(doc.workspace.explorerWidth));
    if (doc.workspace.commandsOpen !== undefined) {
      window.localStorage.setItem(KEYS.commandsOpen, doc.workspace.commandsOpen ? '1' : '0');
    }
    if (doc.workspace.archivedOpen !== undefined) {
      window.localStorage.setItem(KEYS.archivedOpen, doc.workspace.archivedOpen ? '1' : '0');
    }
    if (doc.workspace.detachedDockWidth !== undefined) {
      window.localStorage.setItem(KEYS.detachedDockWidth, String(doc.workspace.detachedDockWidth));
    }
    if (doc.workspace.detachedExplorerWidth !== undefined) {
      window.localStorage.setItem(
        KEYS.detachedExplorerWidth,
        String(doc.workspace.detachedExplorerWidth),
      );
    }
    if (doc.workspace.detachedChangesDrawerWidth !== undefined) {
      window.localStorage.setItem(
        KEYS.detachedChangesDrawerWidth,
        String(doc.workspace.detachedChangesDrawerWidth),
      );
    }
    if (doc.workspace.changesDrawerWidth !== undefined) {
      window.localStorage.setItem(
        KEYS.changesDrawerWidth,
        String(doc.workspace.changesDrawerWidth),
      );
    }
  } catch {
    // Unwritable storage - the live stores below still apply for this session.
  }
  // These sanitize internally (clamp sizes, validate ids) and notify live views.
  // The font fields are optional (older exports lack them) - absent means keep.
  const { fontFamily, fontSize } = doc.appearance;
  if (fontFamily !== undefined || fontSize !== undefined) {
    appFontSettings.update({
      ...(fontFamily !== undefined && { fontFamily }),
      ...(fontSize !== undefined && { fontSize }),
    });
  }
  // Absent in older exports → keep the current accent.
  if (doc.appearance.accentColor !== undefined) updateAccentColor(doc.appearance.accentColor);
  if (doc.appearance.projectAccent !== undefined)
    updateProjectAccentEnabled(doc.appearance.projectAccent);
  if (doc.explorer) explorerFontSettings.update(doc.explorer);
  updateTerminalSettings(doc.terminal as TerminalSettings);
  updateEditorSettings(doc.editor as EditorSettings);
  // Absent in older exports → keep current templates; present → replace.
  if (doc.sessionTemplates !== undefined) importSessionTemplateSettings(doc.sessionTemplates);
  // Absent in older exports → keep current bindings; `{}` → reset to defaults.
  if (doc.shortcuts !== undefined) importShortcutOverrides(doc.shortcuts);
  // Absent in older exports → keep the current rules.
  if (doc.sessionCleanup) {
    updateSessionCleanupSettings(doc.sessionCleanup as Partial<SessionCleanupSettings>);
  }
  // Absent in older exports → keep the current choice.
  if (doc.sessionDaemon) updateSessionDaemonSettings(doc.sessionDaemon);
  // Absent in older exports → keep the current choice.
  if (doc.liveMotion) updateLiveMotionSettings({ motion: doc.liveMotion.motion as LiveMotion });
  // Absent in older exports → keep the current choice.
  if (doc.hoverScroll) updateHoverScrollSettings(doc.hoverScroll);
  // Absent in older exports → keep the current choice.
  if (doc.workspace.verticalTabs !== undefined) setVerticalTabs(doc.workspace.verticalTabs);
  // Absent in older exports → keep the current rail layout. The store
  // sanitizes (drops unknown ids, restores missing tools to the top cluster).
  if (doc.workspace.railOrder !== undefined) setRailOrder(doc.workspace.railOrder);
  // Absent in older exports → keep the current dismissals; `[]` → ask again.
  if (doc.languages !== undefined) importDismissedLanguagePrompts(doc.languages.dismissedPrompts);
  // Each extension section: absent → keep.
  for (const section of extensionSections()) {
    if (doc[section.key] !== undefined) section.apply(doc[section.key]);
  }
  // `savedCommands` is legacy (now per-project DB rows) - ignored on import.
  emitSettingsApplied();
}

// --- The export document ---------------------------------------------------------

export const EXPORT_FORMAT = 'double0-export';
export const EXPORT_VERSION = 1;
export const EXPORT_FILE_NAME = 'double0-export.json';

// Loose: the extension's sections (and those of a build with more of them)
// ride along as unknown keys; the extension validates its own.
const exportEnvelopeSchema = z.looseObject({
  format: z.literal(EXPORT_FORMAT, { error: 'not a double0 export file' }),
  version: z.number(),
  exportedAt: z.string().optional(),
  settings: z.unknown().optional(),
  projects: z.array(z.unknown()).optional(),
  sessions: z.array(z.unknown()).optional(),
  sessionLayouts: z
    .array(z.object({ sessionId: z.string().uuid(), layout: z.unknown() }))
    .optional(),
});

/** The keys core writes and reads itself. */
const CORE_SECTIONS = new Set(Object.keys(exportEnvelopeSchema.shape));

export type ExportEnvelope = z.infer<typeof exportEnvelopeSchema>;

/** Parse + structurally validate an export file's text. */
export function parseExportDocument(
  content: string,
): { doc: ExportEnvelope; errors?: undefined } | { doc?: undefined; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { errors: [`Not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`] };
  }
  const parsed = exportEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { errors: issueLines(parsed.error) };
  if (parsed.data.version > EXPORT_VERSION) {
    return {
      errors: [`This file is from a newer app (export version ${parsed.data.version}).`],
    };
  }
  return { doc: parsed.data };
}

/** Validate one exported project row; ownership is rewritten to this machine. */
export function prepareProjectRow(
  raw: unknown,
  index: number,
): { row: z.infer<typeof projectSchema>; error?: undefined } | { row?: undefined; error: string } {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const name = (raw as { name?: unknown } | null)?.name;
    const label = typeof name === 'string' ? `“${name}”` : `#${index + 1}`;
    return { error: `project ${label}: ${issueLines(parsed.error).join('; ')}` };
  }
  return { row: { ...parsed.data, ownerId: LOCAL_OWNER } };
}

/** Validate one exported session row (ownership rewritten like projects). */
export function prepareSessionRow(
  raw: unknown,
  index: number,
):
  | { row: z.infer<typeof agentSessionSchema>; error?: undefined }
  | { row?: undefined; error: string } {
  const parsed = agentSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const label = (raw as { label?: unknown } | null)?.label;
    const name = typeof label === 'string' ? `“${label}”` : `#${index + 1}`;
    return { error: `session ${name}: ${issueLines(parsed.error).join('; ')}` };
  }
  return { row: { ...parsed.data, ownerId: LOCAL_OWNER } };
}

/** Gather settings + database content into the export file's pretty JSON. */
export async function buildExportDocument(): Promise<string> {
  const [projects, sessions, layouts, extension] = await Promise.all([
    window.api.db.list('projects'),
    window.api.db.list('agent_sessions'),
    window.api.layout.list(),
    rendererExtension().dataTransfer?.collect() ?? Promise.resolve({}),
    // The settings snapshot below is synchronous; make sure the extension's
    // sections (the integrations mirror) have been seeded first, or an export
    // taken right after launch would silently omit them.
    ensureSettingsSectionsLoaded(),
  ]);
  const doc = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: collectAppSettings(),
    projects,
    sessions,
    ...extension,
    sessionLayouts: layouts,
  };
  return JSON.stringify(doc, null, 2);
}

// --- Import ------------------------------------------------------------------------

export type ImportResult = {
  /** File-level failure: nothing was imported. */
  fatal?: string[];
  settings: 'applied' | 'invalid' | 'none';
  projectsCreated: number;
  projectsUpdated: number;
  sessionsCreated: number;
  sessionsUpdated: number;
  layoutsSaved: number;
  /** What the extension's sections imported (`RendererExtension.dataTransfer`). */
  extension: { counts: Record<string, number>; summary: string[] };
  /** Sections of the file this build reads nobody for (another edition's data). */
  skippedSections: string[];
  /** Per-item problems (those items were skipped; the rest imported). */
  errors: string[];
};

/**
 * Import an export file: apply its settings, then upsert projects and sessions
 * into the local database (matched by id; ownership rewritten to this machine)
 * and restore per-session workspace layouts. Item-level problems are collected
 * and reported; they never abort the rest of the import.
 */
export async function importDocument(content: string): Promise<ImportResult> {
  const result: ImportResult = {
    settings: 'none',
    projectsCreated: 0,
    projectsUpdated: 0,
    sessionsCreated: 0,
    sessionsUpdated: 0,
    layoutsSaved: 0,
    extension: { counts: {}, summary: [] },
    skippedSections: [],
    errors: [],
  };

  const parsed = parseExportDocument(content);
  if (parsed.errors) return { ...result, fatal: parsed.errors };
  const doc = parsed.doc;

  // Settings first - invalid settings don't block the data import.
  if (doc.settings !== undefined) {
    const settings = validateAppSettings(doc.settings);
    if (settings.doc) {
      applyAppSettings(settings.doc);
      result.settings = 'applied';
    } else {
      result.settings = 'invalid';
      result.errors.push(...settings.errors.map((e) => `settings: ${e}`));
    }
  }

  const db = window.api.db;

  // Projects: upsert by id.
  const existingProjects = new Set(
    ((await db.list('projects')) as { id: string }[]).map((p) => p.id),
  );
  for (const [index, raw] of (doc.projects ?? []).entries()) {
    const { row, error } = prepareProjectRow(raw, index);
    if (!row) {
      result.errors.push(error);
      continue;
    }
    try {
      if (existingProjects.has(row.id)) {
        const { id, ...patch } = row;
        await db.update('projects', id, patch);
        result.projectsUpdated++;
      } else {
        await db.insert('projects', row);
        existingProjects.add(row.id);
        result.projectsCreated++;
      }
    } catch (err) {
      result.errors.push(
        `project “${row.name}”: ${err instanceof Error ? err.message : 'database error'}`,
      );
    }
  }

  // Sessions: upsert by id; a session pointing at a project that exists neither
  // locally nor in the file is skipped (the insert would break the FK anyway).
  const existingSessions = new Set(
    ((await db.list('agent_sessions')) as { id: string }[]).map((s) => s.id),
  );
  for (const [index, raw] of (doc.sessions ?? []).entries()) {
    const { row, error } = prepareSessionRow(raw, index);
    if (!row) {
      result.errors.push(error);
      continue;
    }
    if (row.projectId != null && !existingProjects.has(row.projectId)) {
      result.errors.push(`session “${row.label}”: its project ${row.projectId} doesn’t exist`);
      continue;
    }
    try {
      if (existingSessions.has(row.id)) {
        const { id, ...patch } = row;
        await db.update('agent_sessions', id, patch);
        result.sessionsUpdated++;
      } else {
        await db.insert('agent_sessions', row);
        existingSessions.add(row.id);
        result.sessionsCreated++;
      }
    } catch (err) {
      result.errors.push(
        `session “${row.label}”: ${err instanceof Error ? err.message : 'database error'}`,
      );
    }
  }

  // The extension's sections, now that the projects and sessions they point
  // at exist. Any other section of the file is another edition's data.
  const transfer = rendererExtension().dataTransfer;
  if (transfer) {
    const applied = await transfer.apply(doc, { existingProjects, existingSessions });
    result.extension = { counts: applied.counts, summary: applied.summary };
    result.errors.push(...applied.errors);
  }
  const known = new Set([...CORE_SECTIONS, ...(transfer?.sections ?? [])]);
  result.skippedSections = Object.keys(doc).filter((key) => {
    const value = (doc as Record<string, unknown>)[key];
    return !known.has(key) && Array.isArray(value) && value.length > 0;
  });

  // Workspace layouts (tabs/splits per session) - only for sessions that exist
  // now; the save is fire-and-forget by design.
  for (const entry of doc.sessionLayouts ?? []) {
    if (!existingSessions.has(entry.sessionId)) {
      result.errors.push(`layout for unknown session ${entry.sessionId} skipped`);
      continue;
    }
    window.api.layout.save(entry.sessionId, entry.layout);
    result.layoutsSaved++;
  }

  return result;
}
