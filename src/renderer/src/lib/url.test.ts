import { describe, expect, it } from 'vitest';
import {
  addressParts,
  addressToUrl,
  isLoopbackUrl,
  originOf,
  provisionalTitle,
  storableUrl,
} from '@renderer/lib/url';

describe('addressToUrl', () => {
  it('reads dev-server shorthand as http on this machine', () => {
    expect(addressToUrl('localhost:5173/checkout')).toBe('http://localhost:5173/checkout');
    expect(addressToUrl(':3000')).toBe('http://localhost:3000');
    expect(addressToUrl('5173')).toBe('http://localhost:5173');
    expect(addressToUrl('127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(addressToUrl('app.localhost:5173')).toBe('http://app.localhost:5173');
  });

  it('gives a bare domain https and keeps full URLs', () => {
    expect(addressToUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(addressToUrl('http://localhost:5173/a?b=1')).toBe('http://localhost:5173/a?b=1');
    expect(addressToUrl('  https://example.com ')).toBe('https://example.com/');
  });

  it('refuses what cannot be a page - there is no search', () => {
    expect(addressToUrl('')).toBeNull();
    expect(addressToUrl('how to center a div')).toBeNull();
    expect(addressToUrl('javascript:alert(1)')).toBeNull();
    expect(addressToUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('addressParts', () => {
  it('splits the bright origin from the dim path', () => {
    expect(addressParts('http://localhost:5173/checkout?x=1')).toEqual({
      origin: 'localhost:5173',
      path: '/checkout?x=1',
    });
    expect(addressParts('http://localhost:5173/')).toEqual({ origin: 'localhost:5173', path: '' });
    expect(addressParts('d0-preview://abc/docs/My%20page.html')).toEqual({
      origin: '',
      path: 'docs/My page.html',
    });
    expect(addressParts('')).toEqual({ origin: '', path: '' });
  });
});

describe('url helpers', () => {
  it('tells loopback from the internet', () => {
    expect(isLoopbackUrl('http://localhost:5173/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true);
    expect(isLoopbackUrl('https://localhost.example.com')).toBe(false);
    expect(isLoopbackUrl('d0-preview://x/a.html')).toBe(false);
  });

  it('names a tab before its page does', () => {
    expect(provisionalTitle('')).toBe('New tab');
    expect(provisionalTitle('http://localhost:5173/checkout')).toBe('localhost:5173');
    expect(provisionalTitle('d0-preview://abc/docs/index.html')).toBe('index.html');
    expect(originOf('http://localhost:5173/a')).toBe('http://localhost:5173');
  });
});

describe('storableUrl', () => {
  it('drops credential-looking params and the fragment, keeps the rest', () => {
    // An OAuth redirect must not land in the recent list or a saved tab.
    expect(storableUrl('http://localhost:5173/cb?code=abc&state=x&tab=2#access_token=t')).toBe(
      'http://localhost:5173/cb?tab=2',
    );
    expect(storableUrl('http://localhost:5173/orders?page=3')).toBe(
      'http://localhost:5173/orders?page=3',
    );
  });
});
