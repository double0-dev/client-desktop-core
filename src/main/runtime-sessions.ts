import type { WebContents } from 'electron';
import type { RemoteHosts } from './remote-hosts';
import type { TerminalBackend } from './terminal-backend';
import type { Gated } from './extension';

/**
 * An extension's runtime sessions (agents that run outside a terminal) as the
 * rest of main sees them. `index.ts` starts them through
 * `MainExtension.runtimeSessions` once the terminal IPC is up; what core asks
 * of them is what its quit, Stop all and startup sweep need. Without an
 * extension no such agent runs: nothing is busy, nothing to stop.
 */
export type RuntimeSessionsStarted = {
  /** What the quit dialog calls them ("2 <noun> agents are still working"). */
  noun: string;
  /** Agents mid-turn / waiting on the user (a stopping quit ends them too). */
  busy(): { working: number; waiting: number };
  /** The agents run in this process (no session daemon): any quit ends them. */
  inProcess(): boolean;
  /** Stop every such agent on a machine (null = this one) - Settings › Stop all. */
  stopAllOn(hostId: string | null): Promise<void>;
  /** After the startup stale-session sweep, which knows only terminals. */
  afterSessionSweep(): Promise<void>;
  /** The host a runtime session runs on (null = this machine), its row read again. */
  sessionHost(sessionId: string): Promise<string | null>;
  /** At quit, beside the terminals' own disposal. */
  dispose(): void;
};

/** What `index.ts` hands the runtime sessions when it starts them. */
export type RuntimeSessionsContext = Gated & {
  /** The backend every terminal goes through (its daemon hosts the agents). */
  terminalBackend: TerminalBackend;
  hosts: RemoteHosts;
  mainWebContents: () => WebContents | null;
  isMainWindow: (wcId: number) => boolean;
};

/** The core build's runtime sessions: none. */
export const NO_RUNTIME_SESSIONS: RuntimeSessionsStarted = {
  noun: 'runtime',
  busy: () => ({ working: 0, waiting: 0 }),
  inProcess: () => false,
  stopAllOn: () => Promise.resolve(),
  afterSessionSweep: () => Promise.resolve(),
  sessionHost: () => Promise.resolve(null),
  dispose: () => undefined,
};
