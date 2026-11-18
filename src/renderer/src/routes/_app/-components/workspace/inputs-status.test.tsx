import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputEntry, InputReach } from '@renderer/lib/terminal/inputs';
import { InputsStatusItem } from './inputs-status';

/**
 * The status bar's Inputs item and popover over a faked input store: what the
 * item says for the focused tab, how the popover lists the tab's inputs
 * (sections per program run, the states a row can be in) and how picking
 * one - click or keyboard - reaches the jump. The store itself runs against
 * real xterm parsing in lib/terminal/inputs.test.ts.
 */

const store = vi.hoisted(() => ({
  entries: [] as InputEntry[],
  reach: new Map<number, InputReach>(),
  jump: vi.fn(async () => true),
}));

vi.mock('@renderer/lib/terminal/inputs', () => ({
  useTerminalInputs: (ptyId: string | null) => (ptyId ? store.entries : []),
  inputReach: () => store.reach,
  jumpToInput: store.jump,
}));

let seq = 0;
function entry(
  fields: Partial<InputEntry> & Pick<InputEntry, 'kind' | 'text'>,
  reach: InputReach = 'jump',
): InputEntry {
  const e: InputEntry = {
    seq: ++seq,
    program: fields.kind === 'prompt' ? 'claude' : 'shell',
    lines: fields.text.split('\n').length,
    truncated: false,
    at: Date.now(),
    exitCode: null,
    gone: false,
    run: 0,
    ref: null,
    ...fields,
  };
  store.reach.set(e.seq, reach);
  return e;
}

beforeEach(() => {
  store.entries = [];
  store.reach = new Map();
  store.jump.mockClear();
});

const user = () => userEvent.setup({ pointerEventsCheck: 0 });
const open = async () => {
  await user().click(screen.getByRole('button', { name: /^Inputs:/ }));
  return screen.getByRole('dialog', { name: 'Inputs' });
};
const selected = (): string | undefined =>
  screen.queryAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')
    ?.textContent ?? undefined;

describe('InputsStatusItem', () => {
  it('shows nothing while an editor tab is focused', () => {
    const { container } = render(<InputsStatusItem focusedPtyId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the focused tab's inputs", () => {
    store.entries = [
      entry({ kind: 'command', text: 'ls' }),
      entry({ kind: 'command', text: 'pwd' }),
    ];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    expect(screen.getByRole('button', { name: 'Inputs: 2 inputs' })).toBeInTheDocument();
  });

  it('lists the inputs in sections per program run, with their states', async () => {
    store.entries = [
      entry({ kind: 'command', text: 'pnpm install' }, 'out'),
      entry({ kind: 'command', text: 'pnpm test auth', exitCode: 1 }),
      entry({ kind: 'prompt', text: 'why does pnpm test auth fail?\nsee the log\nand fix' }),
      entry({ kind: 'command', text: 'git status', exitCode: 0 }, 'screen'),
    ];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    const dialog = await open();
    expect(within(dialog).getByText('4 in this tab')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Shell')).toHaveLength(2);
    expect(within(dialog).getByText('Claude Code')).toBeInTheDocument();
    const [install, test, prompt, status] = within(dialog).getAllByRole('option');
    expect(install).toHaveTextContent('scrolled out');
    expect(install).toHaveAttribute('aria-disabled', 'true');
    expect(test).toHaveTextContent('exit 1');
    // A successful command says nothing about its status.
    expect(status).not.toHaveTextContent('exit');
    expect(status).toHaveTextContent('on screen');
    // The first line only, with the rest counted.
    expect(prompt).toHaveTextContent('why does pnpm test auth fail?');
    expect(prompt).toHaveTextContent('+2 lines');
    expect(prompt).not.toHaveTextContent('see the log');
  });

  it('jumps to a clicked input and stays open for the next one', async () => {
    const target = entry({ kind: 'prompt', text: 'add a regression test' });
    store.entries = [target, entry({ kind: 'prompt', text: 'fix it' }, 'screen')];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    const dialog = await open();
    await user().click(within(dialog).getByText('add a regression test'));
    expect(store.jump).toHaveBeenCalledWith('pty-1', target);
    expect(screen.getByRole('dialog', { name: 'Inputs' })).toBeInTheDocument();
  });

  it('never jumps to an input that left the terminal', async () => {
    store.entries = [entry({ kind: 'command', text: 'pnpm install' }, 'out')];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    const dialog = await open();
    await user().click(within(dialog).getByText('pnpm install'));
    expect(store.jump).not.toHaveBeenCalled();
  });

  it('starts on the newest input and walks with the arrows, skipping unreachable ones', async () => {
    const first = entry({ kind: 'command', text: 'pnpm lint' });
    store.entries = [
      first,
      entry({ kind: 'command', text: 'pnpm install' }, 'out'),
      entry({ kind: 'command', text: 'git status' }, 'screen'),
    ];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    await open();
    expect(selected()).toContain('git status');
    await user().keyboard('{ArrowUp}');
    expect(selected()).toContain('pnpm lint');
    await user().keyboard('{ArrowUp}');
    expect(selected()).toContain('pnpm lint');
    await user().keyboard('{Enter}');
    expect(store.jump).toHaveBeenCalledWith('pty-1', first);
  });

  it('filters as you type - the field has focus from the start', async () => {
    store.entries = [
      entry({ kind: 'command', text: 'pnpm test auth' }),
      entry({ kind: 'prompt', text: 'explain the auth flow' }),
      entry({ kind: 'command', text: 'git status' }),
    ];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    const dialog = await open();
    expect(within(dialog).getByRole('textbox', { name: 'Filter inputs' })).toHaveFocus();
    await user().keyboard('AUTH');
    expect(within(dialog).getAllByRole('option')).toHaveLength(2);
    await user().keyboard('zzz');
    expect(within(dialog).getByText('No inputs match.')).toBeInTheDocument();
  });

  it('explains an empty list, and why a resumed conversation starts with one', async () => {
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    const dialog = await open();
    expect(within(dialog).getByText(/Commands and prompts you enter/)).toBeInTheDocument();
    // A resumed Claude tab in a new shell shows its whole conversation over an
    // empty list; a shell kept running across a restart keeps its list, so the
    // copy must not claim every restart empties it.
    expect(within(dialog).getByText(/a new shell starts with an empty one/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/after the app restarts/)).toBeNull();
  });

  it('closes on Esc', async () => {
    store.entries = [entry({ kind: 'command', text: 'ls' })];
    render(<InputsStatusItem focusedPtyId="pty-1" />);
    await open();
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inputs' })).not.toBeInTheDocument();
  });
});
