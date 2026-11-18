import type { SignInAgentId } from './agent-table';
import type { HostSpawnRequest } from './pty-host';

/**
 * What `terminal.ts` asks of the remote hosts (a private plan,
 * a private plan) - the official build's since
 * a private plan › M7. With nothing registered no
 * terminal is remote: a host terminal is refused and no id is a host
 * sign-in, while every local spawn runs exactly as before.
 */

/** A plain shell on a host (a sign-in terminal, no launch plan). */
export type RemoteShellInput = {
  id: string;
  cwd: string | null | undefined;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  appVersion: string;
};

/** A session terminal on a host: the plan the host's daemon materialises. */
export type RemoteLaunchInput = RemoteShellInput & {
  shellIntegration?: boolean;
  /** The host's OS (`linux` / `darwin`) - the adapter is chosen for it. */
  platform: NodeJS.Platform;
  /** The host's daemon offers the extension's agent tools. */
  agentTools?: boolean;
};

export type RemoteSpawnPlanner = {
  shellRequest(input: RemoteShellInput): HostSpawnRequest;
  launchRequest(input: RemoteLaunchInput): HostSpawnRequest;
};

export type SignInAction = 'login' | 'install';

/** The host agent sign-in terminals (`host-signin:<hostId>:<kind>:<nonce>`). */
export type SignInFlow = {
  parse(id: string): { hostId: string; kind: string } | null;
  /** The command a sign-in terminal starts with (the table's, never the caller's). */
  startCommand(kind: string): string | null;
  /** The agent a terminal of `kind` signs in, when it starts with a login. */
  startAction(kind: string): { agent: SignInAgentId; action: SignInAction } | null;
  /** A printed page this agent's sign-in may open, vetted against its origins. */
  vetUrl(agent: SignInAgentId, url: string): { url: string; callbackPort: number | null } | null;
  /** The table's line for a dialog button. */
  agentCommand(agent: SignInAgentId, action: SignInAction): string | null;
};

let planner: RemoteSpawnPlanner | null = null;
let signIn: SignInFlow | null = null;

/** Register the remote spawn planner; returns the undo. */
export function setRemoteSpawnPlanner(next: RemoteSpawnPlanner): () => void {
  planner = next;
  return () => {
    if (planner === next) planner = null;
  };
}

export function remoteSpawnPlanner(): RemoteSpawnPlanner | null {
  return planner;
}

/** Register the host sign-in flow; returns the undo. */
export function setSignInFlow(next: SignInFlow): () => void {
  signIn = next;
  return () => {
    if (signIn === next) signIn = null;
  };
}

/** The sign-in a terminal id names, if any (none without the flow). */
export function parseSignIn(id: string): { hostId: string; kind: string } | null {
  return signIn?.parse(id) ?? null;
}

export function signInFlow(): SignInFlow | null {
  return signIn;
}
