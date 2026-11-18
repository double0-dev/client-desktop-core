import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * Settings → Worktrees (design `Screen/Settings - Worktrees` and
 * `· production-pipeline`). The section is a per-project list that opens a
 * project's own screen: what matters is that the list summarises each
 * project's setup against a live scan, that the project screen shows the
 * checkout's ignored entries with the ticked ones checked and the locked ones
 * unticked, and that a tick or a command lands on the project row.
 */

const PROJECTS = [
  {
    id: 'p-prod',
    name: 'production-pipeline',
    path: '/repo/production-pipeline',
    color: '#a8c945',
    pinned: false,
    sortOrder: 0,
    worktreeCopyPaths: ['.env', '.env.production'],
    worktreeSetupCommand: 'pnpm install',
  },
  {
    id: 'p-ds',
    name: 'design-system',
    path: '/repo/design-system',
    color: '#6366f1',
    pinned: false,
    sortOrder: 1,
    worktreeCopyPaths: [],
    worktreeSetupCommand: null,
  },
  // No folder: can't have worktrees, so it never shows up.
  {
    id: 'p-none',
    name: 'notes',
    path: null,
    color: '#ec4899',
    pinned: false,
    sortOrder: 2,
    worktreeCopyPaths: [],
    worktreeSetupCommand: null,
  },
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

const ENTRIES = [
  { path: '.env', kind: 'file' },
  { path: '.worktree/', kind: 'dir', locked: 'never copied' },
  { path: 'node_modules/', kind: 'dir', bytes: 1.3 * 1024 ** 3 },
];

let ignoredEntries: ReturnType<typeof vi.fn>;

async function renderSection() {
  ignoredEntries = vi.fn(async (cwd: string, opts?: { sizes?: boolean }) =>
    cwd === '/repo/design-system'
      ? { root: null, entries: [] }
      : {
          root: cwd,
          entries: opts?.sizes ? ENTRIES : ENTRIES.map(({ bytes, ...e }) => (void bytes, e)),
        },
  );
  stubApi({ git: { ignoredEntries } });
  vi.resetModules();
  const { WorktreesSettingsSection } =
    await import('@renderer/routes/_app/-components/settings/worktrees-section');
  render(<WorktreesSettingsSection />);
}

/** Radix blanks body pointer-events while a dialog is open; none here, but keep the shape. */
const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

/** Draft-style update: run the recipe against a copy of the row and return it. */
const applied = (id: string): Record<string, unknown> => {
  const call = update.mock.calls.at(-1);
  expect(call?.[0]).toBe(id);
  const draft = structuredClone(PROJECTS.find((p) => p.id === id)) as Record<string, unknown>;
  (call?.[1] as (d: Record<string, unknown>) => void)(draft);
  return draft;
};

describe('Settings → Worktrees', () => {
  beforeEach(() => {
    update.mockClear();
  });

  it('lists folder-backed projects with a summary against the live scan', async () => {
    await renderSection();
    const prod = await screen.findByRole('button', { name: /production-pipeline/ });
    // Two ticked (one no longer in the checkout) against three scanned entries.
    expect(within(prod).getByText('2 of 3 ignored entries · pnpm install')).toBeTruthy();
    const ds = screen.getByRole('button', { name: /design-system/ });
    expect(within(ds).getByText(/Not a git repository/)).toBeTruthy();
    expect((ds as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('notes')).toBeNull();
    // The list never asks for folder sizes.
    for (const call of ignoredEntries.mock.calls) expect(call[1]).toEqual({ sizes: false });
  });

  it("opens a project's screen: ticked entries checked, locked ones inert, sizes shown", async () => {
    const user = setup();
    await renderSection();
    await user.click(await screen.findByRole('button', { name: /production-pipeline/ }));
    const env = await screen.findByRole('checkbox', { name: 'Copy .env into new worktrees' });
    expect(env.getAttribute('aria-checked')).toBe('true');
    const nm = screen.getByRole('checkbox', { name: 'Copy node_modules/ into new worktrees' });
    expect(nm.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('1.3 GB')).toBeTruthy();
    const wt = screen.getByRole('checkbox', { name: 'Copy .worktree/ into new worktrees' });
    expect((wt as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('never copied')).toBeTruthy();
    // A ticked path the scan no longer lists stays visible, flagged.
    expect(screen.getByText('.env.production')).toBeTruthy();
    expect(screen.getByText('not in checkout')).toBeTruthy();
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm install');
  });

  it('saves ticks and the command onto the project row', async () => {
    const user = setup();
    await renderSection();
    await user.click(await screen.findByRole('button', { name: /production-pipeline/ }));
    await user.click(
      await screen.findByRole('checkbox', { name: 'Copy node_modules/ into new worktrees' }),
    );
    expect(applied('p-prod').worktreeCopyPaths).toEqual([
      '.env',
      'node_modules/',
      '.env.production',
    ]);

    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(applied('p-prod').worktreeCopyPaths).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Files only' }));
    expect(applied('p-prod').worktreeCopyPaths).toEqual(['.env']);

    const command = screen.getByLabelText('Setup command');
    await user.clear(command);
    await user.type(command, 'npm ci{Enter}');
    expect(applied('p-prod').worktreeSetupCommand).toBe('npm ci');
  });
});
