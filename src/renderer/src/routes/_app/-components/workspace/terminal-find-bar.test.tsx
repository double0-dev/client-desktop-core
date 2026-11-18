import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalFindBar } from '@renderer/routes/_app/-components/workspace/terminal-find-bar';
import { getTerminalFind, openTerminalFind, type FindRequest } from '@renderer/lib/terminal/find';

/**
 * The bar drives the pooled terminal's search addon: incremental search as you
 * type, ↩ / ⇧↩ / ⌘G to step, Esc to close and hand the caret back. The addon
 * is faked here - its own matching is xterm's, already tested upstream; what
 * matters is which calls the bar makes and what it shows for the results.
 */

const fake = vi.hoisted(() => {
  let emit: ((r: { resultIndex: number; resultCount: number }) => void) | undefined;
  const search = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((cb: typeof emit) => {
      emit = cb;
      return { dispose: vi.fn() };
    }),
  };
  const term = { focus: vi.fn() };
  return {
    search,
    term,
    results: (index: number, count: number) => emit?.({ resultIndex: index, resultCount: count }),
  };
});

vi.mock('@renderer/lib/terminal/pool', () => ({
  getPooledTerminal: () => ({ term: fake.term, search: fake.search }),
}));

const PTY = 'pty-find';

function request(seed = ''): FindRequest {
  openTerminalFind(PTY, seed);
  return getTerminalFind(PTY)!;
}

const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Find' });
const type = (text: string): void => {
  fireEvent.change(field(), { target: { value: text } });
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const f of [
    fake.search.findNext,
    fake.search.findPrevious,
    fake.search.clearDecorations,
    fake.term.focus,
  ])
    f.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TerminalFindBar', () => {
  it('searches incrementally as you type, with the design’s highlights', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    expect(fake.search.findNext).toHaveBeenLastCalledWith(
      'token',
      expect.objectContaining({
        incremental: true,
        caseSensitive: false,
        decorations: expect.objectContaining({ matchBackground: expect.stringMatching(/^#/) }),
      }),
    );
  });

  it('starts from the terminal’s selection and puts the caret in the field', () => {
    render(<TerminalFindBar ptyId={PTY} request={request('refreshToken')} />);
    act(() => vi.runOnlyPendingTimers());
    expect(field().value).toBe('refreshToken');
    expect(document.activeElement).toBe(field());
    expect(fake.search.findNext).toHaveBeenCalledWith('refreshToken', expect.anything());
  });

  it('shows the count the addon reports', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    act(() => fake.results(1, 7));
    expect(screen.getByText('2 of 7')).toBeTruthy();
    act(() => fake.results(-1, 0));
    expect(screen.getByText('No results')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next match' })).toHaveProperty('disabled', true);
  });

  it('steps with Enter and Shift+Enter, and with Ctrl+G off macOS', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    fake.search.findNext.mockClear();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(fake.search.findNext).toHaveBeenLastCalledWith(
      'token',
      expect.objectContaining({ incremental: false }),
    );
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(fake.search.findPrevious).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field(), { key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(fake.search.findPrevious).toHaveBeenCalledTimes(2);
  });

  it('passes the toggles to the search', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    fireEvent.click(screen.getByRole('button', { name: 'Match whole word' }));
    expect(screen.getByRole('button', { name: 'Match case' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(fake.search.findNext).toHaveBeenLastCalledWith(
      'token',
      expect.objectContaining({ caseSensitive: true, wholeWord: true, regex: false }),
    );
  });

  it('never searches an invalid regex and says so', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    fake.search.findNext.mockClear();
    type('a(b');
    expect(fake.search.findNext).not.toHaveBeenCalled();
    expect(fake.search.clearDecorations).toHaveBeenCalled();
    expect(screen.getByText('Invalid regex')).toBeTruthy();
  });

  it('clears the highlights when the query is emptied', () => {
    render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    fake.search.clearDecorations.mockClear();
    type('');
    expect(fake.search.clearDecorations).toHaveBeenCalled();
  });

  it('closes on Esc, clears the highlights and gives the terminal its caret back', () => {
    const { unmount } = render(<TerminalFindBar ptyId={PTY} request={request()} />);
    type('token');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(getTerminalFind(PTY)).toBeUndefined();
    expect(fake.term.focus).toHaveBeenCalled();
    unmount();
    expect(fake.search.clearDecorations).toHaveBeenCalled();
  });

  it('keeps a click in the bar from reaching the pane (which refocuses the terminal)', () => {
    const onPointerUp = vi.fn();
    render(
      <div onPointerUp={onPointerUp}>
        <TerminalFindBar ptyId={PTY} request={request()} />
      </div>,
    );
    fireEvent.pointerUp(field());
    expect(onPointerUp).not.toHaveBeenCalled();
  });
});
