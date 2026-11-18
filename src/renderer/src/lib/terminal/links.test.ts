import type { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFileLinkContext } from '@renderer/lib/terminal/file-links';
import {
  activateTerminalLink,
  createOsc8LinkHandler,
  hideLinkHint,
  isOpenableUrl,
  LINK_HINT_TEXT,
  linkDestination,
  showLinkHint,
} from '@renderer/lib/terminal/links';

// jsdom is not a Mac, so the opening modifier is Ctrl here.
const click = (init: Partial<MouseEvent> = {}): MouseEvent =>
  ({ metaKey: false, ctrlKey: false, clientX: 0, clientY: 0, ...init }) as MouseEvent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('where a link opens (a private plan)', () => {
  it('opens a dev server in a browser tab and the internet outside; Shift swaps them', () => {
    expect(linkDestination('http://localhost:5173/', false)).toBe('app');
    expect(linkDestination('https://example.com', false)).toBe('system');
    expect(linkDestination('http://localhost:5173/', true)).toBe('system');
    expect(linkDestination('https://example.com', true)).toBe('app');
  });

  it("hands a localhost link to the terminal's workspace, not the system browser", () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const openUrl = vi.fn();
    const off = setFileLinkContext('pty-1', { cwd: '/repo', open: vi.fn(), openUrl });
    expect(activateTerminalLink(click({ ctrlKey: true }), 'http://localhost:5173/', 'pty-1')).toBe(
      true,
    );
    expect(openUrl).toHaveBeenCalledWith('http://localhost:5173/');
    expect(open).not.toHaveBeenCalled();
    // Shift-click sends it out instead.
    activateTerminalLink(
      click({ ctrlKey: true, shiftKey: true }),
      'http://localhost:5173/',
      'pty-1',
    );
    expect(open).toHaveBeenCalledWith('http://localhost:5173/');
    off();
  });

  it('falls back to the system browser for a terminal with no workspace', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    activateTerminalLink(click({ ctrlKey: true }), 'http://localhost:5173/', 'pty-none');
    expect(open).toHaveBeenCalledWith('http://localhost:5173/');
  });
});

describe('opening links', () => {
  it('opens a web link only on a modifier click', () => {
    // A bare click selects text or reaches a TUI - it must never launch a
    // browser by accident.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(activateTerminalLink(click(), 'https://example.com')).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(activateTerminalLink(click({ ctrlKey: true }), 'https://example.com')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com');
  });

  it('never opens anything but http(s), even on a modifier click', () => {
    // A program can print (or OSC 8) any URI; file:// and custom schemes stay text.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const uri of ['file:///etc/passwd', 'vscode://x', 'javascript:alert(1)', 'not a url']) {
      expect(activateTerminalLink(click({ ctrlKey: true }), uri)).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    expect(isOpenableUrl('http://localhost:5173/')).toBe(true);
  });

  it('routes OSC 8 hyperlinks through the same rule instead of a confirm()', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm');
    const term = { element: document.createElement('div') } as unknown as Terminal;
    const handler = createOsc8LinkHandler(term);
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
    handler.activate(click(), 'https://example.com/a', range);
    handler.activate(click({ ctrlKey: true }), 'https://example.com/b', range);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/b');
    expect(confirm).not.toHaveBeenCalled();
    expect(handler.allowNonHttpProtocols).toBe(false);
  });
});

describe('the hover hint', () => {
  it('shows one hint inside the terminal element and removes it on leave', () => {
    const element = document.createElement('div');
    const term = { element } as unknown as Terminal;
    showLinkHint(term, click({ clientX: 40, clientY: 10 }));
    showLinkHint(term, click({ clientX: 60, clientY: 10 }));
    const hints = element.querySelectorAll('.xterm-hover');
    expect(hints).toHaveLength(1);
    expect(hints[0].textContent).toBe(LINK_HINT_TEXT);
    expect(LINK_HINT_TEXT).toBe('Ctrl-click to open');
    expect((hints[0] as HTMLElement).style.left).toBe('72px');
    hideLinkHint(term);
    expect(element.querySelector('.xterm-hover')).toBeNull();
  });
});
