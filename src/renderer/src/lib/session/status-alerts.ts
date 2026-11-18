import type { AgentSession } from '@renderer/lib/collections';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * Where a session's status change leaves this window: the extension's alerts
 * (`RendererExtension.alerts`), read at call time - the registry is installed
 * after every module loaded. Without one nothing is raised: the status still
 * shows on the row, the tab dot and the dock badge.
 */
export function signalStatusChange(
  sessionId: string,
  prev: AgentSession['status'],
  next: AgentSession['status'],
): void {
  rendererExtension().alerts?.statusChanged(sessionId, prev, next);
}
