import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { signalStatusChange } from '@renderer/lib/session/status-alerts';

afterEach(() => resetRendererExtensionForTest());

describe('signalStatusChange', () => {
  it('hands the change to the installed extension', () => {
    const statusChanged = vi.fn();
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      alerts: { statusChanged, attach: () => () => {} },
    });
    signalStatusChange('s1', 'active', 'needs-input');
    expect(statusChanged).toHaveBeenCalledWith('s1', 'active', 'needs-input');
  });

  // The core build has no alerts: a status change must still be a no-op, not
  // a throw inside the status observer (which would stop the dots updating).
  it('does nothing without one', () => {
    expect(() => signalStatusChange('s1', 'active', 'finished')).not.toThrow();
  });
});
