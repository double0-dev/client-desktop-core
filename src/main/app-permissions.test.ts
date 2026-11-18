import { describe, expect, it } from 'vitest';
import { appPermissionGranted } from './app-permissions';

describe('appPermissionGranted', () => {
  it('lets the app write text to the clipboard', () => {
    // Denied, every Copy item in the app silently copied nothing.
    expect(appPermissionGranted('clipboard-sanitized-write')).toBe(true);
  });

  it('denies everything else', () => {
    for (const p of ['clipboard-read', 'media', 'geolocation', 'notifications', 'openExternal']) {
      expect(appPermissionGranted(p)).toBe(false);
    }
  });
});
