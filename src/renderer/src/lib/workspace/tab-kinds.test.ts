import { afterEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { BrowserSlot, SessionViewSlot } from '@renderer/lib/extension/types';
import { CORE_TAB_KINDS, rendersTabKind, showsView } from './tab-kinds';

afterEach(() => resetRendererExtensionForTest());

describe('rendersTabKind', () => {
  it('renders every kind the core build has today', () => {
    // A kind leaves this list only when it moves to an extension.
    expect([...CORE_TAB_KINDS].sort()).toEqual(['conversation', 'editor', 'terminal'].sort());
    for (const kind of CORE_TAB_KINDS) expect(rendersTabKind(kind)).toBe(true);
  });

  it('renders page tabs only where an extension registered their kind', () => {
    // A layout written by a build with page tabs keeps them in a build
    // without - they show the placeholder. `webpage` stands for its kind.
    expect(rendersTabKind('webpage')).toBe(false);
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      browser: { tabKind: 'webpage' } as BrowserSlot,
    });
    expect(rendersTabKind('webpage')).toBe(true);
  });

  it("renders a view's tabs, and shows a tab in it, only with the session-view slot", () => {
    // A tab a build with the view saved in it shows its terminal in a build
    // without it - which then takes the keys. `gadget` stands for any view.
    expect(rendersTabKind('gadget')).toBe(false);
    expect(showsView({ view: 'gadget' })).toBe(false);
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      sessionView: { view: 'gadget' } as SessionViewSlot,
    });
    expect(rendersTabKind('gadget')).toBe(true);
    expect(showsView({ view: 'gadget' })).toBe(true);
    expect(showsView({ view: undefined })).toBe(false);
    // Another view's tab is not this one's.
    expect(showsView({ view: 'other' })).toBe(false);
  });

  it('does not render a kind it has never heard of', () => {
    expect(rendersTabKind('canvas')).toBe(false);
    expect(rendersTabKind('')).toBe(false);
  });
});
