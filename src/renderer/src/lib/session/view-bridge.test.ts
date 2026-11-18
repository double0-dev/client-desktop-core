import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { SessionViewSlot } from '@renderer/lib/extension/types';
import { sessionViewBridge } from './view-bridge';

/**
 * Core's door to the runtime sessions' bridge: the extension's session-view
 * slot, absent in the core build - where a launch, a "+" tab's status and a
 * session edit simply have no agent to tell. Core never
 * reads `window.api` for it.
 */

afterEach(() => {
  resetRendererExtensionForTest();
  (window as unknown as { api?: unknown }).api = undefined;
});

describe('sessionViewBridge', () => {
  it('is absent in the core build, whatever window.api holds', () => {
    (window as unknown as { api?: unknown }).api = {
      sessionView: { open: vi.fn(), stop: vi.fn() },
    };
    expect(sessionViewBridge()).toBeUndefined();
  });

  it("is the extension's bridge when it registers one", async () => {
    const open = vi.fn(async () => ({ chunks: [] }));
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      sessionView: {
        bridge: () => ({ open, stop: vi.fn(async () => true) }),
      } as unknown as SessionViewSlot,
    });
    await sessionViewBridge()?.open('5b0c3a1e');
    expect(open).toHaveBeenCalledWith('5b0c3a1e');
  });
});
