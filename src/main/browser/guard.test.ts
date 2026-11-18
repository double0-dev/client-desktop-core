import { describe, expect, it } from 'vitest';
import {
  BROWSER_PARTITION,
  isAllowedPermission,
  isAppShortcut,
  isBrowsableUrl,
  rateLimit,
  vetWebviewAttach,
  type GuestKey,
  type GuestPreferences,
} from './guard';

describe('rateLimit', () => {
  it('allows max per window, then again once the oldest ages out', () => {
    let t = 0;
    const limit = rateLimit(3, 1000, () => t);
    expect([limit.allow(), limit.allow(), limit.allow(), limit.allow()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    t = 999;
    expect(limit.allow()).toBe(false);
    t = 1000;
    expect([limit.allow(), limit.allow(), limit.allow(), limit.allow()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('isBrowsableUrl', () => {
  it('allows web pages, the preview scheme and a blank page', () => {
    expect(isBrowsableUrl('http://localhost:5173/')).toBe(true);
    expect(isBrowsableUrl('https://example.com')).toBe(true);
    expect(isBrowsableUrl('d0-preview://tok/index.html')).toBe(true);
    expect(isBrowsableUrl('about:blank')).toBe(true);
  });

  it('refuses files, scripts and other OS handlers', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome://settings',
      'app://renderer/',
      'vscode://file/x',
      'not a url',
    ])
      expect(isBrowsableUrl(url)).toBe(false);
  });
});

describe('vetWebviewAttach', () => {
  it('locks a guest down and strips any preload', () => {
    const prefs: GuestPreferences = {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: '/tmp/evil.js',
      preloadURL: 'file:///tmp/evil.js',
    };
    const params: Record<string, string> = {
      partition: BROWSER_PARTITION,
      src: 'http://localhost:5173',
      preload: 'file:///tmp/evil.js',
    };
    expect(vetWebviewAttach(prefs, params)).toBeNull();
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(prefs.preload).toBeUndefined();
    expect(prefs.preloadURL).toBeUndefined();
    expect(params.preload).toBeUndefined();
  });

  it('turns off nested webviews and Blink feature switches', () => {
    const prefs: GuestPreferences = {
      webviewTag: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'Serial',
      disableBlinkFeatures: 'X',
    };
    const params: Record<string, string> = {
      partition: BROWSER_PARTITION,
      src: '',
      blinkfeatures: 'Serial',
    };
    expect(vetWebviewAttach(prefs, params)).toBeNull();
    expect(prefs).toEqual(
      expect.objectContaining({ webviewTag: false, experimentalFeatures: false }),
    );
    expect(prefs.enableBlinkFeatures).toBeUndefined();
    expect(prefs.disableBlinkFeatures).toBeUndefined();
    expect(params.blinkfeatures).toBeUndefined();
  });

  it('refuses another partition - the app session must never host a page', () => {
    expect(vetWebviewAttach({}, { partition: '', src: 'http://localhost' })).toBe(
      'unknown partition',
    );
    expect(vetWebviewAttach({}, { partition: 'persist:other', src: '' })).toBe('unknown partition');
  });

  it('refuses a src the tab may not load', () => {
    expect(vetWebviewAttach({}, { partition: BROWSER_PARTITION, src: 'file:///etc' })).toBe(
      'src not allowed',
    );
  });

  it('accepts a guest attached before its first navigation', () => {
    expect(vetWebviewAttach({}, { partition: BROWSER_PARTITION, src: '' })).toBeNull();
  });
});

describe('isAllowedPermission', () => {
  it('grants clipboard writes and fullscreen, refuses devices', () => {
    expect(isAllowedPermission('clipboard-sanitized-write')).toBe(true);
    expect(isAllowedPermission('fullscreen')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'clipboard-read'])
      expect(isAllowedPermission(p)).toBe(false);
  });
});

describe('isAppShortcut', () => {
  const key = (code: string, mods: Partial<GuestKey> = {}): GuestKey => ({
    type: 'keyDown',
    code,
    key: code,
    meta: true,
    control: false,
    shift: false,
    alt: false,
    ...mods,
  });

  it('hands app combos back to the window', () => {
    expect(isAppShortcut(key('KeyW'), true)).toBe(true);
    expect(isAppShortcut(key('KeyT'), true)).toBe(true);
    expect(isAppShortcut(key('Digit1'), true)).toBe(true);
    expect(isAppShortcut(key('KeyB', { shift: true }), true)).toBe(true);
    // ⌘⇧C is Select element, not copy.
    expect(isAppShortcut(key('KeyC', { shift: true }), true)).toBe(true);
  });

  it('keeps text editing in the page', () => {
    for (const code of ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'ArrowLeft'])
      expect(isAppShortcut(key(code), true)).toBe(false);
    expect(isAppShortcut(key('KeyZ', { shift: true }), true)).toBe(false);
    expect(isAppShortcut(key('Home', { shift: true }), true)).toBe(false);
  });

  // ⇧⌘Arrow is the app's focus walk (pane, tab, sidebar): kept in the page, a
  // focused browser tab was a dead end - no switching to the next tab.
  it('hands the focus-walk arrows back from a focused page', () => {
    for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(isAppShortcut(key(code, { shift: true }), true)).toBe(true);
      expect(isAppShortcut(key(code, { meta: false, control: true, shift: true }), false)).toBe(
        true,
      );
    }
  });

  it('leaves AltGr characters and editing keys to the page', () => {
    // Off macOS AltGr is Ctrl+Alt: German/Polish @ { [ must type (review, 2026-10-06).
    expect(isAppShortcut(key('KeyQ', { meta: false, control: true, alt: true }), false)).toBe(
      false,
    );
    for (const code of ['Backspace', 'Delete', 'Enter', 'Home', 'End'])
      expect(isAppShortcut(key(code), true)).toBe(false);
    // On macOS ⌥⌘ is still the app's (⌥⌘I DevTools).
    expect(isAppShortcut(key('KeyI', { alt: true }), true)).toBe(true);
  });

  it('leaves the app menu its accelerators on macOS', () => {
    for (const k of [
      key('KeyQ'),
      key('KeyH'),
      key('KeyH', { alt: true }),
      key('KeyM'),
      key('KeyW', { shift: true }),
      key('Equal'),
      key('Minus'),
      key('Digit0'),
      key('KeyF', { control: true }),
    ])
      expect(isAppShortcut(k, true)).toBe(false);
    // ⌘W is the app's close tab.
    expect(isAppShortcut(key('KeyW'), true)).toBe(true);
  });

  it('ignores plain keys, key-ups and the other platform modifier', () => {
    expect(isAppShortcut(key('KeyW', { meta: false }), true)).toBe(false);
    expect(isAppShortcut(key('KeyW', { type: 'keyUp' }), true)).toBe(false);
    expect(isAppShortcut(key('KeyW', { meta: false, control: true }), true)).toBe(false);
    expect(isAppShortcut(key('KeyW', { meta: false, control: true }), false)).toBe(true);
  });
});
