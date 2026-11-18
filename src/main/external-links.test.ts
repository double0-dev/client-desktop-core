import { describe, expect, it } from 'vitest';
import { externalOpenUrl } from './external-links';

/**
 * The app window's link rule (main's setWindowOpenHandler): only web pages
 * and mail to an address reach the operating system - a `file://` or custom
 * scheme handed to openExternal could launch anything installed.
 */
describe('externalOpenUrl', () => {
  it('opens web pages', () => {
    expect(externalOpenUrl('https://double0.dev/terms')).toBe('https://double0.dev/terms');
    expect(externalOpenUrl('http://localhost:3001/subscription')).toBe(
      'http://localhost:3001/subscription',
    );
  });

  it('opens mail to an address - the support line', () => {
    expect(externalOpenUrl('mailto:hello@double0.dev')).toBe('mailto:hello@double0.dev');
    // The address alone - a page's cc, bcc, body or attachment never rides along.
    expect(
      externalOpenUrl(
        'mailto:hello@double0.dev?subject=x&cc=jamesc@example.com&attach=/etc/passwd',
      ),
    ).toBe('mailto:hello@double0.dev');
  });

  it('refuses an address that smuggles a query in encoded', () => {
    expect(externalOpenUrl('mailto:a@b.com%3Fbody=hi%26attach=/etc/passwd')).toBeNull();
    expect(externalOpenUrl('mailto:a%23x@b.com')).toBeNull();
  });

  it('refuses a mail link with no address, or one it cannot decode, without throwing', () => {
    expect(externalOpenUrl('mailto:%E0%A4%A@double0.dev')).toBeNull();
    expect(externalOpenUrl('mailto:')).toBeNull();
    expect(externalOpenUrl('mailto:?subject=x')).toBeNull();
  });

  it('refuses files, custom schemes and anything malformed', () => {
    for (const url of [
      'file:///etc/passwd',
      'com.double0.desktop://auth/callback',
      'javascript:alert(1)',
      'smb://host/share',
      'not a url',
      '',
    ]) {
      expect(externalOpenUrl(url), url).toBeNull();
    }
  });
});
