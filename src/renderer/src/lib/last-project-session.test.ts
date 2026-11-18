import { beforeEach, describe, expect, it } from 'vitest';
import {
  lastProject,
  lastProjectSession,
  rememberLastProject,
  rememberProjectSession,
} from '@renderer/lib/last-project-session';

describe('last-project-session', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers a session per project', () => {
    rememberProjectSession('p1', 's1');
    rememberProjectSession('p2', 's2');
    expect(lastProjectSession('p1')).toBe('s1');
    expect(lastProjectSession('p2')).toBe('s2');
    expect(lastProjectSession('p3')).toBeNull();
  });

  it('overwrites the project entry rather than accumulating', () => {
    rememberProjectSession('p1', 's1');
    rememberProjectSession('p1', 's2');
    expect(lastProjectSession('p1')).toBe('s2');
  });

  it('remembers the last project on its own key', () => {
    expect(lastProject()).toBeNull();
    rememberLastProject('p1');
    expect(lastProject()).toBe('p1');
    rememberLastProject('p2');
    expect(lastProject()).toBe('p2');
  });

  it('reads a corrupt session map as empty instead of throwing', () => {
    // App startup reads this - a half-written entry must not break the redirect.
    localStorage.setItem('double0-last-project-session', '{not json');
    expect(lastProjectSession('p1')).toBeNull();
    rememberProjectSession('p1', 's1');
    expect(lastProjectSession('p1')).toBe('s1');
  });

  it('ignores non-string entries in the session map', () => {
    localStorage.setItem('double0-last-project-session', JSON.stringify({ p1: 42, p2: 's2' }));
    expect(lastProjectSession('p1')).toBeNull();
    expect(lastProjectSession('p2')).toBe('s2');
  });
});
