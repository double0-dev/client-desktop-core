import type { AgentStatus } from './terminal-modes';

/**
 * Whether a quit must ask first, and what it asks (a private plan
 * › Quit). Pure: index.ts feeds it the quit's intent and the busy counts and
 * shows the prompt it returns through a native message box - the renderer
 * may be gone by then (a Dock Quit has no renderer turn), so the decision
 * lives in main.
 *
 * Two quits end the daemon's terminals: "Quit and Stop All Sessions", and a
 * plain quit while Settings › Sessions › Keep-running is off. Only those
 * ask, and only while something is busy - an agent mid-turn, one waiting on
 * the user, or a plain shell with a program in its foreground. A quit that
 * keeps the sessions never asks, whatever runs.
 */
export type QuitIntent = {
  /** "Quit and Stop All Sessions" was chosen. */
  stopRequested: boolean;
  /** Settings › Sessions › Keep sessions running after quit. */
  keepRunning: boolean;
};

/** What the app is about to do - the prompt's verbs follow it. */
export type QuitAction = 'quit' | 'restart';

/**
 * What main could tell about the live terminals: agents are the terminals
 * that speak the status-marker protocol (`agentStatus`), shells the rest with
 * a program in the foreground (`foregroundBusy`) - main cannot tell a shell
 * that is blocked on the user from one that is working, so they are one bucket.
 */
export type BusyCounts = {
  /** Marker-driven terminals whose agent is mid-turn. */
  working: number;
  /** Marker-driven terminals whose agent is blocked on the user. */
  waiting: number;
  /** Markerless terminals with a program running in the foreground. */
  shells: number;
  /**
   * Terminals on remote hosts, per host label (a private plan
   * › 16): never counted above - a quit stops no remote session - only named.
   */
  remote?: { label: string; terminals: number }[];
};

/** The line naming what keeps running on remote hosts, or ''. */
export function remoteNote(remote: BusyCounts['remote']): string {
  const hosts = (remote ?? []).filter((r) => r.terminals > 0);
  if (hosts.length === 0) return '';
  const parts = hosts.map(
    (r) => `${r.terminals} terminal${r.terminals === 1 ? '' : 's'} on ${r.label}`,
  );
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return ` ${list} keep${hosts.length === 1 && hosts[0].terminals === 1 ? 's' : ''} running there.`;
}

export const NO_BUSY: BusyCounts = { working: 0, waiting: 0, shells: 0 };

/**
 * What a button means: `proceed` quits as intended (the sessions stop),
 * `keep-once` quits but leaves the sessions running this time only (the
 * switch stays off), `cancel` leaves the app running.
 */
export type QuitDecision = 'cancel' | 'proceed' | 'keep-once';

export type QuitConfirmPrompt = {
  /** The headline (`message` of a native message box). */
  message: string;
  /** The body under it. */
  detail: string;
  /** Button labels in array order; `choices[i]` is what pressing button i means. */
  buttons: string[];
  choices: QuitDecision[];
  /** The Return button - never one that ends a session. */
  defaultId: number;
  cancelId: number;
};

/** Whether this quit ends the daemon's terminals (the only kind that may ask). */
export function quitStopsSessions(intent: QuitIntent): boolean {
  return intent.stopRequested || !intent.keepRunning;
}

export function totalBusy(busy: BusyCounts): number {
  return busy.working + busy.waiting + busy.shells;
}

/** What main knows synchronously when a quit arrives. */
export type QuitContext = {
  /** Live terminals main knows of, owned or not (the busy count is a round trip; this is not). */
  liveTerminals: number;
  /**
   * The OS is ending the session - a logout, restart or shutdown reported by
   * `powerMonitor` 'shutdown' (macOS, Linux) or a window's 'query-session-end'
   * / 'session-end' (Windows) - and the quit is its doing, not the user's.
   */
  systemEnding: boolean;
};

/**
 * Whether `before-quit` must HOLD this quit for the question at all: a
 * stopping quit with at least one live terminal, and never one the OS asked
 * for. Holding is `event.preventDefault()`, which the system takes as a
 * refusal: on macOS a held quit CANCELS the logout or shutdown in progress,
 * and a dialog nobody is there to answer blocks it elsewhere. An OS-driven
 * quit therefore proceeds with the user's setting as it stands (the switch
 * off = the sessions stop, as they would with the machine); a quit with
 * nothing to ask about passes at once rather than being held and re-issued.
 */
export function quitMayNeedConfirm(intent: QuitIntent, context: QuitContext): boolean {
  if (context.systemEnding) return false;
  return quitStopsSessions(intent) && context.liveTerminals > 0;
}

/**
 * How long a reported session end stays in force. The notice comes before
 * the quit (macOS posts it as the logout is requested; another app may still
 * cancel that logout), so a quit that never follows must not leave the flag
 * raised for a later Cmd/Ctrl+Q of the user's own.
 */
export const SYSTEM_ENDING_TTL_MS = 60_000;

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
const isAre = (n: number): string => (n === 1 ? 'is' : 'are');

/**
 * "2 agents are still working, 1 is waiting on you and 1 shell is still
 * running a command" - every non-zero bucket, in that order, no trailing
 * period (design: `Label/Quit confirm` in design/client_desktop.pen).
 */
export function busySummary(busy: BusyCounts): string {
  const parts: string[] = [];
  if (busy.working > 0) {
    parts.push(
      `${busy.working} ${plural(busy.working, 'agent')} ${isAre(busy.working)} still working`,
    );
  }
  if (busy.waiting > 0) {
    const noun = busy.working > 0 ? '' : `${plural(busy.waiting, 'agent')} `;
    parts.push(`${busy.waiting} ${noun}${isAre(busy.waiting)} waiting on you`);
  }
  if (busy.shells > 0) {
    parts.push(
      `${busy.shells} ${plural(busy.shells, 'shell')} ${isAre(busy.shells)} still running a command`,
    );
  }
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The prompt for this quit, or null when it may just go ahead: the quit
 * keeps the sessions, or nothing is busy.
 */
export function planQuitConfirm(
  intent: QuitIntent & { action?: QuitAction },
  busy: BusyCounts,
): QuitConfirmPrompt | null {
  if (!quitStopsSessions(intent)) return null;
  const total = totalBusy(busy);
  if (total <= 0) return null;
  const action = intent.action ?? 'quit';
  const verb = action === 'restart' ? 'restart' : 'quit';
  const verbing = action === 'restart' ? 'restarting' : 'quitting';
  const Verbing = action === 'restart' ? 'Restarting' : 'Quitting';
  const summary = busySummary(busy);
  const away = remoteNote(busy.remote);

  if (intent.stopRequested) {
    // The menu item: the user asked to stop everything - confirm, no third
    // way. The design makes the stop the Return default; it is Cancel here on
    // purpose, so Return never ends a working agent.
    return {
      message: `Stop all sessions and ${verb}?`,
      detail: `${summary}. ${Verbing} this way ends every shell and agent on this machine; each session resumes its conversation the next time its tab starts.${away}`,
      buttons: [`Stop sessions and ${verb}`, 'Cancel'],
      choices: ['proceed', 'cancel'],
      defaultId: 1,
      cancelId: 1,
    };
  }
  // The Keep-running switch is off: a plain quit ends them, unless the user
  // keeps them for this quit alone - the safe way out, so it is the default.
  return {
    message: `${action === 'restart' ? 'Restart' : 'Quit'} while sessions are busy?`,
    detail: `${summary}. Keep sessions running after quit is off, so ${verbing} ends them - or keep them running this once and every tab picks its terminal up again on the next launch.${away}`,
    buttons: [`Keep them running and ${verb}`, `Stop sessions and ${verb}`, 'Cancel'],
    choices: ['keep-once', 'proceed', 'cancel'],
    defaultId: 0,
    cancelId: 2,
  };
}

/** The slice of the terminal backend the count needs. */
export type BusyProbe = {
  /** Verdicts for the marker-driven terminals among `ids` (an idle agent is a verdict too). */
  agentStatus(ids: string[]): Promise<{ id: string; status: AgentStatus }[]>;
  /** A program other than the shell runs in the terminal's foreground. */
  foregroundBusy(id: string): Promise<boolean>;
};

/**
 * Count what is busy among `ids`, as close to the renderer's busy registry
 * (lib/terminal/busy.ts) as main can get: a marker-driven terminal is what
 * its agent's last marker says - `running` works, `needs-input` waits, `idle`
 * is not busy even though the agent process sits in the foreground - and a
 * markerless one is busy while a program other than the shell runs in it.
 * A backend that does not answer in `timeoutMs` (a wedged daemon) counts as
 * nothing busy: the quit must never hang on the question.
 */
export async function countBusyTerminals(
  ids: string[],
  probe: BusyProbe,
  opts: { timeoutMs?: number } = {},
): Promise<BusyCounts> {
  if (ids.length === 0) return NO_BUSY;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const count = async (): Promise<BusyCounts> => {
    const verdicts = await probe.agentStatus(ids);
    const decided = new Set<string>();
    let working = 0;
    let waiting = 0;
    for (const v of verdicts) {
      decided.add(v.id);
      if (v.status === 'running') working++;
      else if (v.status === 'needs-input') waiting++;
    }
    const rest = ids.filter((id) => !decided.has(id));
    const busy = await Promise.all(rest.map((id) => probe.foregroundBusy(id).catch(() => false)));
    return { working, waiting, shells: busy.filter(Boolean).length };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<BusyCounts>((resolve) => {
    timer = setTimeout(() => resolve(NO_BUSY), timeoutMs);
  });
  try {
    return await Promise.race([count().catch(() => NO_BUSY), capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * No session daemon (the in-process fallback): an extension's runtime agents
 * run inside the app, so ANY quit ends them - the Keep-running switch cannot
 * keep them. Asked only when one is mid-turn or waiting on the user. `noun`
 * is what the extension calls them (`RuntimeSessionsStarted.noun`).
 */
export function planRuntimeQuitConfirm(
  busy: { working: number; waiting: number },
  noun: string,
  action: QuitAction = 'quit',
): QuitConfirmPrompt | null {
  const total = busy.working + busy.waiting;
  if (total <= 0) return null;
  const verb = action === 'restart' ? 'restart' : 'quit';
  const parts: string[] = [];
  if (busy.working > 0) {
    parts.push(
      `${busy.working} ${noun} ${plural(busy.working, 'agent')} ${isAre(busy.working)} still working`,
    );
  }
  if (busy.waiting > 0) {
    parts.push(`${busy.waiting} ${isAre(busy.waiting)} waiting on you`);
  }
  return {
    message: `${action === 'restart' ? 'Restart' : 'Quit'} while ${noun}s are busy?`,
    detail: `${parts.join(' and ')}. The session daemon is not running, so ${noun} agents stop when double0 does - each ${noun} picks its conversation up again the next time you open it.`,
    buttons: [`Stop them and ${verb}`, 'Cancel'],
    choices: ['proceed', 'cancel'],
    defaultId: 1,
    cancelId: 1,
  };
}
