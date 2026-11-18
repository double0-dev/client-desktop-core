import { afterEach, describe, expect, it } from 'vitest';
import { isAppLocked, setAppLocked } from './app-lock';

afterEach(() => setAppLocked(false));

describe('app lock', () => {
  it('marks and clears the document', () => {
    expect(isAppLocked()).toBe(false);
    setAppLocked(true);
    expect(document.documentElement.hasAttribute('data-app-locked')).toBe(true);
    expect(isAppLocked()).toBe(true);
    setAppLocked(false);
    expect(isAppLocked()).toBe(false);
  });
});
