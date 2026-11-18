import { describe, expect, it } from 'vitest';
import { validateTagName } from '@renderer/lib/git/tag-name';

/**
 * The dialog refuses what git's check-ref-format refuses, so the user reads
 * why in the field instead of a git error after the fact. Each case is one
 * git rule; the last is the app's own (an existing tag).
 */
describe('validateTagName', () => {
  it('accepts ordinary release tags, case and all', () => {
    for (const ok of ['v1.4.0', 'v1.4.0-RC1', 'release/2026.09', 'Release_1', '1.0']) {
      expect(validateTagName(ok)).toBeNull();
    }
  });

  it('trims surrounding whitespace before judging', () => {
    expect(validateTagName('  v1.4.0  ')).toBeNull();
  });

  it('wants a name at all', () => {
    expect(validateTagName('')).toBe('Enter a tag name');
    expect(validateTagName('   ')).toBe('Enter a tag name');
  });

  it('refuses the characters a ref name cannot hold', () => {
    for (const bad of ['v 1', 'v~1', 'v^1', 'v:1', 'v?1', 'v*1', 'v[1', 'v\\1', 'v\t1']) {
      expect(validateTagName(bad)).toMatch(/spaces or/);
    }
  });

  it('refuses the reserved sequences', () => {
    expect(validateTagName('v1..2')).toMatch(/“\.\.”/);
    expect(validateTagName('v1@{0}')).toMatch(/“@\{”/);
    expect(validateTagName('@')).toMatch(/“@\{”/);
  });

  it('refuses a leading dash - git would read it as an option', () => {
    expect(validateTagName('-v1')).toBe('Tag names can’t start with “-”');
  });

  it('refuses the dot and slash shapes git rejects', () => {
    expect(validateTagName('.v1')).toMatch(/start with “\.”/);
    expect(validateTagName('release/.hidden')).toMatch(/start with “\.”/);
    expect(validateTagName('v1.')).toMatch(/end with “\.”/);
    expect(validateTagName('v1.lock')).toMatch(/“\.lock”/);
    expect(validateTagName('/v1')).toMatch(/“\/”/);
    expect(validateTagName('v1/')).toMatch(/“\/”/);
    expect(validateTagName('a//b')).toMatch(/“\/”/);
  });

  it('refuses a name the repo already has, exactly (tags are case-sensitive)', () => {
    expect(validateTagName('v1.4.0', ['v1.3.0', 'v1.4.0'])).toBe(
      'A tag named v1.4.0 already exists.',
    );
    expect(validateTagName('V1.4.0', ['v1.4.0'])).toBeNull();
  });
});
