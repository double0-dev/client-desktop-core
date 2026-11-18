import { describe, expect, it } from 'vitest';
import {
  EMPTY_SETUP,
  describeWorktreePrefill,
  describeWorktreeSetup,
  filesOnly,
  formatBytes,
  isWorktreeSetUp,
  missingPaths,
  togglePath,
  type IgnoredEntry,
} from './setup';

const SETUP = { worktreeCopyPaths: ['.env', '.env.local'], worktreeSetupCommand: 'pnpm install' };
const ENTRIES: IgnoredEntry[] = [
  { path: '.env', kind: 'file' },
  { path: '.env.local', kind: 'file' },
  { path: '.worktree/', kind: 'dir', locked: 'never copied' },
  { path: 'dist/', kind: 'dir', bytes: 48 * 1024 * 1024 },
  { path: 'node_modules/', kind: 'dir' },
];

describe('isWorktreeSetUp', () => {
  it('is false for the empty setup and for a blank command', () => {
    expect(isWorktreeSetUp(EMPTY_SETUP)).toBe(false);
    expect(isWorktreeSetUp({ worktreeCopyPaths: [], worktreeSetupCommand: '   ' })).toBe(false);
  });

  it('is true with paths or a command', () => {
    expect(isWorktreeSetUp({ worktreeCopyPaths: ['.env'], worktreeSetupCommand: null })).toBe(true);
    expect(isWorktreeSetUp({ worktreeCopyPaths: [], worktreeSetupCommand: 'npm ci' })).toBe(true);
  });
});

describe('describeWorktreeSetup', () => {
  it('reads "not set up" muted when nothing is configured', () => {
    expect(describeWorktreeSetup(EMPTY_SETUP, 11)).toEqual({
      text: 'Not set up - nothing is copied, no setup command',
      muted: true,
    });
  });

  it('counts ticks against the scan, then the command', () => {
    expect(describeWorktreeSetup(SETUP, 11)).toEqual({
      text: '2 of 11 ignored entries · pnpm install',
      muted: false,
    });
  });

  it('copes before a scan and with only one half configured', () => {
    expect(describeWorktreeSetup(SETUP, null).text).toBe('2 ignored entries · pnpm install');
    expect(
      describeWorktreeSetup({ worktreeCopyPaths: ['.env'], worktreeSetupCommand: null }, null).text,
    ).toBe('1 ignored entry · no setup command');
    expect(
      describeWorktreeSetup({ worktreeCopyPaths: [], worktreeSetupCommand: 'npm ci' }, 6).text,
    ).toBe('nothing copied · npm ci');
  });
});

describe('describeWorktreePrefill', () => {
  it('is null for a project that is not set up', () => {
    expect(describeWorktreePrefill('acme', EMPTY_SETUP)).toBeNull();
  });

  it('names the first two paths, elides the rest, and mentions the command', () => {
    const setup = {
      worktreeCopyPaths: ['.env', '.env.local', '.claude/settings.local.json', 'dist/'],
      worktreeSetupCommand: 'pnpm install',
    };
    expect(describeWorktreePrefill('production-pipeline', setup)).toBe(
      'production-pipeline copies 4 ignored entries (.env, .env.local, …) and runs pnpm install first - change this in Settings → Worktrees.',
    );
  });

  it('reads naturally with only one half configured', () => {
    expect(
      describeWorktreePrefill('acme', { worktreeCopyPaths: ['.env'], worktreeSetupCommand: null }),
    ).toBe('acme copies 1 ignored entry (.env) first - change this in Settings → Worktrees.');
    expect(
      describeWorktreePrefill('acme', { worktreeCopyPaths: [], worktreeSetupCommand: 'npm ci' }),
    ).toBe('acme runs npm ci first - change this in Settings → Worktrees.');
  });
});

describe('togglePath / filesOnly / missingPaths', () => {
  const order = ENTRIES.map((e) => e.path);

  it('keeps ticked paths in the listing order', () => {
    expect(togglePath(['dist/'], '.env', true, order)).toEqual(['.env', 'dist/']);
    expect(togglePath(['.env', 'dist/'], '.env', false, order)).toEqual(['dist/']);
    // Ticking twice is idempotent; a path the scan no longer lists sorts last.
    expect(togglePath(['.env'], '.env', true, order)).toEqual(['.env']);
    expect(togglePath(['gone.txt'], '.env', true, order)).toEqual(['.env', 'gone.txt']);
  });

  it('"Files only" takes every unlocked file and no folder', () => {
    expect(filesOnly(ENTRIES)).toEqual(['.env', '.env.local']);
  });

  it('reports ticked paths the scan no longer lists', () => {
    expect(
      missingPaths({ ...SETUP, worktreeCopyPaths: ['.env', '.env.production'] }, ENTRIES),
    ).toEqual(['.env.production']);
  });
});

describe('formatBytes', () => {
  it('picks the unit and rounds like the design', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12 * 1024)).toBe('12 KB');
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB');
    expect(formatBytes(1.3 * 1024 ** 3)).toBe('1.3 GB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
  });
});
