import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShortcuts } from '@renderer/routes/_app/-components/workspace/workspace-shortcuts';
import { GitContext, type GitStatusValue } from '@renderer/lib/git/context';
import { addTab, initialLayout } from '@renderer/lib/workspace/layout';
import { FOCUS_FLASH_ATTR, endFocusFlash } from '@renderer/lib/workspace/focus-regions';
import { fakeLayoutContext, withLayout } from '@renderer/test-support';
import { setAppLocked } from '@renderer/lib/app-lock';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { CommandRunRequest } from '@renderer/lib/search/run-request';
import {
  activeCommandScope,
  withActiveWorkspace,
} from '@renderer/lib/search/search-workspace-bridge';

/**
 * The global key handler's gating: which focused element lets a workspace
 * shortcut through. The focus-direction commands must work from inside a file
 * editor too - otherwise keyboard navigation dead-ends on the first editor tab
 * (⇧⌘→ could never reach the next tab or the session-changes drawer) - and so
 * must close tab, while the editor keeps every other ⌘ combo, and plain inputs
 * keep all of them.
 */

// Vitest's jsdom UA has no "Mac", so the primary modifier is Ctrl here.
const combo = (code: string, extra: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { code, ctrlKey: true, bubbles: true, cancelable: true, ...extra });

function mount(props: Partial<Parameters<typeof WorkspaceShortcuts>[0]> = {}) {
  let layout = initialLayout('s1', 'Claude Code', 'claude');
  layout = addTab(layout, layout.activePaneId, {
    id: 'ed1',
    kind: 'editor',
    title: 'auth.ts',
    filePath: '/repo/auth.ts',
  });
  const ctx = fakeLayoutContext('s1', { layout });
  const git = { pull: vi.fn(), push: vi.fn() } as unknown as GitStatusValue;
  render(
    <GitContext.Provider value={git}>
      <WorkspaceShortcuts
        isActiveSession
        sessionId="s1"
        openOverlay={null}
        cwd={null}
        onToggleDock={vi.fn()}
        onToggleBottomPanel={vi.fn()}
        onNewSession={vi.fn()}
        {...props}
      />
    </GitContext.Provider>,
    { wrapper: withLayout(ctx) },
  );
  return ctx;
}

describe('WorkspaceShortcuts gating by the focused element', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="monaco-editor"><textarea class="inputarea"></textarea></div>
      <input id="plain" />
    `;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lets the focus-direction commands through from inside a file editor', () => {
    const ctx = mount();
    document.querySelector<HTMLElement>('.monaco-editor textarea')!.focus();
    // The editor tab (added last, so active): ← activates the previous tab.
    window.dispatchEvent(combo('ArrowLeft', { shiftKey: true }));
    expect(ctx.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setActiveTab', tabId: 'conversation' }),
    );
  });

  // Monaco binds nothing to ⌘W: held back for the editor, it closed nothing and
  // ⌘W read as dead on every file tab while it worked on terminal tabs.
  it('closes the editor tab on the close-tab combo', () => {
    const ctx = mount();
    document.querySelector<HTMLElement>('.monaco-editor textarea')!.focus();
    // Ctrl+Shift+W off macOS (`winCombo`); ⌘W on a Mac.
    window.dispatchEvent(combo('KeyW', { shiftKey: true }));
    expect(ctx.closeTab).toHaveBeenCalledWith('ed1');
  });

  // Monaco binds neither: held back like close tab once was, they would read
  // as dead on every file tab.
  it('cycles tabs and reopens a closed one from inside a file editor', () => {
    const ctx = mount();
    document.querySelector<HTMLElement>('.monaco-editor textarea')!.focus();
    // Ctrl+Tab off macOS: the editor tab is last, so next wraps to the first.
    window.dispatchEvent(combo('Tab'));
    expect(ctx.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setActiveTab', tabId: 'conversation' }),
    );
    window.dispatchEvent(combo('KeyT', { shiftKey: true, altKey: true }));
    expect(ctx.reopenClosedTab).toHaveBeenCalledTimes(1);
    // …and Ctrl+Shift+T is still New tab, not reopen.
    expect(ctx.addTerminal).not.toHaveBeenCalled();
  });

  it('leaves every other workspace combo to the editor', () => {
    const ctx = mount();
    document.querySelector<HTMLElement>('.monaco-editor textarea')!.focus();
    window.dispatchEvent(combo('KeyT')); // new tab
    expect(ctx.addTerminal).not.toHaveBeenCalled();
  });

  it('stands down while something covers the whole window', () => {
    // The cover makes the page inert, but this handler listens on `window`
    // in the capture phase - a key would still close a tab under it.
    const ctx = mount();
    setAppLocked(true);
    try {
      window.dispatchEvent(combo('KeyW', { shiftKey: true }));
      window.dispatchEvent(combo('ArrowLeft', { shiftKey: true }));
      expect(ctx.closeTab).not.toHaveBeenCalled();
      expect(ctx.dispatch).not.toHaveBeenCalled();
    } finally {
      setAppLocked(false);
    }
    window.dispatchEvent(combo('KeyW', { shiftKey: true }));
    expect(ctx.closeTab).toHaveBeenCalledWith('ed1');
  });

  it('ignores everything while a plain input has focus', () => {
    const ctx = mount();
    document.querySelector<HTMLElement>('#plain')!.focus();
    window.dispatchEvent(combo('ArrowLeft', { shiftKey: true }));
    window.dispatchEvent(combo('KeyT'));
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.addTerminal).not.toHaveBeenCalled();
  });
});

describe('WorkspaceShortcuts focus flash', () => {
  // Module state: the gating tests above press ⇧⌘← too.
  beforeEach(() => endFocusFlash());
  afterEach(() => {
    endFocusFlash();
    document.body.innerHTML = '';
  });

  it('lights the focus frame on a focus-direction command, and on no other', () => {
    mount();
    window.dispatchEvent(combo('KeyT')); // new tab
    expect(document.documentElement.hasAttribute(FOCUS_FLASH_ATTR)).toBe(false);
    window.dispatchEvent(combo('ArrowLeft', { shiftKey: true }));
    expect(document.documentElement.hasAttribute(FOCUS_FLASH_ATTR)).toBe(true);
  });
});

describe('WorkspaceShortcuts and the bottom panel', () => {
  afterEach(() => {
    endFocusFlash();
    document.body.innerHTML = '';
  });

  const dockMarkup = `
    <div data-focus-region="bottom">
      <div data-focus-part="list">
        <div tabindex="0" data-focus-item data-focus-key="dev" data-focus-current="true">dev</div>
      </div>
      <div data-focus-part="terminal">
        <div data-focus-item data-focus-current="true"><div class="xterm"><textarea id="dock-term"></textarea></div></div>
      </div>
    </div>
  `;

  it('walks down from the surface into an open dock, and between its list and terminal', () => {
    document.body.innerHTML = dockMarkup;
    mount({ bottomPanelOpen: true });
    window.dispatchEvent(combo('ArrowDown', { shiftKey: true }));
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('dev');
    window.dispatchEvent(combo('ArrowRight', { shiftKey: true }));
    expect(document.activeElement?.id).toBe('dock-term');
    window.dispatchEvent(combo('ArrowLeft', { shiftKey: true }));
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('dev');
  });

  it('does not enter the dock while it is closed (it stays mounted, hidden)', () => {
    document.body.innerHTML = dockMarkup;
    mount({ bottomPanelOpen: false });
    window.dispatchEvent(combo('ArrowDown', { shiftKey: true }));
    expect(document.activeElement).toBe(document.body);
  });

  /** A bottom panel, registered the way an extension registers it. */
  function withDock() {
    const requestRun = vi.fn<(sessionId: string, req: CommandRunRequest) => void>();
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      bottomPanel: { Dock: () => null, requestRun, usePaletteCommands: () => [] },
    });
    return requestRun;
  }

  it('opens a closed dock and hands it the run when the palette picks a command', () => {
    const requestRun = withDock();
    const onToggleBottomPanel = vi.fn();
    mount({ bottomPanelOpen: false, onToggleBottomPanel, projectId: 'p1' });
    const req = { id: 'auto:dev', name: 'dev', command: 'pnpm dev', openPreview: false };
    expect(withActiveWorkspace((a) => a.runShellCommand(req))).toBe(true);
    expect(onToggleBottomPanel).toHaveBeenCalledTimes(1);
    expect(requestRun).toHaveBeenCalledWith('s1', req);
    expect(activeCommandScope()).toEqual({ projectId: 'p1', cwd: null });
    resetRendererExtensionForTest();
  });

  it('never toggles an open dock shut to run a command', () => {
    withDock();
    const onToggleBottomPanel = vi.fn();
    mount({ bottomPanelOpen: true, onToggleBottomPanel });
    withActiveWorkspace((a) =>
      a.runShellCommand({ id: 'c1', name: 'test', command: 'pnpm test', openPreview: false }),
    );
    expect(onToggleBottomPanel).not.toHaveBeenCalled();
    resetRendererExtensionForTest();
  });

  it('does nothing with a run request in the core build (no dock)', () => {
    // The palette offers no command there; a stray request must not open a
    // dock that does not exist.
    const onToggleBottomPanel = vi.fn();
    mount({ bottomPanelOpen: false, onToggleBottomPanel });
    withActiveWorkspace((a) =>
      a.runShellCommand({ id: 'c1', name: 'test', command: 'pnpm test', openPreview: false }),
    );
    expect(onToggleBottomPanel).not.toHaveBeenCalled();
  });
});
