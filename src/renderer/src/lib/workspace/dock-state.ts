import { railTool, rendererExtension } from '@renderer/lib/extension/registry';

// Pure state model for the workspace's left dock (panel set + width), kept out
// of workspace-chrome.tsx so that file exports only components (react-refresh
// needs component-only files for reliable hot reloading).

// `projects`, `sessions` and `tabs` are stackable dock panels (top→bottom in
// PANEL_ORDER). `tabs` (the vertical open-tabs list) only exists while the
// vertical-tabs setting is on - the chrome filters it out otherwise. An
// extension's rail tools are exclusive overlays (at most one open): while up,
// the dock shows only that tool's panel and the content area shows its views -
// the stacked set (and the file explorer) is remembered underneath and
// restored on close. Such a tool may exist only for some projects
// (`RendererExtension.useRailToolAvailability`).
export type DockStackPanelId = 'projects' | 'sessions' | 'tabs';

// Everything the icon rail can toggle: the stacked panels, `files` (the
// editor's file-explorer sidebar, not a dock panel) and an extension's tools.
export type RailTabId = DockStackPanelId | 'files' | (string & {});

/** The core's own rail tools, in their default order. */
export const CORE_RAIL_TAB_IDS: readonly RailTabId[] = ['projects', 'sessions', 'tabs', 'files'];

/**
 * Every rail tool of this build, in the rail's default order: the extension's
 * order when it gives one (`RendererExtension.railOrder`, its tools among the
 * core's), else the core's followed by its tools. The rail renders them in the
 * user's customised order instead (lib/rail-order.ts) - this is the catalog
 * that order is validated against.
 */
export function railTabIds(): RailTabId[] {
  const ext = rendererExtension();
  const known = [...CORE_RAIL_TAB_IDS, ...ext.railTools.map((t) => t.id)];
  const out = (ext.railOrder ?? known).filter(
    (id, i, all) => known.includes(id) && all.indexOf(id) === i,
  );
  for (const id of known) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * An extension's rail tool: its code registers through the renderer extension
 * (`RendererExtension.railTools`); its id is what persisted rail orders and
 * dock flags name, in a build without it too.
 */
export function isExtensionRailTool(id: RailTabId): boolean {
  return !CORE_RAIL_TAB_IDS.includes(id);
}

// Top→bottom stacking order of panels in the dock.
export const PANEL_ORDER: DockStackPanelId[] = ['projects', 'sessions', 'tabs'];

const DEFAULT_DOCK_PANELS: DockStackPanelId[] = ['projects', 'sessions'];

/** Decode the persisted open-panel set (see `usePersistedState` in the host). */
export function decodeDockPanels(raw: string | null): DockStackPanelId[] {
  if (!raw) return DEFAULT_DOCK_PANELS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_DOCK_PANELS;
    // A set an early build wrote while its git tool still lived in this
    // array (as `changes`, exclusively) carries no stack info, so fall back.
    if (parsed.includes('changes')) return DEFAULT_DOCK_PANELS;
    return PANEL_ORDER.filter((id) => parsed.includes(id));
  } catch {
    return DEFAULT_DOCK_PANELS;
  }
}

/** Where an extension rail tool's open flag is stored (the main window's; a project window namespaces it). */
export function dockToolStorageKey(id: RailTabId): string {
  return `double0-workspace-dock-${id}`;
}

/** An extension rail tool's open flag in the settings document's workspace section. */
export function dockToolDocField(id: RailTabId): string {
  return `${id}Open`;
}

/** Decode a persisted on / off flag ('1' = on). */
export function decodeFlag(raw: string | null): boolean {
  return raw === '1';
}

/**
 * Whether a rail tool exists at all right now. `tabs` needs the vertical-tabs
 * setting on; an extension's tool needs the extension to have registered it,
 * and - when it says so (`availability`, from
 * `RendererExtension.useRailToolAvailability`) - the project on screen to have
 * it (`null`, not known yet, counts as not). Shared by the rail (which icons
 * to render) and the host's `toggleDock` (whether the tool's ⌘-digit shortcut
 * does anything), so a hidden tool can never be opened by keyboard into a
 * panel with no rail tab to close it again.
 */
export function railTabAvailable(
  id: RailTabId,
  gates: { verticalTabs: boolean; availability?: Readonly<Record<string, boolean | null>> },
): boolean {
  if (isExtensionRailTool(id)) {
    if (!railTool(id)) return false;
    const known = gates.availability?.[id];
    return known === undefined || known === true;
  }
  if (id === 'tabs') return gates.verticalTabs;
  return true;
}

const NO_AVAILABILITY: Readonly<Record<string, boolean | null>> = {};

function useAllRailTools(projectId: string | null): Readonly<Record<string, boolean | null>> {
  void projectId;
  return NO_AVAILABILITY;
}

/**
 * The hook that says which of the extension's rail tools exist for a project.
 * The extension is installed before the first render and never changes, so
 * the same hook runs on every render.
 */
export function railToolAvailabilityHook(): (
  projectId: string | null,
) => Readonly<Record<string, boolean | null>> {
  return rendererExtension().useRailToolAvailability ?? useAllRailTools;
}

/** Plain open/close of one stacked panel. */
export function toggleDockPanel(
  open: DockStackPanelId[],
  id: DockStackPanelId,
): DockStackPanelId[] {
  return open.includes(id) ? open.filter((p) => p !== id) : [...open, id];
}

// The dock is resizable: a pixel width (right-edge drag) + per-panel vertical
// shares (divider drag, handled by react-resizable-panels).
const DOCK_DEFAULT_WIDTH = 264;
export const DOCK_MIN_WIDTH = 200;
export const DOCK_MAX_WIDTH = 560;

/** Decode the persisted dock width (see `usePersistedState` in the host). */
export function decodeDockWidth(raw: string | null): number {
  const width = Number(raw);
  if (!raw || !Number.isFinite(width) || width <= 0) return DOCK_DEFAULT_WIDTH;
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, width));
}

// Default vertical share for each stacked panel (resizable afterwards): projects
// is compact, the session list takes the lion's share.
const PANEL_WEIGHT: Record<DockStackPanelId, number> = {
  projects: 3,
  sessions: 5,
  tabs: 4,
};

/** Percentages for the currently-open panels, summing to exactly 100. */
export function dockDefaultSizes(open: DockStackPanelId[]): number[] {
  const total = open.reduce((sum, id) => sum + PANEL_WEIGHT[id], 0);
  const sizes = open.map((id) => Math.round((PANEL_WEIGHT[id] / total) * 100));
  if (sizes.length) sizes[sizes.length - 1] += 100 - sizes.reduce((a, b) => a + b, 0);
  return sizes;
}
