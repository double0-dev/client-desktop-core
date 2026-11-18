/**
 * The remote hosts' vocabulary (a private plan) - the
 * shapes core shares with the hosts (Pro since a private plan
 * › M7): the renderer's host status feed reads them in the core build too,
 * where no host ever reports.
 */

/**
 * A host as the renderer's hosts store keeps it (`double0-hosts`,
 * MACHINE_LOCAL - a private plan › 1.1) and mirrors to
 * main with `hosts:sync`. Main never trusts a renderer's host (the target
 * reaches an `ssh` argv): `hosts/host-config.ts` › `parseHostConfig` guards it.
 *
 * What main learns about a host (platform, Node, the runtime build, the last
 * connect) is machine state, not a setting: `<userData>/hosts/<id>.json`,
 * pushed back with `hosts:changed` (HostStatus).
 */
export type HostConfig = {
  id: string;
  label: string;
  target: string;
  port: number | null;
  forwardAgent: boolean;
  useInstalledNode: boolean;
  addedAt: number;
};

/** A host's connection state as Settings › Hosts and the badges show it (spec 9.4). */
export type HostState =
  'idle' | 'connecting' | 'installing' | 'connected' | 'unreachable' | 'needs-login' | 'error';

/** What main learned about a host, kept in `<userData>/hosts/<id>.json`. */
export type HostFacts = {
  platform: string | null;
  libc: 'glibc' | 'musl' | null;
  home: string | null;
  node: string | null;
  nodeSource: 'managed' | 'installed' | null;
  build: string | null;
  /** Why the installed Node was not used, when the switch is on. */
  installedNodeProblem: string | null;
  lastConnectAt: number | null;
};

export type HostStatus = {
  id: string;
  state: HostState;
  /** One line for the state pill's tooltip / the Settings row ("the server's node is too old"). */
  message: string | null;
  /** The last ssh stderr (Settings › Hosts › Details). */
  details: string | null;
  facts: HostFacts | null;
  /** When the host became unreachable (the banner's "since"). */
  since: number | null;
  /**
   * Forward SSH agent (spec 10.2) as last seen: `live` on this connection,
   * `refused` by the server (Settings › Hosts says so on the switch), `off`
   * (no local agent, not connected), null / absent with the switch off.
   */
  agentForward?: 'live' | 'off' | 'refused' | null;
  /**
   * Other apps attached to this host's daemons right now - a second laptop
   * (spec 14). Absent / 0 = none known. Stop all ends their view of the
   * sessions too; Remove runtime refuses while any is there.
   */
  peers?: number;
  /**
   * What this build's daemon there announced when it last attached (its
   * welcome's caps) - absent until it did. A Phase 2 surface whose cap is
   * missing keeps its MVP state and says "update the runtime" (plan 29).
   */
  caps?: string[];
};
