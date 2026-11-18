import { render, waitFor } from '@testing-library/react';
import { useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLayoutProvider } from '@renderer/routes/_app/-components/workspace/workspace-context';
import {
  WorkspaceLayoutContext,
  type WorkspaceLayoutContextValue,
} from '@renderer/lib/workspace/layout-context';
import {
  allTabs,
  conversationPtyId,
  initialLayout,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import { stubApi } from '@renderer/test-support';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { BrowserSlot } from '@renderer/lib/extension/types';

/**
 * The provider owns a session's tab/pane tree and the callbacks the chrome
 * calls. The tree transforms themselves live in workspace-layout.ts (tested
 * separately) - what matters here is the wiring around them: that closing a
 * terminal kills its shell, that a busy tab is confirmed first, that an
 * unsaved editor is confirmed first, and that a seed layout from disk or
 * another window is repaired rather than trusted.
 */

const confirmDialog = vi.fn(async () => true);
const confirmCloseBusyTab = vi.fn(async () => true);
const confirmCloseBusyTabs = vi.fn(async () => true);
vi.mock('@renderer/components/ui/confirm-dialog', () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...(args as [])),
  alertDialog: vi.fn(async () => {}),
}));
vi.mock('@renderer/components/busy-tabs-dialog', () => ({
  confirmCloseBusyTab: (...args: unknown[]) => confirmCloseBusyTab(...(args as [])),
  confirmCloseBusyTabs: (...args: unknown[]) => confirmCloseBusyTabs(...(args as [])),
  confirmDeleteBusySession: vi.fn(async () => true),
  BusyTabsCard: () => null,
}));

const disposePooledTerminal = vi.fn();
vi.mock('@renderer/lib/terminal/pool', () => ({
  disposePooledTerminal: (...args: unknown[]) => disposePooledTerminal(...(args as [])),
  getPooledTerminal: vi.fn(() => undefined),
  acquireTerminal: vi.fn(),
  focusPooledTerminal: vi.fn(),
  reconcileTerminalGrid: vi.fn(),
  redrawAllTerminals: vi.fn(),
}));

const recheckSessionStatus = vi.fn();
vi.mock('@renderer/lib/session/status', () => ({
  recheckSessionStatus: (...args: unknown[]) => recheckSessionStatus(...(args as [])),
}));

const unarchiveSession = vi.fn(() => false);
vi.mock('@renderer/lib/session/unarchive', () => ({
  unarchiveSession: (...args: unknown[]) => unarchiveSession(...(args as [])),
}));

const busy = new Map<string, 'running' | 'needs-input'>();
vi.mock('@renderer/lib/terminal/busy', () => ({
  getTerminalBusy: (ptyId: string) => busy.get(ptyId) ?? null,
  busyShellTabs: (tabs: { title: string; ptyId?: string }[]) =>
    tabs
      .filter((t) => t.ptyId && busy.has(t.ptyId))
      .map((t) => ({ title: t.title, status: busy.get(t.ptyId!)! })),
  clearTerminalBusy: vi.fn(),
  setTerminalBusy: vi.fn(),
}));

const SESSION = 'session-1';

/** Mount the provider and expose its live context value. */
function mount(props: Partial<Parameters<typeof WorkspaceLayoutProvider>[0]> = {}) {
  const seen: { current: WorkspaceLayoutContextValue | null } = { current: null };
  function Probe() {
    seen.current = useContext(WorkspaceLayoutContext);
    return null;
  }
  const view = render(
    <WorkspaceLayoutProvider sessionId={SESSION} {...props}>
      <Probe />
    </WorkspaceLayoutProvider>,
  );
  return { ...view, ctx: seen };
}

const layoutOf = (ctx: { current: WorkspaceLayoutContextValue | null }): WorkspaceLayout =>
  ctx.current!.layout;
const titles = (ctx: { current: WorkspaceLayoutContextValue | null }): string[] =>
  allTabs(layoutOf(ctx)).map((t) => t.title);

beforeEach(() => {
  stubApi();
  busy.clear();
  // These are module-level vi.fn()s, so `restoreMocks` does not touch their
  // call history - clear it explicitly or a later test sees earlier calls.
  for (const spy of [
    confirmDialog,
    confirmCloseBusyTab,
    confirmCloseBusyTabs,
    disposePooledTerminal,
    recheckSessionStatus,
    unarchiveSession,
  ]) {
    spy.mockClear();
  }
  confirmDialog.mockResolvedValue(true);
  confirmCloseBusyTab.mockResolvedValue(true);
  confirmCloseBusyTabs.mockResolvedValue(true);
});

describe('the seed layout', () => {
  it('starts from the session’s own layout by default', () => {
    const { ctx } = mount();
    const tabs = allTabs(layoutOf(ctx));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('conversation');
  });

  it('labels the primary tab after the session’s agent', () => {
    const { ctx } = mount({ primaryTitle: 'Claude Code' });
    expect(titles(ctx)).toEqual(['Claude Code']);
  });

  it('accepts a valid seed layout with its tab identity intact', () => {
    const seed = initialLayout('other-session', 'Terminal');
    const { ctx } = mount({ initial: seed });
    expect(allTabs(layoutOf(ctx))[0].id).toBe(allTabs(seed)[0].id);
  });

  it('repairs a seed layout that is slightly broken rather than crashing', () => {
    // Layouts arrive from disk and from other windows; a pane referencing a tab
    // that is not in the map must not take the whole session down.
    const seed = initialLayout(SESSION);
    const broken = {
      ...seed,
      nodes: {
        ...seed.nodes,
        [seed.rootId]: {
          ...(seed.nodes[seed.rootId] as { tabs: string[] }),
          tabs: [...(seed.nodes[seed.rootId] as { tabs: string[] }).tabs, 'ghost-tab'],
        },
      },
    } as unknown as WorkspaceLayout;

    const { ctx } = mount({ initial: broken });
    expect(allTabs(layoutOf(ctx)).map((t) => t.id)).not.toContain('ghost-tab');
    expect(allTabs(layoutOf(ctx)).length).toBeGreaterThan(0);
  });

  it('falls back to a fresh layout when the seed is beyond repair', () => {
    const { ctx } = mount({ initial: { nonsense: true } as unknown as WorkspaceLayout });
    expect(allTabs(layoutOf(ctx))).toHaveLength(1);
  });
});

/**
 * Browser tabs are Pro (a private plan › M5): the layout side of opening one -
 * where it lands, reusing a tab by origin, opening a forwarded URL - is core,
 * the rest comes through the slot. A stand-in slot here; the real one's
 * forwarding and navigation are tested in the official build.
 */
function withBrowser(over: Partial<BrowserSlot> = {}): void {
  installRendererExtension({
    edition: 'pro',
    railTools: [],
    browser: {
      tabKind: 'webpage',
      forward: () => null,
      navigate: () => false,
      tabTitle: (url: string) => url || 'New tab',
      ...over,
    } as unknown as BrowserSlot,
  });
}

describe('opening tabs', () => {
  afterEach(() => resetRendererExtensionForTest());

  it('offers no browser opener in the core build', () => {
    const { ctx } = mount();
    expect(ctx.current!.openBrowser).toBeUndefined();
  });

  it('adds a terminal tab', async () => {
    const { ctx } = mount();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
  });

  it('names a template terminal after the template', async () => {
    const { ctx } = mount();
    ctx.current!.addTemplateTerminal('Codex', 'codex');
    await waitFor(() => expect(titles(ctx)).toContain('Codex'));
  });

  it('opens a file in an editor tab', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));
  });

  it("opens a file on a new split when asked (a picked element's source)", async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/src/a.ts', { paneId: layoutOf(ctx).activePaneId, split: 'left' });
    await waitFor(() => expect(titles(ctx)).toContain('a.ts'));
    expect(Object.values(layoutOf(ctx).nodes).filter((n) => n.type === 'pane')).toHaveLength(2);
  });

  it('activates an already-open file instead of duplicating it', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));
    const count = allTabs(layoutOf(ctx)).length;

    ctx.current!.openFile('/repo/README.md');
    await new Promise((r) => setTimeout(r, 10));
    expect(allTabs(layoutOf(ctx))).toHaveLength(count);
  });

  it('opens a browser tab right of the current tab, not at the end', async () => {
    withBrowser();
    const { ctx } = mount();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    // Back on the first tab, then a browser tab: it lands between the two.
    const l = layoutOf(ctx);
    const pane = l.nodes[l.activePaneId] as { tabs: string[] };
    ctx.current!.dispatch({ type: 'setActiveTab', paneId: l.activePaneId, tabId: pane.tabs[0] });
    await waitFor(() => {
      const now = layoutOf(ctx);
      expect((now.nodes[now.activePaneId] as { activeTabId: string }).activeTabId).toBe(
        pane.tabs[0],
      );
    });
    ctx.current!.openBrowser!('');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(3));
    const after = layoutOf(ctx);
    const order = (after.nodes[after.activePaneId] as { tabs: string[] }).tabs.map(
      (id) => after.tabs[id].kind,
    );
    expect(order).toEqual(['conversation', 'webpage', 'terminal']);
  });

  it('activates the tab already showing a server instead of opening another', async () => {
    withBrowser();
    const { ctx } = mount();
    ctx.current!.openBrowser!('http://localhost:5173/');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    ctx.current!.openBrowser!('http://localhost:5173/checkout');
    await new Promise((r) => setTimeout(r, 10));
    const tabs = allTabs(layoutOf(ctx)).filter((t) => t.kind === 'webpage');
    expect(tabs).toHaveLength(1);
    // Not mounted here: the URL is recorded for the tab to load.
    expect(tabs[0].url).toBe('http://localhost:5173/checkout');
  });

  // Plan 28 › M3: every opener comes through openBrowser, so a remote
  // terminal's server nobody opened yet is forwarded here - the tab opens
  // the LOCAL URL main answers, never the host's own localhost.
  it('opens the local URL when the server is forwarded first', async () => {
    // The slot answers a remote terminal's server with the forward main
    // opened; the tab loads that, never the host's own localhost.
    const forward = vi.fn((url: string) =>
      url === 'http://localhost:5173' ? Promise.resolve('http://127.0.0.1:41234') : null,
    );
    withBrowser({ forward });
    const { ctx } = mount();
    ctx.current!.openBrowser!('http://localhost:5173');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(forward).toHaveBeenCalledWith('http://localhost:5173');
    expect(allTabs(layoutOf(ctx)).find((t) => t.kind === 'webpage')?.url).toBe(
      'http://127.0.0.1:41234',
    );
  });

  it('splits a pane with a new terminal', async () => {
    const { ctx } = mount();
    const rootId = layoutOf(ctx).rootId;
    ctx.current!.splitWithNewTerminal(rootId, 'right');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    // The root is now a split holding two panes.
    expect(layoutOf(ctx).rootId).not.toBe(rootId);
  });

  // Opening a terminal is the user picking the session back up: every
  // new-terminal action pulls it out of the archive (a no-op when it isn't
  // archived - the helper checks). Editor tabs don't count.
  it('unarchives the session when a terminal is opened in it', async () => {
    const { ctx } = mount();
    ctx.current!.addTerminal();
    expect(unarchiveSession).toHaveBeenCalledWith(SESSION);
    ctx.current!.addTemplateTerminal('Codex', 'codex');
    ctx.current!.splitWithNewTerminal(layoutOf(ctx).rootId, 'right');
    expect(unarchiveSession).toHaveBeenCalledTimes(3);
  });

  it('does not touch the archive when only a file is opened', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));
    expect(unarchiveSession).not.toHaveBeenCalled();
  });
});

describe('closing a terminal tab', () => {
  const openSecondTerminal = async (ctx: { current: WorkspaceLayoutContextValue | null }) => {
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(ctx.current!.layout)).toHaveLength(2));
    return allTabs(ctx.current!.layout).find((t) => t.kind !== 'conversation')!;
  };

  it('kills the shell behind the tab it closes', async () => {
    const { ctx } = mount();
    const tab = await openSecondTerminal(ctx);

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
    expect(disposePooledTerminal).toHaveBeenCalledWith(tab.ptyId);
  });

  it('asks before closing a tab that is still busy', async () => {
    const { ctx } = mount();
    const tab = await openSecondTerminal(ctx);
    busy.set(tab.ptyId!, 'running');

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(confirmCloseBusyTab).toHaveBeenCalled());
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
  });

  it('keeps the tab when the busy warning is declined', async () => {
    confirmCloseBusyTab.mockResolvedValue(false);
    const { ctx } = mount();
    const tab = await openSecondTerminal(ctx);
    busy.set(tab.ptyId!, 'needs-input');

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(confirmCloseBusyTab).toHaveBeenCalled());
    expect(allTabs(layoutOf(ctx))).toHaveLength(2);
    expect(disposePooledTerminal).not.toHaveBeenCalled();
  });

  it('does not ask about a quiet tab', async () => {
    const { ctx } = mount();
    const tab = await openSecondTerminal(ctx);

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
    expect(confirmCloseBusyTab).not.toHaveBeenCalled();
  });
});

describe('closing an editor with unsaved changes', () => {
  const openDirtyEditor = async (ctx: { current: WorkspaceLayoutContextValue | null }) => {
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));
    const tab = allTabs(ctx.current!.layout).find((t) => t.title === 'README.md')!;
    ctx.current!.setTabDirty(tab.id, true);
    await waitFor(() => expect(ctx.current!.dirtyTabs.has(tab.id)).toBe(true));
    return tab;
  };

  it('asks first', async () => {
    const { ctx } = mount();
    const tab = await openDirtyEditor(ctx);

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
  });

  it('keeps the tab when the user backs out', async () => {
    confirmDialog.mockResolvedValue(false);
    const { ctx } = mount();
    const tab = await openDirtyEditor(ctx);

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(titles(ctx)).toContain('README.md');
  });

  it('does not ask once the editor is saved again', async () => {
    const { ctx } = mount();
    const tab = await openDirtyEditor(ctx);
    ctx.current!.setTabDirty(tab.id, false);
    await waitFor(() => expect(ctx.current!.dirtyTabs.has(tab.id)).toBe(false));

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(titles(ctx)).not.toContain('README.md'));
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe('editor tabs follow the file on disk', () => {
  it('repoints an open editor when its file is renamed', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));

    ctx.current!.remapEditorPaths('/repo/README.md', '/repo/DOCS.md');

    await waitFor(() => expect(titles(ctx)).toContain('DOCS.md'));
    expect(titles(ctx)).not.toContain('README.md');
  });

  it('repoints editors under a renamed folder', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/src/a.ts');
    await waitFor(() => expect(titles(ctx)).toContain('a.ts'));

    ctx.current!.remapEditorPaths('/repo/src', '/repo/lib');

    await waitFor(() => {
      const tab = allTabs(ctx.current!.layout).find((t) => t.title === 'a.ts');
      expect(tab?.filePath).toBe('/repo/lib/a.ts');
    });
  });

  it('closes editors under a deleted folder', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/src/a.ts');
    await waitFor(() => expect(titles(ctx)).toContain('a.ts'));

    ctx.current!.closeEditorsUnder('/repo/src');

    await waitFor(() => expect(titles(ctx)).not.toContain('a.ts'));
  });

  it('leaves an editor outside the renamed folder alone', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/README.md');
    await waitFor(() => expect(titles(ctx)).toContain('README.md'));

    ctx.current!.remapEditorPaths('/repo/src', '/repo/lib');

    expect(titles(ctx)).toContain('README.md');
  });
});

describe('closing several tabs at once', () => {
  it('confirms busy tabs once, not per tab', async () => {
    const { ctx } = mount();
    ctx.current!.addTerminal();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(3));

    const extras = allTabs(layoutOf(ctx)).filter((t) => t.kind !== 'conversation');
    for (const tab of extras) busy.set(tab.ptyId!, 'running');

    await ctx.current!.closeTabs(extras.map((t) => t.id));

    expect(confirmCloseBusyTabs).toHaveBeenCalledTimes(1);
    expect(confirmCloseBusyTab).not.toHaveBeenCalled();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
  });

  it('closes nothing when the bulk warning is declined', async () => {
    confirmCloseBusyTabs.mockResolvedValue(false);
    const { ctx } = mount();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));

    const extras = allTabs(layoutOf(ctx)).filter((t) => t.kind !== 'conversation');
    busy.set(extras[0].ptyId!, 'running');

    await ctx.current!.closeTabs(extras.map((t) => t.id));

    expect(allTabs(layoutOf(ctx))).toHaveLength(2);
  });
});

describe('what "+" opens', () => {
  const SESSION_PROPS = { primaryTitle: 'Claude Code', startupCommand: 'claude' };

  /** Like `mount`, but re-renderable with new session props (the torn-off
   * window learns its session row after its first render). */
  function mountRerenderable(props: Partial<Parameters<typeof WorkspaceLayoutProvider>[0]>) {
    const seen: { current: WorkspaceLayoutContextValue | null } = { current: null };
    function Probe() {
      seen.current = useContext(WorkspaceLayoutContext);
      return null;
    }
    const tree = (p: Partial<Parameters<typeof WorkspaceLayoutProvider>[0]>) => (
      <WorkspaceLayoutProvider sessionId={SESSION} {...p}>
        <Probe />
      </WorkspaceLayoutProvider>
    );
    const view = render(tree(props));
    return { ctx: seen, rerender: (p: typeof props) => view.rerender(tree(p)) };
  }

  const added = (ctx: { current: WorkspaceLayoutContextValue | null }) =>
    allTabs(layoutOf(ctx)).find((t) => t.kind === 'terminal')!;

  it('inherits the session’s start command (and the agent title)', async () => {
    const { ctx } = mount({ ...SESSION_PROPS, runOnNewTerminal: true });
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBe('claude');
    expect(added(ctx).title).toBe('Claude Code 2');
  });

  it('opens a plain shell when the session opted out of running it on new terminals', async () => {
    const { ctx } = mount({ ...SESSION_PROPS, runOnNewTerminal: false });
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBeUndefined();
    expect(added(ctx).title).toBe('Terminal');
  });

  it('falls back to the session’s command once the conversation tab is gone', async () => {
    const noPrimary: WorkspaceLayout = {
      rootId: 'root',
      nodes: { root: { type: 'pane', id: 'root', tabs: ['t1'], activeTabId: 't1' } },
      tabs: { t1: { id: 't1', kind: 'terminal', title: 'Terminal', ptyId: 'pty-1' } },
      activePaneId: 'root',
    };
    const { ctx } = mount({ initial: noPrimary, ...SESSION_PROPS });
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    const tab = allTabs(layoutOf(ctx))[1];
    expect(tab.startupCommand).toBe('claude');
    expect(tab.title).toBe('Claude Code');
  });

  // A session started through a wrapper reads as "Claude Code"; the held "+"
  // menu's built-in "Claude Code" runs a bare `claude`, which launched the
  // agent under another account than the session's own tabs.
  it('runs the session’s command when the held "+" picks the session’s own agent', async () => {
    const { ctx } = mount({ primaryTitle: 'Claude Code', startupCommand: 'claude-personal' });
    ctx.current!.addTemplateTerminal('Claude Code', 'claude');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBe('claude-personal');
    expect(added(ctx).title).toBe('Claude Code 2');
  });

  it('runs the session’s command from the held "+" even with new terminals opted out', async () => {
    const { ctx } = mount({
      primaryTitle: 'Claude Code',
      startupCommand: 'claude-personal',
      runOnNewTerminal: false,
    });
    ctx.current!.addTemplateTerminal('Claude Code', 'claude');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBe('claude-personal');
  });

  it('runs another agent’s template command from the held "+" as is', async () => {
    const { ctx } = mount({ primaryTitle: 'Claude Code', startupCommand: 'claude-personal' });
    ctx.current!.addTemplateTerminal('Codex', 'codex');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBe('codex');
    expect(added(ctx).title).toBe('Codex');
  });

  it('picks the session up late - a torn-off window learns its row after mounting', async () => {
    // A detached session window seeds a bare layout (a never-opened session has
    // no live layout to carry over) and reads the session row afterwards: the
    // sync must retitle + command the conversation tab AND reach the next "+".
    const { ctx, rerender } = mountRerenderable({ initial: initialLayout(SESSION) });
    expect(titles(ctx)).toEqual(['Terminal']);
    expect(allTabs(layoutOf(ctx))[0].startupCommand).toBeUndefined();

    rerender({ initial: initialLayout(SESSION), ...SESSION_PROPS });
    await waitFor(() => expect(titles(ctx)).toEqual(['Claude Code']));
    expect(allTabs(layoutOf(ctx))[0].startupCommand).toBe('claude');

    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    expect(added(ctx).startupCommand).toBe('claude');
  });
});

describe('a closed tab takes its status with it', () => {
  // Closing the tab whose agent was waiting on you must re-derive the session's
  // status (and so its project's) from the tabs that remain: nobody observes
  // the killed shell's exit once the layout has dropped its tab.
  it('rechecks the session against the shells that remain', async () => {
    const { ctx } = mount();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    const tab = allTabs(layoutOf(ctx)).find((t) => t.kind !== 'conversation')!;

    ctx.current!.closeTab(tab.id);

    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
    expect(recheckSessionStatus).toHaveBeenCalledWith(
      SESSION,
      [conversationPtyId(SESSION)],
      [tab.ptyId],
    );
  });

  it('does not recheck for an editor - no shell was involved', async () => {
    const { ctx } = mount();
    ctx.current!.openFile('/repo/a.ts');
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(2));
    const editor = allTabs(layoutOf(ctx)).find((t) => t.kind === 'editor')!;

    ctx.current!.closeTab(editor.id);

    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
    expect(recheckSessionStatus).not.toHaveBeenCalled();
  });

  it('rechecks once for a batch, against what the whole chain leaves behind', async () => {
    const { ctx } = mount();
    ctx.current!.addTerminal();
    ctx.current!.addTerminal();
    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(3));
    const extras = allTabs(layoutOf(ctx)).filter((t) => t.kind !== 'conversation');

    await ctx.current!.closeTabs(extras.map((t) => t.id));

    await waitFor(() => expect(allTabs(layoutOf(ctx))).toHaveLength(1));
    expect(recheckSessionStatus).toHaveBeenCalledTimes(1);
    expect(recheckSessionStatus).toHaveBeenCalledWith(
      SESSION,
      [conversationPtyId(SESSION)],
      extras.map((t) => t.ptyId),
    );
  });
});
