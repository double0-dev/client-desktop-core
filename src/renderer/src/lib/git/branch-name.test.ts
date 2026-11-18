import { describe, expect, it } from 'vitest';
import {
  normalizeBranchName,
  sanitizeWorktreeName,
  uniqueBranchName,
  validateBranchName,
} from '@renderer/lib/git/branch-name';

describe('sanitizeWorktreeName', () => {
  it('lowercases the session name so branches never differ only by case', () => {
    // Two sessions named "Fix Auth" and "fix auth" would otherwise want
    // `.worktree/Fix-Auth` and `.worktree/fix-auth` - distinct git refs that
    // collide on a case-insensitive filesystem.
    expect(sanitizeWorktreeName('Fix Auth')).toBe('fix-auth');
    expect(sanitizeWorktreeName('FIX LOGIN REDIRECT')).toBe('fix-login-redirect');
    expect(sanitizeWorktreeName('Fix Auth')).toBe(sanitizeWorktreeName('fix auth'));
  });

  it('lowercases non-ASCII letters too', () => {
    expect(sanitizeWorktreeName('Ändere Größe')).toBe('ändere-größe');
  });

  it('replaces every character git forbids in a ref name with a single dash', () => {
    expect(sanitizeWorktreeName('Feature/Sub Task')).toBe('feature-sub-task');
    expect(sanitizeWorktreeName('a~b^c:d?e*f[g\\h')).toBe('a-b-c-d-e-f-g-h');
    expect(sanitizeWorktreeName('Fix   Auth')).toBe('fix-auth');
  });

  it('keeps letters, digits, underscores and dots', () => {
    expect(sanitizeWorktreeName('Release_2.0')).toBe('release_2.0');
  });

  it('rewrites the reserved @{ and illegal .. sequences', () => {
    expect(sanitizeWorktreeName('HEAD@{1}')).toBe('head-1}');
    expect(sanitizeWorktreeName('a..b')).toBe('a.b');
  });

  it('trims leading/trailing dashes and dots, which git rejects', () => {
    expect(sanitizeWorktreeName('  -Fix Auth-  ')).toBe('fix-auth');
    expect(sanitizeWorktreeName('.hidden.')).toBe('hidden');
  });

  it('caps the name at 60 characters without leaving a trailing dash', () => {
    const name = sanitizeWorktreeName(`${'A'.repeat(59)} tail`);
    expect(name).toHaveLength(59);
    expect(name).toBe('a'.repeat(59));
  });

  it('returns empty for a name with nothing usable, so launch can refuse it', () => {
    expect(sanitizeWorktreeName('///')).toBe('');
    expect(sanitizeWorktreeName('   ')).toBe('');
  });
});

describe('normalizeBranchName', () => {
  it('lowercases a user-typed branch name', () => {
    expect(normalizeBranchName('Feature/ABC-123')).toBe('feature/abc-123');
  });

  it('keeps slashes - a typed branch is not confined to the flat .worktree/ layout', () => {
    expect(normalizeBranchName('feature/my-branch')).toBe('feature/my-branch');
  });
});

describe('uniqueBranchName', () => {
  it('keeps the wanted name when nothing uses it', () => {
    expect(uniqueBranchName('prod-142-rate-limit', ['main', 'dev'])).toBe('prod-142-rate-limit');
  });

  it('suffixes -2 when the branch exists - a second session for the same ticket', () => {
    // The first launch from PROD-142 took the plain name; `git worktree add -b`
    // would refuse it for the second, which is the launch that used to fail.
    expect(uniqueBranchName('prod-142-rate-limit', ['prod-142-rate-limit'])).toBe(
      'prod-142-rate-limit-2',
    );
  });

  it('skips every taken suffix, not just the first', () => {
    expect(
      uniqueBranchName('fix-auth', ['fix-auth', 'fix-auth-2', 'fix-auth-3', 'fix-auth-5']),
    ).toBe('fix-auth-4');
  });

  it('treats names differing only by case as taken (case-insensitive .worktree/ folders)', () => {
    expect(uniqueBranchName('fix-auth', ['Fix-Auth'])).toBe('fix-auth-2');
  });
});

describe('validateBranchName', () => {
  it('accepts a plain or foldered name', () => {
    expect(validateBranchName('fix-auth-clock-skew')).toBeNull();
    expect(validateBranchName('feat/rate-limiting', ['main'])).toBeNull();
  });

  it('refuses what git would refuse, naming a branch - not a tag', () => {
    expect(validateBranchName('has space')).toBe(
      'Branch names can’t contain spaces or ~ ^ : ? * [ \\',
    );
    expect(validateBranchName('a..b')).toMatch(/^Branch names can’t contain “\.\.”/);
    expect(validateBranchName('-f')).toMatch(/start with “-”/);
    expect(validateBranchName('x.lock')).toMatch(/\.lock/);
    expect(validateBranchName('   ')).toBe('Enter a branch name');
  });

  it('refuses a name another branch has, but not the branch being renamed', () => {
    expect(validateBranchName('main', ['main', 'dev'])).toBe('A branch named main already exists.');
    expect(validateBranchName('dev', ['main', 'dev'], 'dev')).toBeNull();
  });
});
