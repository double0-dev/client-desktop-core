import { rendererExtension } from '@renderer/lib/extension/registry';

/** Whether this build has remote hosts (Pro, a private plan
 * › M7) - the core build's sessions all run on this computer. */
export function hostsEnabled(): boolean {
  return rendererExtension().hosts !== undefined;
}
