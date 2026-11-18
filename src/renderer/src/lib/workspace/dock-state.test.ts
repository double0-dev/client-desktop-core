import { afterEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { RailTool } from '@renderer/lib/extension/types';
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  CORE_RAIL_TAB_IDS,
  PANEL_ORDER,
  decodeFlag,
  decodeDockPanels,
  decodeDockWidth,
  dockDefaultSizes,
  railTabAvailable,
  railTabIds,
  toggleDockPanel,
  type DockStackPanelId,
} from '@renderer/lib/workspace/dock-state';

describe('decodeDockPanels', () => {
  it('defaults to projects + sessions with nothing persisted', () => {
    expect(decodeDockPanels(null)).toEqual(['projects', 'sessions']);
  });

  it('restores a persisted set in PANEL_ORDER, not the stored order', () => {
    // The dock always stacks top→bottom in PANEL_ORDER; the stored array is a
    // set, so a reversed one must come back normalised.
    expect(decodeDockPanels(JSON.stringify(['sessions', 'projects']))).toEqual([
      'projects',
      'sessions',
    ]);
  });

  it('restores an empty set (every panel collapsed)', () => {
    expect(decodeDockPanels(JSON.stringify([]))).toEqual([]);
  });

  it('keeps the vertical-tabs panel when it was open', () => {
    expect(decodeDockPanels(JSON.stringify(['tabs', 'projects']))).toEqual(['projects', 'tabs']);
  });

  it('drops ids that are no longer stackable panels', () => {
    expect(decodeDockPanels(JSON.stringify(['projects', 'tasks', 'files']))).toEqual(['projects']);
  });

  it('falls back for a set an early build wrote with its git tool in it', () => {
    // ['changes'] carried no stack info back when that tool lived in this array.
    expect(decodeDockPanels(JSON.stringify(['changes']))).toEqual(['projects', 'sessions']);
    expect(decodeDockPanels(JSON.stringify(['changes', 'sessions']))).toEqual([
      'projects',
      'sessions',
    ]);
  });

  it('falls back on malformed JSON or a non-array', () => {
    expect(decodeDockPanels('{')).toEqual(['projects', 'sessions']);
    expect(decodeDockPanels(JSON.stringify({ projects: true }))).toEqual(['projects', 'sessions']);
    expect(decodeDockPanels('')).toEqual(['projects', 'sessions']);
  });
});

describe('decodeFlag', () => {
  it('is on only for the exact stored flag', () => {
    expect(decodeFlag('1')).toBe(true);
    expect(decodeFlag('0')).toBe(false);
    expect(decodeFlag('true')).toBe(false);
    expect(decodeFlag(null)).toBe(false);
  });
});

describe('toggleDockPanel', () => {
  it('opens a closed panel and closes an open one', () => {
    expect(toggleDockPanel(['projects'], 'sessions')).toEqual(['projects', 'sessions']);
    expect(toggleDockPanel(['projects', 'sessions'], 'projects')).toEqual(['sessions']);
  });

  it('can close the last open panel', () => {
    expect(toggleDockPanel(['projects'], 'projects')).toEqual([]);
  });

  it('does not mutate the array it is given', () => {
    const open: DockStackPanelId[] = ['projects'];
    toggleDockPanel(open, 'sessions');
    expect(open).toEqual(['projects']);
  });
});

describe('decodeDockWidth', () => {
  it('defaults when nothing (or nonsense) is persisted', () => {
    expect(decodeDockWidth(null)).toBe(264);
    expect(decodeDockWidth('')).toBe(264);
    expect(decodeDockWidth('wide')).toBe(264);
    expect(decodeDockWidth('0')).toBe(264);
    expect(decodeDockWidth('-40')).toBe(264);
  });

  it('keeps a width inside the allowed range', () => {
    expect(decodeDockWidth('320')).toBe(320);
  });

  it('clamps a width from outside the range', () => {
    expect(decodeDockWidth('40')).toBe(DOCK_MIN_WIDTH);
    expect(decodeDockWidth('9000')).toBe(DOCK_MAX_WIDTH);
  });
});

describe('dockDefaultSizes', () => {
  it('sums to exactly 100 for every panel combination', () => {
    // react-resizable-panels rejects a set that does not total 100.
    const combos: DockStackPanelId[][] = [
      ['projects'],
      ['sessions'],
      ['tabs'],
      ['projects', 'sessions'],
      ['projects', 'tabs'],
      ['sessions', 'tabs'],
      ['projects', 'sessions', 'tabs'],
    ];
    for (const combo of combos) {
      const sizes = dockDefaultSizes(combo);
      expect(sizes, combo.join('+')).toHaveLength(combo.length);
      expect(
        sizes.reduce((a, b) => a + b, 0),
        combo.join('+'),
      ).toBe(100);
    }
  });

  it('gives the session list the largest share', () => {
    const [projects, sessions] = dockDefaultSizes(['projects', 'sessions']);
    expect(sessions).toBeGreaterThan(projects);
  });

  it('gives a lone panel the whole dock', () => {
    expect(dockDefaultSizes(['sessions'])).toEqual([100]);
  });

  it('returns nothing when no panel is open', () => {
    expect(dockDefaultSizes([])).toEqual([]);
  });
});

describe('railTabAvailable', () => {
  afterEach(() => resetRendererExtensionForTest());
  const off = { verticalTabs: false };
  const on = { verticalTabs: true };
  // `gadget` stands for any extension rail tool.
  const gadget = { id: 'gadget' } as RailTool;

  it('gates tabs on the vertical-tabs setting', () => {
    expect(railTabAvailable('tabs', off)).toBe(false);
    expect(railTabAvailable('tabs', on)).toBe(true);
  });

  it("gates an extension's tool on the project when the extension says so", () => {
    installRendererExtension({ edition: 'pro', railTools: [gadget] });
    // No word about it: always there.
    expect(railTabAvailable('gadget', off)).toBe(true);
    expect(railTabAvailable('gadget', { ...off, availability: { gadget: true } })).toBe(true);
    expect(railTabAvailable('gadget', { ...off, availability: { gadget: false } })).toBe(false);
    // Not known yet (accounts still loading): not there either.
    expect(railTabAvailable('gadget', { ...off, availability: { gadget: null } })).toBe(false);
  });

  // An extension's tool exists only where it registered: in the core build its
  // icon and its ⌘-digit are both gone.
  it('is unavailable until the extension registers it, then available', () => {
    expect(railTabAvailable('gadget', on)).toBe(false);
    installRendererExtension({ edition: 'pro', railTools: [gadget] });
    expect(railTabAvailable('gadget', on)).toBe(true);
  });

  // Everything else is unconditional - the rail always shows it, and its
  // ⌘-digit always works. A tool wrongly gated here would silently lose both.
  it('leaves every other core rail tool always available', () => {
    for (const id of CORE_RAIL_TAB_IDS) {
      if (id === 'tabs') continue;
      expect(railTabAvailable(id, off), id).toBe(true);
    }
    for (const id of CORE_RAIL_TAB_IDS) expect(railTabAvailable(id, on), id).toBe(true);
  });
});

describe('rail catalog', () => {
  afterEach(() => resetRendererExtensionForTest());

  it('lists every stackable panel among the rail tabs', () => {
    for (const id of PANEL_ORDER) expect(railTabIds()).toContain(id);
  });

  it('has no duplicate ids (rail-order validates against this catalog)', () => {
    expect(new Set(railTabIds()).size).toBe(railTabIds().length);
  });

  it("adds an extension's tools after the core's, or in the order it gives", () => {
    const tools = [{ id: 'gadget' }, { id: 'widget' }] as RailTool[];
    installRendererExtension({ edition: 'pro', railTools: tools });
    expect(railTabIds()).toEqual([...CORE_RAIL_TAB_IDS, 'gadget', 'widget']);
    // Its order wins; an id it names that no tool has is dropped, a tool it
    // forgot still joins the end.
    installRendererExtension({
      edition: 'pro',
      railTools: tools,
      railOrder: ['gadget', 'projects', 'nope', 'sessions', 'tabs', 'files'],
    });
    expect(railTabIds()).toEqual(['gadget', 'projects', 'sessions', 'tabs', 'files', 'widget']);
  });
});
