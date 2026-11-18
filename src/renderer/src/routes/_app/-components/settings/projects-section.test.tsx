import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECTS = [
  { id: 'p1', name: 'shop', path: '/r/shop', color: null, pinned: false, sortOrder: 0 },
  { id: 'p2', name: 'docs', path: '/r/docs', color: '#4f9cf7', pinned: false, sortOrder: 1 },
];

vi.mock('@tanstack/react-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-db')>()),
  useLiveQuery: () => ({ data: PROJECTS, isReady: true }),
}));

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@renderer/lib/collections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/collections')>()),
  projectsCollection: { update },
}));

const { ProjectsSettingsSection } = await import('./projects-section');

/** Run the draft mutator of update call `n` and answer the color it wrote. */
function writtenColor(n: number): string | null {
  const draft = { color: 'unset' as string | null };
  (update.mock.calls[n][1] as (d: typeof draft) => void)(draft);
  return draft.color;
}

describe('Settings › Projects', () => {
  beforeEach(() => update.mockClear());

  it('marks a project with no color as following the accent', () => {
    render(<ProjectsSettingsSection />);
    const shop = within(screen.getByRole('group', { name: 'shop' }));
    expect(
      shop
        .getByRole('button', { name: 'No color - follows the accent color' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(shop.getByLabelText('Project color hex value')).toHaveProperty('value', '');
  });

  it('writes a preset to the project row', async () => {
    render(<ProjectsSettingsSection />);
    const shop = within(screen.getByRole('group', { name: 'shop' }));
    await userEvent.click(shop.getByRole('button', { name: 'Use the Teal project color' }));
    expect(update.mock.calls[0][0]).toBe('p1');
    expect(writtenColor(0)).toBe('#2fbfa5');
  });

  it('clears a color back to none', async () => {
    render(<ProjectsSettingsSection />);
    const docs = within(screen.getByRole('group', { name: 'docs' }));
    expect(
      docs.getByRole('button', { name: 'Use the Blue project color' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await userEvent.click(
      docs.getByRole('button', { name: 'No color - follows the accent color' }),
    );
    expect(update.mock.calls[0][0]).toBe('p2');
    expect(writtenColor(0)).toBeNull();
  });

  it('takes a custom hex typed into the field, and an emptied field as none', async () => {
    const user = userEvent.setup();
    render(<ProjectsSettingsSection />);
    const docs = within(screen.getByRole('group', { name: 'docs' }));
    const hex = docs.getByLabelText('Project color hex value');
    await user.clear(hex);
    await user.paste('12AB34');
    await user.keyboard('{Enter}');
    expect(writtenColor(0)).toBe('#12ab34');
    await user.clear(hex);
    await user.keyboard('{Enter}');
    expect(writtenColor(1)).toBeNull();
  });

  it('ignores an invalid hex and restores the stored value', async () => {
    const user = userEvent.setup();
    render(<ProjectsSettingsSection />);
    const docs = within(screen.getByRole('group', { name: 'docs' }));
    const hex = docs.getByLabelText('Project color hex value');
    await user.clear(hex);
    await user.paste('nope');
    await user.keyboard('{Enter}');
    expect(update).not.toHaveBeenCalled();
    expect(hex).toHaveProperty('value', '#4f9cf7');
  });

  it('switches project colors as the accent off and back on', async () => {
    const { getProjectAccentEnabled } = await import('@renderer/lib/settings/accent-color');
    render(<ProjectsSettingsSection />);
    const toggle = screen.getByRole('switch', { name: 'Use project colors as the accent' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    expect(getProjectAccentEnabled()).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    expect(getProjectAccentEnabled()).toBe(true);
  });
});
