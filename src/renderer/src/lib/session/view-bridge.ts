import type { SessionViewBridge } from '@renderer/lib/extension/types';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * The runtime sessions' bridge, from the extension's session-view slot. Absent
 * in the core build: no runtime agent runs, so there is nothing to open,
 * report to or stop. Only the calls core's session plumbing makes; the
 * extension's own view uses its full bridge.
 */
export function sessionViewBridge(): SessionViewBridge | undefined {
  return rendererExtension().sessionView?.bridge();
}
