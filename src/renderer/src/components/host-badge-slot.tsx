import { rendererExtension } from '@renderer/lib/extension/registry';

/** Where a session or project runs - the remote hosts' badge (Pro, a private plan
 * › M7); nothing in the core build, where everything runs on this computer. */
export function HostBadgeSlot(props: { hostId: string | null | undefined; className?: string }) {
  const HostBadge = rendererExtension().hosts?.HostBadge;
  return HostBadge ? <HostBadge {...props} /> : null;
}
