import type { AgentStatus } from '../terminal-modes';

/**
 * What an extension's view over a terminal's agent CLI asks of the terminal
 * it follows - `terminal.ts` › `agentTerminal()` answers it in main, the
 * session daemon's PtyHost beside its terminals. Types only: the follower
 * also runs in the daemon, which never loads Electron.
 */
export type AgentTerminal = {
  exists(ptyId: string): boolean;
  input(ptyId: string, data: string): void;
  foregroundBusy(ptyId: string): Promise<boolean>;
  /** Null when the tab does not speak the status markers (no hooks, or Claude ended). */
  agentStatus(ptyId: string): Promise<AgentStatus | null>;
  /** Whether window `wcId` drives the tab (may type into it) - the IPC's check. */
  mayDrive(ptyId: string, wcId: number): boolean;
  /** The tab's screen lines (screen-mirror.ts); null when not mirrored. */
  screen(ptyId: string): string[] | null;
  /** Resolves once the output fed so far is on that screen. */
  screenSettled(ptyId: string): Promise<void>;
  /** A view starts following the tab (the host seeds the tab's screen copy). */
  follow?(ptyId: string): void;
};
