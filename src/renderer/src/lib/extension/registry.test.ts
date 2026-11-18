import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  rendererExtension,
  resetRendererExtensionForTest,
} from './registry';

describe('the renderer extension registry', () => {
  afterEach(() => resetRendererExtensionForTest());

  it('reads as the core build until main.tsx installs an extension', () => {
    // Tests and a window that never installs one see no Pro surface at all.
    expect(rendererExtension().edition).toBe('core');
  });

  it('starts the installed extension once, at install', () => {
    // Pro starts what a module load is too early for (mirroring a setting
    // into main) - exactly once per window.
    const start = vi.fn();
    installRendererExtension({ edition: 'pro', railTools: [], start });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('returns the installed extension to every later reader', () => {
    // main.tsx installs before boot(): the router layout and a torn-off
    // window (no router) must read the same object.
    const official = { edition: 'pro' as const, railTools: [] };
    installRendererExtension(official);
    expect(rendererExtension()).toBe(official);
    expect(rendererExtension()).toBe(official);
  });
});
