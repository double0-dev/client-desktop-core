import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RailTool } from '@renderer/lib/extension/types';
import { z } from 'zod';
import type { IntegrationsSlot } from '@renderer/lib/extension/types';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  applyAppSettings,
  buildExportDocument,
  collectAppSettings,
  importDocument,
  parseExportDocument,
  prepareProjectRow,
  prepareSessionRow,
  validateAppSettings,
} from '@renderer/lib/settings/settings-transfer';
import { LOCAL_OWNER } from '@renderer/lib/local-user';
import { SETTINGS_APPLIED_EVENT } from '@renderer/lib/settings/settings-events';
import { SETTINGS_STORAGE_KEYS } from '@renderer/lib/settings/settings-reset';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import {
  OTHER_OWNER,
  PROJECT_ID,
  SESSION_ID,
  envelope,
  exportedProject,
  exportedSession,
  fakeDb,
  installFakeApi,
} from './transfer-fixtures';

const VALID_SETTINGS = {
  appearance: { theme: 'dark' },
  terminal: {
    themeId: 'double0-dark',
    custom: {
      background: '#000000',
      foreground: '#e4e4e7',
      cursor: '#a8c945',
      selection: '#3f3f46',
      ansi: ['#111111', '#222222'],
    },
    fontFamily: 'system',
    fontSize: 13,
    lineHeight: 1.2,
  },
  editor: {
    themeId: 'double0-dark',
    custom: {
      background: '#0a0a0a',
      foreground: '#fafafa',
      cursor: '#a8c945',
      selection: '#3f3f46',
      syntax: ['#60a5fa'],
    },
    fontFamily: 'system',
    fontSize: 13,
    lineHeight: 1.5,
  },
  workspace: {
    dockPanels: ['projects', 'sessions'],
    dockWidth: 264,
    explorerWidth: 240,
  },
};

// --- coverage: no setting may quietly skip the document ------------------------

/**
 * Every `double0-*` localStorage key the renderer persists a SETTING under -
 * i.e. everything `collectAppSettings` must snapshot and `applyAppSettings` must
 * write back. Import/export and the JSON settings editor share this document, so
 * a key missing here is a setting that silently doesn't travel between machines.
 * The list itself lives in settings-reset.ts: Reset all settings clears exactly
 * these keys, so the two features can never disagree about what a setting is.
 */
const CARRIED_KEYS: readonly string[] = SETTINGS_STORAGE_KEYS;

/** Persisted, but deliberately machine-local - with the reason it stays behind. */
const MACHINE_LOCAL_KEYS: Record<string, string> = {
  'double0-explorer-tree-state':
    'which folders are expanded, keyed by absolute path - meaningless on another machine',
  'double0-workspace-explorer-sessions':
    'which sessions have the file explorer open - session memory keyed by this machine’s session ids',
  'double0-last-project-session': 'which session was open last per project - session memory',
  'double0-last-project': 'which project was open last - session memory, drives the startup screen',
  'double0-start-fresh':
    'window memory (sessionStorage): the next reload skips restoring the last view - lib/start-fresh.ts',
  'double0-crash-at':
    'window memory (sessionStorage): when the window last hit the error screen - the crash-loop check',
  'double0-repo-choice':
    'which child repo each tool’s picker shows per folder - keyed by this machine’s absolute paths',
  // A project window's own copy of the chrome keys (lib/workspace/project-scope.ts
  // › windowChromeKey, derived at runtime from the shared names above): dock
  // panels / width / overlays / bottom panel / explorer + drawer widths - the
  // same per-window-kind layout memory the `double0-detached-*` keys are for a
  // session window, kept out of the export in v1 (a private plan).
  'double0-project-dock-panels':
    'a project window’s open dock panels - per-window-kind layout memory',
  'double0-project-dock-width': 'a project window’s dock width - per-window-kind layout memory',
  'double0-project-commands-open': 'a project window’s bottom panel - per-window-kind view state',
  'double0-project-explorer-width':
    'a project window’s explorer width - per-window-kind layout memory',
  'double0-project-session-changes-width':
    'a project window’s session-changes drawer width - per-window-kind layout memory',
};

/** `double0-*` literals that are not storage keys at all. */
const NON_STORAGE_LITERALS: Record<string, string> = {
  'double0-settings-applied': 'the SETTINGS_APPLIED_EVENT name',
  'double0-persisted-state-written': 'the usePersistedState cross-instance sync event name',
  'double0-project-': 'the prefix windowChromeKey rewrites a chrome key onto in a project window',
  'double0-open-tool': 'the open-tool-window request event name',
  'double0-accent-overrides': 'id of the injected accent <style> element',
  'double0-export': 'the export file format tag',
  'double0-dark': 'a prebuilt terminal/editor theme id',
  'double0-light': 'a prebuilt terminal/editor theme id',
};

/** Every non-test source file under src/renderer/src. */
function rendererSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rendererSources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('settings coverage', () => {
  it('classifies every double0-* literal in the renderer', () => {
    // The guard that catches the NEXT forgotten setting: a new persisted key
    // fails this test until it is either added to the document (CARRIED_KEYS) or
    // consciously listed as machine-local. Integrations are excluded by living in
    // the main process (OS keychain + files under userData), not localStorage.
    const root = join(process.cwd(), 'src/renderer/src');
    // Pro's renderer too (a private plan): a key that
    // moved there is still a setting the official build persists.
    const pro = join(process.cwd(), 'the official build');
    const files = [...rendererSources(root), ...(existsSync(pro) ? rendererSources(pro) : [])];
    const found = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"`](double0-[a-z0-9-]+)['"`]/g)) {
        found.add(m[1]);
      }
    }
    // Sanity: the scan actually read the sources (a broken path would pass vacuously).
    expect(found.size).toBeGreaterThan(20);
    // Pro's keys are classified beside its code, never named here.
    const proKeys = join(process.cwd(), 'the official build');
    const proKeyFile = existsSync(proKeys)
      ? (JSON.parse(readFileSync(proKeys, 'utf8')) as {
          carried: string[];
          machineLocal: Record<string, string>;
          nonStorage: Record<string, string>;
        })
      : { carried: [], machineLocal: {}, nonStorage: {} };
    const known = new Set([
      ...CARRIED_KEYS,
      ...proKeyFile.carried,
      ...Object.keys(proKeyFile.machineLocal),
      ...Object.keys(proKeyFile.nonStorage),
      ...Object.keys(MACHINE_LOCAL_KEYS),
      ...Object.keys(NON_STORAGE_LITERALS),
    ]);
    expect([...found].filter((key) => !known.has(key)).sort()).toEqual([]);
  });

  it('writes every carried key back onto a wiped install', () => {
    // Catches a field added to the schema + collect but forgotten in apply: the
    // JSON editor would show it, and applying would silently drop it.
    const doc = collectAppSettings();
    // Fields whose stores clear their key when empty need a value to write back.
    doc.languages = { dismissedPrompts: ['python'] };
    doc.shortcuts = { 'close-tab': null };
    doc.sessionTemplates = {
      user: [{ id: 'a', name: 'My Rig', startCommand: 'claude --resume' }],
      hiddenBuiltins: ['codex'],
    };
    window.localStorage.clear();
    applyAppSettings(doc);
    const written = new Set(Object.keys(window.localStorage));
    expect(CARRIED_KEYS.filter((key) => !written.has(key))).toEqual([]);
  });

  it('snapshots every carried key it reads back', () => {
    // The other direction: a key written by apply but never read by collect
    // would be reset to its default on the next export.
    const doc = collectAppSettings();
    expect(validateAppSettings(doc).errors).toBeUndefined();
    window.localStorage.setItem('double0-session-changes-width', '480');
    expect(collectAppSettings().workspace.changesDrawerWidth).toBe(480);
  });
});

describe('validateAppSettings', () => {
  it('accepts a full document', () => {
    const result = validateAppSettings(VALID_SETTINGS);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.appearance.theme).toBe('dark');
  });

  it('accepts an older export that still carries the global explorer flag', () => {
    // The explorer is remembered per session now; the old flag must not make
    // an earlier export unimportable, and it must not leak into the document.
    const older = {
      ...VALID_SETTINGS,
      workspace: { ...VALID_SETTINGS.workspace, explorerOpen: true },
    };
    const result = validateAppSettings(older);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.workspace).not.toHaveProperty('explorerOpen');
  });

  it('accepts an older export that still carries the project rail flag', () => {
    // The project page and its rail are gone; an earlier export stays importable.
    const older = {
      ...VALID_SETTINGS,
      workspace: { ...VALID_SETTINGS.workspace, projectRailCollapsed: true },
    };
    const result = validateAppSettings(older);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.workspace).not.toHaveProperty('projectRailCollapsed');
  });

  it('round-trips the Commands-dock open state + archived workspace settings', () => {
    const withDock = {
      ...VALID_SETTINGS,
      workspace: {
        ...VALID_SETTINGS.workspace,
        commandsOpen: true,
        archivedOpen: false,
      },
    };
    const result = validateAppSettings(withDock);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.workspace.commandsOpen).toBe(true);
    expect(result.doc?.workspace.archivedOpen).toBe(false);
  });

  it('round-trips the terminal scrollback and keeps it optional', () => {
    const withScrollback = {
      ...VALID_SETTINGS,
      terminal: { ...VALID_SETTINGS.terminal, scrollback: 10000 },
    };
    const result = validateAppSettings(withScrollback);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.terminal.scrollback).toBe(10000);
    // Older exports without the field still validate, and the key stays absent
    // (a `scrollback: undefined` would reset the store to its default instead
    // of keeping the current value when the doc is spread into the patch).
    const withoutScrollback = validateAppSettings(VALID_SETTINGS);
    expect(withoutScrollback.errors).toBeUndefined();
    expect('scrollback' in (withoutScrollback.doc?.terminal ?? {})).toBe(false);
  });

  it('round-trips the accent color and rejects a non-hex one', () => {
    const withAccent = {
      ...VALID_SETTINGS,
      appearance: { ...VALID_SETTINGS.appearance, accentColor: '#4f9cf7' },
    };
    const result = validateAppSettings(withAccent);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.appearance.accentColor).toBe('#4f9cf7');

    const bad = validateAppSettings({
      ...VALID_SETTINGS,
      appearance: { ...VALID_SETTINGS.appearance, accentColor: 'green' },
    });
    expect(bad.errors?.[0]).toContain('appearance.accentColor');
  });

  it('reports the offending path for bad values', () => {
    const bad = structuredClone(VALID_SETTINGS) as Record<string, never> & typeof VALID_SETTINGS;
    bad.terminal.fontSize = 'huge' as unknown as number;
    bad.workspace.dockWidth = 'wide' as unknown as number;
    const result = validateAppSettings(bad);
    expect(result.errors?.some((e) => e.startsWith('terminal.fontSize'))).toBe(true);
    expect(result.errors?.some((e) => e.startsWith('workspace.dockWidth'))).toBe(true);
  });

  it('rejects non-hex colors with the field named', () => {
    const bad = structuredClone(VALID_SETTINGS);
    bad.terminal.custom.background = 'black';
    const result = validateAppSettings(bad);
    expect(result.errors?.[0]).toContain('terminal.custom.background');
  });

  it('accepts custom keyboard shortcuts (combo or unbound)', () => {
    const withShortcuts = {
      ...VALID_SETTINGS,
      shortcuts: { 'close-tab': { key: 'KeyW', mod: true }, 'new-tab': null },
    };
    const result = validateAppSettings(withShortcuts);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.shortcuts?.['close-tab']).toEqual({ key: 'KeyW', mod: true });
    expect(result.doc?.shortcuts?.['new-tab']).toBeNull();
  });

  it('rejects a shortcut combo missing its key', () => {
    const bad = { ...VALID_SETTINGS, shortcuts: { 'close-tab': { mod: true } } };
    const result = validateAppSettings(bad);
    expect(result.doc).toBeUndefined();
    expect(result.errors?.some((e) => e.startsWith('shortcuts.close-tab'))).toBe(true);
  });

  it('round-trips the detached-window widths and keeps them optional', () => {
    const withDetached = {
      ...VALID_SETTINGS,
      workspace: {
        ...VALID_SETTINGS.workspace,
        detachedDockWidth: 300,
        detachedExplorerWidth: 220,
        detachedChangesDrawerWidth: 320,
      },
    };
    const result = validateAppSettings(withDetached);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.workspace.detachedDockWidth).toBe(300);
    expect(result.doc?.workspace.detachedExplorerWidth).toBe(220);
    expect(result.doc?.workspace.detachedChangesDrawerWidth).toBe(320);
    expect(validateAppSettings(VALID_SETTINGS).errors).toBeUndefined();
  });

  it('accepts session templates and names a broken entry', () => {
    const withTemplates = {
      ...VALID_SETTINGS,
      sessionTemplates: {
        user: [{ id: 'a', name: 'My Rig', startCommand: 'claude --resume' }],
        hiddenBuiltins: ['codex'],
      },
    };
    const result = validateAppSettings(withTemplates);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.sessionTemplates?.user[0]?.name).toBe('My Rig');
    expect(result.doc?.sessionTemplates?.hiddenBuiltins).toEqual(['codex']);

    const bad = validateAppSettings({
      ...VALID_SETTINGS,
      sessionTemplates: { user: [{ id: 'a' }], hiddenBuiltins: [] },
    });
    expect(bad.errors?.some((e) => e.startsWith('sessionTemplates.user.0.name'))).toBe(true);
  });

  it('round-trips the changes-drawer width and keeps it optional', () => {
    const withDrawer = {
      ...VALID_SETTINGS,
      workspace: { ...VALID_SETTINGS.workspace, changesDrawerWidth: 420 },
    };
    const result = validateAppSettings(withDrawer);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.workspace.changesDrawerWidth).toBe(420);
    expect(validateAppSettings(VALID_SETTINGS).errors).toBeUndefined();
  });

  it('round-trips dismissed language-server prompts', () => {
    const withLanguages = {
      ...VALID_SETTINGS,
      languages: { dismissedPrompts: ['python', 'rust'] },
    };
    const result = validateAppSettings(withLanguages);
    expect(result.errors).toBeUndefined();
    expect(result.doc?.languages?.dismissedPrompts).toEqual(['python', 'rust']);

    const bad = validateAppSettings({
      ...VALID_SETTINGS,
      languages: { dismissedPrompts: 'python' },
    });
    expect(bad.errors?.some((e) => e.startsWith('languages.dismissedPrompts'))).toBe(true);
  });
});

describe('parseExportDocument', () => {
  const envelope = { format: EXPORT_FORMAT, version: EXPORT_VERSION };

  it('accepts a minimal envelope', () => {
    expect(parseExportDocument(JSON.stringify(envelope)).doc).toBeDefined();
  });

  it('rejects non-JSON with a parse message', () => {
    expect(parseExportDocument('{nope').errors?.[0]).toMatch(/Not valid JSON/);
  });

  it('rejects files that are not double0 exports', () => {
    const result = parseExportDocument(JSON.stringify({ format: 'other', version: 1 }));
    expect(result.errors?.[0]).toContain('format');
  });

  it('rejects exports from a newer version', () => {
    const result = parseExportDocument(
      JSON.stringify({ ...envelope, version: EXPORT_VERSION + 1 }),
    );
    expect(result.errors?.[0]).toMatch(/newer app/);
  });
});

describe('row preparation', () => {
  const project = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'demo',
    description: null,
    path: '/tmp/demo',
    color: '#a8c945',
    pinned: false,
    ownerId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };

  it('coerces dates and rewrites ownership to this machine', () => {
    const result = prepareProjectRow(project, 0);
    expect(result.error).toBeUndefined();
    expect(result.row?.ownerId).toBe(LOCAL_OWNER);
    expect(result.row?.createdAt).toBeInstanceOf(Date);
  });

  it('names the broken project in the error', () => {
    const result = prepareProjectRow({ ...project, id: 'not-a-uuid' }, 0);
    expect(result.error).toContain('“demo”');
    expect(result.error).toContain('id');
  });

  it('validates session status against the enum', () => {
    const session = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'sess',
      detail: '',
      agent: 'Claude Code',
      status: 'sleeping',
      projectId: project.id,
      ownerId: project.ownerId,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const result = prepareSessionRow(session, 0);
    expect(result.error).toContain('“sess”');
    expect(result.error).toContain('status');
    expect(prepareSessionRow({ ...session, status: 'idle' }, 0).row?.status).toBe('idle');
  });
});

// --- collect ⇄ apply round-trip ------------------------------------------------

describe('collectAppSettings', () => {
  it('returns a document its own validator accepts', () => {
    // The settings JSON editor shows exactly this; if it did not validate, the
    // editor would open on a document it refuses to save.
    const doc = collectAppSettings();
    expect(validateAppSettings(doc).errors).toBeUndefined();
  });

  it('reports built-in defaults for an untouched install', () => {
    // An extension's rail tool rides as `<tool>Open` (`gadget` stands for any).
    installRendererExtension({ edition: 'pro', railTools: [{ id: 'gadget' } as RailTool] });
    const doc = collectAppSettings();
    resetRendererExtensionForTest();
    expect(doc.workspace.dockPanels).toEqual(['projects', 'sessions']);
    expect(doc.workspace.dockWidth).toBe(264);
    expect(doc.workspace.explorerWidth).toBe(240);
    expect(doc.workspace.archivedOpen).toBe(true);
    expect(doc.workspace.gadgetOpen).toBe(false);
    expect(doc.workspace).not.toHaveProperty('projectRailCollapsed');
  });

  it('clamps sizes that were persisted out of range', () => {
    window.localStorage.setItem('double0-workspace-dock-width', '9000');
    window.localStorage.setItem('double0-workspace-explorer-width', '5');
    const doc = collectAppSettings();
    expect(doc.workspace.dockWidth).toBe(560);
    expect(doc.workspace.explorerWidth).toBe(180);
  });

  it('falls back on unparseable persisted values', () => {
    window.localStorage.setItem('double0-workspace-dock-width', 'wide');
    window.localStorage.setItem('double0-workspace-dock-panels', '{oops');
    const doc = collectAppSettings();
    expect(doc.workspace.dockWidth).toBe(264);
    expect(doc.workspace.dockPanels).toEqual(['projects', 'sessions']);
  });
});

describe('applyAppSettings → collectAppSettings round-trip', () => {
  const edited = {
    ...VALID_SETTINGS,
    workspace: {
      ...VALID_SETTINGS.workspace,
      dockPanels: ['sessions'],
      dockWidth: 320,
      explorerWidth: 300,
      gadgetOpen: true,
      commandsOpen: true,
      archivedOpen: false,
    },
  };

  it('reads back exactly what it wrote', () => {
    installRendererExtension({ edition: 'pro', railTools: [{ id: 'gadget' } as RailTool] });
    const { doc } = validateAppSettings(edited);
    applyAppSettings(doc!);
    expect(collectAppSettings().workspace).toMatchObject(edited.workspace);
    resetRendererExtensionForTest();
  });

  it("drops a tool's flag for a tool this build does not have", () => {
    // A document from a build with the tool, imported where it is absent.
    const { doc } = validateAppSettings(edited);
    expect(doc?.workspace).not.toHaveProperty('gadgetOpen');
  });

  it('is idempotent - applying its own snapshot changes nothing', () => {
    const { doc } = validateAppSettings(edited);
    applyAppSettings(doc!);
    const first = collectAppSettings();
    applyAppSettings(first);
    expect(collectAppSettings()).toEqual(first);
  });

  it('notifies the live views so open surfaces restyle', () => {
    const listener = vi.fn();
    window.addEventListener(SETTINGS_APPLIED_EVENT, listener);
    applyAppSettings(validateAppSettings(VALID_SETTINGS).doc!);
    window.removeEventListener(SETTINGS_APPLIED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves settings an older export omits untouched', () => {
    // VALID_SETTINGS carries no accentColor / fonts / shortcuts.
    applyAppSettings(
      validateAppSettings({ ...VALID_SETTINGS, appearance: { theme: 'dark' } }).doc!,
    );
    const before = collectAppSettings();
    applyAppSettings(validateAppSettings(VALID_SETTINGS).doc!);
    expect(collectAppSettings().appearance.accentColor).toBe(before.appearance.accentColor);
    expect(collectAppSettings().shortcuts).toEqual(before.shortcuts);
  });

  it('survives unwritable storage without throwing', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => applyAppSettings(validateAppSettings(VALID_SETTINGS).doc!)).not.toThrow();
    setItem.mockRestore();
  });
});

// --- export / import ----------------------------------------------------------

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  db = fakeDb();
  installFakeApi(db);
});

afterEach(() => {
  resetRendererExtensionForTest();
});

describe('buildExportDocument', () => {
  it('produces a file its own parser accepts', async () => {
    const content = await buildExportDocument();
    const parsed = parseExportDocument(content);
    expect(parsed.errors).toBeUndefined();
    expect(parsed.doc?.format).toBe(EXPORT_FORMAT);
    expect(parsed.doc?.version).toBe(EXPORT_VERSION);
  });

  it('carries every table and the session layouts', async () => {
    const doc = JSON.parse(await buildExportDocument());
    for (const key of ['projects', 'sessions', 'sessionLayouts', 'settings']) {
      expect(doc, key).toHaveProperty(key);
    }
    expect(db.api.layout.list).toHaveBeenCalled();
  });

  it('reads every core table on the DB bridge', async () => {
    // Core's tables (main/db/row-schemas.ts › CORE_TABLES) are exported here;
    // an extension exports its own (its `dataTransfer.collect`). A core table
    // added without a line here fails this list.
    await buildExportDocument();
    const listed = db.api.db.list.mock.calls.map(([table]) => table).sort();
    expect(listed).toEqual(['agent_sessions', 'projects']);
  });

  it('adds the sections an installed extension collects', async () => {
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      dataTransfer: {
        sections: ['notes'],
        describes: 'saved notes',
        collect: async () => ({ notes: [{ id: 'n1' }] }),
        apply: async () => ({ counts: {}, summary: [], errors: [] }),
      },
    });
    const doc = JSON.parse(await buildExportDocument());
    expect(doc.notes).toEqual([{ id: 'n1' }]);
  });

  it('embeds the current settings snapshot', async () => {
    window.localStorage.setItem('double0-workspace-dock-width', '333');
    const doc = JSON.parse(await buildExportDocument());
    expect(doc.settings.workspace.dockWidth).toBe(333);
  });

  it('is pretty-printed so the file is diffable', async () => {
    expect(await buildExportDocument()).toContain('\n  "format"');
  });
});

describe('importDocument - file-level failures', () => {
  it('imports nothing when the file is not JSON', async () => {
    const result = await importDocument('{not json');
    expect(result.fatal?.[0]).toContain('Not valid JSON');
    expect(db.api.db.insert).not.toHaveBeenCalled();
  });

  it('imports nothing when the file is not a double0 export', async () => {
    const result = await importDocument(JSON.stringify({ format: 'something-else' }));
    expect(result.fatal).toBeDefined();
    expect(db.api.db.insert).not.toHaveBeenCalled();
  });

  it('refuses an export from a newer app version', async () => {
    const result = await importDocument(envelope({ version: EXPORT_VERSION + 1 }));
    expect(result.fatal?.[0]).toContain('newer app');
  });
});

describe('importDocument - settings', () => {
  it('applies valid settings', async () => {
    const result = await importDocument(envelope({ settings: VALID_SETTINGS }));
    expect(result.settings).toBe('applied');
    expect(collectAppSettings().appearance.theme).toBe('dark');
  });

  it('reports invalid settings but still imports the data', async () => {
    const result = await importDocument(
      envelope({
        settings: { appearance: { theme: 'ultraviolet' } },
        projects: [exportedProject()],
      }),
    );
    expect(result.settings).toBe('invalid');
    expect(result.errors.some((e) => e.startsWith('settings:'))).toBe(true);
    expect(result.projectsCreated).toBe(1);
  });

  it('reports none when the file carries no settings', async () => {
    expect((await importDocument(envelope({}))).settings).toBe('none');
  });
});

describe('importDocument - upserts', () => {
  it('creates rows that do not exist yet', async () => {
    const result = await importDocument(envelope({ projects: [exportedProject()] }));
    expect(result).toMatchObject({ projectsCreated: 1, projectsUpdated: 0 });
    expect(db.tables.projects).toHaveLength(1);
  });

  it('updates rows that already exist, matched by id', async () => {
    db.tables.projects.push({ id: PROJECT_ID, name: 'old name' });
    const result = await importDocument(envelope({ projects: [exportedProject()] }));
    expect(result).toMatchObject({ projectsCreated: 0, projectsUpdated: 1 });
    expect(db.tables.projects).toHaveLength(1);
    expect(db.tables.projects[0].name).toBe('production-pipeline');
  });

  it('never lets an update move the primary key', async () => {
    db.tables.projects.push({ id: PROJECT_ID, name: 'old name' });
    await importDocument(envelope({ projects: [exportedProject()] }));
    const [, , patch] = db.api.db.update.mock.calls[0];
    expect(patch).not.toHaveProperty('id');
  });

  it('rewrites ownership to this machine', async () => {
    await importDocument(envelope({ projects: [exportedProject()] }));
    expect(db.tables.projects[0].ownerId).toBe(LOCAL_OWNER);
    expect(db.tables.projects[0].ownerId).not.toBe(OTHER_OWNER);
  });

  it('imports sessions alongside their project', async () => {
    const result = await importDocument(
      envelope({ projects: [exportedProject()], sessions: [exportedSession()] }),
    );
    expect(result).toMatchObject({ projectsCreated: 1, sessionsCreated: 1 });
  });

  it('accepts a session whose project already exists locally', async () => {
    db.tables.projects.push({ id: PROJECT_ID, name: 'already here' });
    const result = await importDocument(envelope({ sessions: [exportedSession()] }));
    expect(result.sessionsCreated).toBe(1);
  });
});

describe('importDocument - referential integrity', () => {
  it('skips a session whose project exists nowhere, naming it', async () => {
    // Inserting it would break the FK; the rest of the import must survive.
    const result = await importDocument(envelope({ sessions: [exportedSession()] }));
    expect(result.sessionsCreated).toBe(0);
    expect(result.errors.join()).toContain('Fix flaky tests');
    expect(result.errors.join()).toContain('doesn’t exist');
  });

  it('keeps importing after a bad row', async () => {
    const result = await importDocument(
      envelope({
        projects: [exportedProject({ id: 'not-a-uuid' }), exportedProject()],
      }),
    );
    expect(result.projectsCreated).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('reports a database failure per item without aborting', async () => {
    db.api.db.insert.mockRejectedValueOnce(new Error('disk is full'));
    const result = await importDocument(
      envelope({
        projects: [
          exportedProject(),
          exportedProject({ id: '33333333-3333-4333-8333-333333333333', name: 'second' }),
        ],
      }),
    );
    expect(result.projectsCreated).toBe(1);
    expect(result.errors.join()).toContain('disk is full');
  });
});

describe('export → import round-trip', () => {
  it('restores projects and sessions onto an empty machine', async () => {
    const source = fakeDb({
      projects: [{ ...exportedProject(), ownerId: LOCAL_OWNER }],
      agent_sessions: [{ ...exportedSession(), ownerId: LOCAL_OWNER }],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: source.api,
    });
    const file = await buildExportDocument();

    const target = fakeDb();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: target.api,
    });
    const result = await importDocument(file);

    expect(result.fatal).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ projectsCreated: 1, sessionsCreated: 1, settings: 'applied' });
    expect(target.tables.projects[0].name).toBe('production-pipeline');
    expect(target.tables.agent_sessions[0].label).toBe('Fix flaky tests');
  });

  it('is idempotent - importing the same file twice updates instead of duplicating', async () => {
    const source = fakeDb({
      projects: [{ ...exportedProject(), ownerId: LOCAL_OWNER }],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: source.api,
    });
    const file = await buildExportDocument();

    const target = fakeDb();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: target.api,
    });
    const first = await importDocument(file);
    const second = await importDocument(file);

    expect(first.projectsCreated).toBe(1);
    expect(second).toMatchObject({ projectsCreated: 0, projectsUpdated: 1 });
    expect(target.tables.projects).toHaveLength(1);
  });
});

// --- an extension's section of the settings document ----------------------------

describe('extension sections of the settings document', () => {
  // A section core does not define (Pro's integrations) is validated, collected
  // and applied by the extension that owns it - and a build without that
  // extension drops it like any unknown key.
  const section = (apply = vi.fn()) => ({
    key: 'notes',
    schema: z.object({ pinned: z.boolean() }),
    ensureLoaded: vi.fn(async () => undefined),
    collect: () => ({ pinned: true }),
    apply,
  });
  const install = (s: ReturnType<typeof section>): void =>
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      integrations: { settings: s } as unknown as IntegrationsSlot,
    });

  it('collects, validates and applies an installed section under its key', () => {
    const apply = vi.fn();
    install(section(apply));
    const doc = collectAppSettings();
    expect(doc.notes).toEqual({ pinned: true });
    const checked = validateAppSettings(doc);
    expect(checked.errors).toBeUndefined();
    applyAppSettings(checked.doc!);
    expect(apply).toHaveBeenCalledWith({ pinned: true });
  });

  it('names a broken section by its key', () => {
    install(section());
    const bad = validateAppSettings({ ...VALID_SETTINGS, notes: { pinned: 'yes' } });
    expect(bad.errors?.some((e) => e.startsWith('notes.pinned'))).toBe(true);
  });

  it('drops a section no installed extension reads', () => {
    const checked = validateAppSettings({ ...VALID_SETTINGS, notes: { pinned: true } });
    expect(checked.errors).toBeUndefined();
    expect(checked.doc).not.toHaveProperty('notes');
  });

  it('export waits for the sections to load', async () => {
    const s = section();
    install(s);
    const doc = JSON.parse(await buildExportDocument());
    expect(s.ensureLoaded).toHaveBeenCalled();
    expect(doc.settings.notes).toEqual({ pinned: true });
  });
});

describe('importDocument - session layouts', () => {
  const layout = { rootId: 'p1', nodes: {}, tabs: [], activePaneId: 'p1' };

  it('restores a layout for a session that exists', async () => {
    const result = await importDocument(
      envelope({
        projects: [exportedProject()],
        sessions: [exportedSession()],
        sessionLayouts: [{ sessionId: SESSION_ID, layout }],
      }),
    );
    expect(result.layoutsSaved).toBe(1);
    expect(db.layouts[0]).toMatchObject({ sessionId: SESSION_ID });
  });

  it('skips and reports a layout for an unknown session', async () => {
    const result = await importDocument(
      envelope({ sessionLayouts: [{ sessionId: SESSION_ID, layout }] }),
    );
    expect(result.layoutsSaved).toBe(0);
    expect(result.errors.join()).toContain('unknown session');
    expect(db.layouts).toHaveLength(0);
  });
});

describe('importDocument - sections core does not read', () => {
  // An export from a build with more features carries sections this build has
  // no reader for: the rest must still import, and the user is told what went
  // unread instead of seeing it vanish.
  it('imports the rest and names the sections nobody here reads', async () => {
    const result = await importDocument(
      envelope({ projects: [exportedProject()], notes: [{ id: 'n1' }], empty: [] }),
    );
    expect(result.projectsCreated).toBe(1);
    expect(result.skippedSections).toEqual(['notes']);
    expect(result.extension).toEqual({ counts: {}, summary: [] });
  });

  it('hands an installed extension its sections after projects and sessions exist', async () => {
    const apply = vi.fn(async (doc: Record<string, unknown>, ctx) => {
      // Its rows point at core's: the context must already hold them.
      expect(ctx.existingProjects.has(PROJECT_ID)).toBe(true);
      expect(ctx.existingSessions.has(SESSION_ID)).toBe(true);
      return {
        counts: { notesCreated: (doc.notes as unknown[]).length },
        summary: ['Notes: 1 added.'],
        errors: ['note n2: broken'],
      };
    });
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      dataTransfer: {
        sections: ['notes'],
        describes: 'saved notes',
        collect: async () => ({}),
        apply,
      },
    });
    const result = await importDocument(
      envelope({
        projects: [exportedProject()],
        sessions: [exportedSession()],
        notes: [{ id: 'n1' }],
      }),
    );
    expect(apply).toHaveBeenCalledOnce();
    expect(result.extension).toEqual({
      counts: { notesCreated: 1 },
      summary: ['Notes: 1 added.'],
    });
    expect(result.errors).toContain('note n2: broken');
    expect(result.skippedSections).toEqual([]);
  });
});
