/**
 * What a remote session (a project on a host, a private plan
 * › "Local-only or disabled for remote sessions") cannot do yet, one
 * predicate per surface so each call site reads as the rule it applies. Pure:
 * every predicate takes the host id of the path / project in question (null =
 * this machine), as `lib/hosts/host-of-path.ts` resolves it.
 *
 * Local behaviour never changes: every predicate is true for a null host.
 * Plan 29 › M5-M8 removed the predicates of surfaces that now work on a host
 * (DETECTED, task images, the runtime agents, file previews, the local-file
 * drop - it never had a caller, the explorer's drop target serves every
 * root). M9 made the language server per host capability.
 */
type HostId = string | null | undefined;

const local = (hostId: HostId): boolean => !hostId;

/** Show in folder / Reveal in file manager - nothing on this machine to show. */
export const canShowInFolder = local;

/** Open in an installed IDE (its remote mode is Phase 3). */
export const canOpenInIde = local;

/**
 * A language server for an editor (plan 29 › M9): always for this machine;
 * for a host, only while its daemon announces `lsp` (`caps` - what the
 * attached daemon said, HostStatus.caps). An older runtime keeps the MVP
 * state - highlighting, no server, no banner - until the next connect
 * pushes a new one.
 */
export function canUseLanguageServer(hostId: HostId, caps?: readonly string[] | null): boolean {
  return local(hostId) || !!caps?.includes('lsp');
}
