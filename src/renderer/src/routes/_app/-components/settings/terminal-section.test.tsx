import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getTerminalSettings,
  updateTerminalSettings,
} from '@renderer/lib/settings/terminal-settings';
import { stubApi } from '@renderer/test-support';

/**
 * Settings › Terminal › Renderer (plan 34): the engine is picked once per
 * window at boot, so the row offers a reload while the stored choice and the
 * running engine differ, and says so when the Ghostty engine failed to load.
 */

const engine = vi.hoisted(() => ({
  chosen: 'xterm' as 'xterm' | 'ghostty',
  running: 'xterm' as 'xterm' | 'ghostty',
}));

vi.mock('@renderer/lib/terminal/engine', () => ({
  terminalEngine: () => engine.running,
  chosenTerminalEngine: () => engine.chosen,
}));

const { TerminalSettingsSection } = await import('./terminal-section');

const user = userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  stubApi();
  engine.chosen = 'xterm';
  engine.running = 'xterm';
  updateTerminalSettings({ engine: 'xterm' });
});

describe('Settings › Terminal › Renderer', () => {
  it('stores the choice and offers a reload until it matches the running engine', async () => {
    render(<TerminalSettingsSection />);
    const select = screen.getByLabelText('Renderer');
    expect(select).toHaveValue('xterm');
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();

    await user.selectOptions(select, 'ghostty');
    expect(getTerminalSettings().engine).toBe('ghostty');
    expect(screen.getByText(/This window still runs xterm\.js/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload now' })).toBeInTheDocument();

    // Back to what the window runs: nothing left to reload for.
    await user.selectOptions(select, 'xterm');
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();
  });

  it('names the running Ghostty engine when switching back to xterm.js', async () => {
    engine.chosen = 'ghostty';
    engine.running = 'ghostty';
    updateTerminalSettings({ engine: 'ghostty' });
    render(<TerminalSettingsSection />);
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Renderer'), 'xterm');
    expect(screen.getByText(/This window still runs Ghostty\./)).toBeInTheDocument();
  });

  it('says the Ghostty engine failed to load instead of offering a reload that would fail again', () => {
    engine.chosen = 'ghostty';
    engine.running = 'xterm';
    updateTerminalSettings({ engine: 'ghostty' });
    render(<TerminalSettingsSection />);
    expect(screen.getByText(/The Ghostty engine failed to load/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();
  });
});
