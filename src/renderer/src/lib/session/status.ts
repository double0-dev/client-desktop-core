import { agentSessionsCollection } from '@renderer/lib/collections';
import {
  beginSessionTurn,
  clearSessionActivity,
  decodeToolPayload,
  finishSessionTurn,
  noteSessionWaiting,
  noteToolDone,
  noteToolStart,
} from '@renderer/lib/session/activity';
import { isSessionWatched } from '@renderer/lib/session/attention';
import { signalStatusChange } from '@renderer/lib/session/status-alerts';
import { clearSessionQuestion, publishSessionQuestion } from '@renderer/lib/session/questions';
import { unarchiveSession } from '@renderer/lib/session/unarchive';
import {
  isTerminalActivitySuppressed,
  subscribeTerminalCommitKey,
  subscribeTerminalInterruptKey,
  suppressTerminalActivity,
} from '@renderer/lib/terminal/activity-gate';
import {
  clearTerminalBusy,
  getTerminalBusy,
  isTerminalKnown,
  noteTerminalBell,
  noteTerminalCommitKey,
  noteTerminalFinished,
  noteTerminalInterrupted,
  noteTerminalOutput,
  noteTerminalReady,
  seedTerminalBusy,
  setTerminalBusy,
} from '@renderer/lib/terminal/busy';
import { sessionViewBridge } from '@renderer/lib/session/view-bridge';
import { runsInView } from '@renderer/lib/session/templates';

/**
 * FALLBACK ONLY - how long a session's terminals must all be quiet before a
 * running agent is declared finished ('idle'), for terminals whose program does
 * NOT speak the marker protocol (a plain shell, an agent CLI with no adapter).
 * A marker-driven terminal (Claude) never uses this: its status is purely
 * event-driven - markers, keystrokes, exits - with no interval heuristics.
 */
const STATUS_IDLE_MS = 8_000;

/**
 * Fallback-mode variant of the quiet window once an attention bell has told us
 * the verdict: settle to needs-input promptly instead of waiting out the full
 * idle window.
 */
const SETTLE_MS = 1_000;

// Control chars for the signal scan. ESC opens an OSC span; BEL (ASCII 7) both
// terminates an OSC AND is the standalone "attention" bell an agent may ring.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// Private OSC code our injected agent hooks write (ESC ] 6790 ; <verb> [; <payload>]
// BEL) to report lifecycle events. Must match src/main/terminal.ts. xterm.js drops
// this unknown OSC without rendering, so it's invisible on screen.
const STATUS_OSC = '6790';

/**
 * Cap on an unterminated OSC span carried across chunks. Must exceed the marker
 * payload cap in the main-process hook script (6000 chars of base64 for a
 * 'question' payload) plus the marker header, so a split question survives; a
 * longer foreign OSC is truncated harmlessly (it can't be ours).
 */
const CARRY_MAX = 8_192;

/** Lifecycle verbs the injected hooks emit (see CLAUDE_STATUS_SETTINGS in main). */
const MARKER_VERBS = [
  'ready',
  'needs-input',
  'running',
  'finished',
  'question',
  'question-done',
  'tool-start',
  'tool-done',
  'ended',
] as const;
export type MarkerVerb = (typeof MARKER_VERBS)[number];
export type StatusMarker = { verb: MarkerVerb; payload?: string };

function isMarkerVerb(verb: string): verb is MarkerVerb {
  return (MARKER_VERBS as readonly string[]).includes(verb);
}

export type LiveStatus = 'active' | 'needs-input' | 'idle';

/**
 * Where a stop lands. An agent that stops while the user is looking at the
 * session is simply 'idle'; one that stops while they're away is 'finished' -
 * the unseen mark that holds until they open the session (session/attention
 * clears it). Only a running or waiting session can newly stop: an idle,
 * finished, archived or legacy-done one keeps what it has (null = nothing to
 * settle), so a later 'idle' verdict - the agent exiting after its turn, a
 * quiet window - can never wipe an unseen mark. Pure, for tests.
 */
export function stopTarget(current: string, watched: boolean): 'idle' | 'finished' | null {
  if (current !== 'active' && current !== 'needs-input') return null;
  return watched ? 'idle' : 'finished';
}

/**
 * Fallback-mode settle verdict: what the quiet window resolves to. Non-null once
 * a bell has flagged "blocked on you"; null (no signal since output last flowed)
 * settles to 'idle'.
 */
export type SettleTo = 'needs-input' | 'idle' | null;

/**
 * The status a fallback-mode session settles to once its terminals go quiet.
 * Pure, for tests.
 *
 * Deliberately does NOT peek at whether an agent process is alive: a TUI sits in
 * the foreground at its input box whenever it isn't streaming, so "a process is
 * alive + quiet" is true almost always and misreads every parked session as
 * needs-input. The verdict is signal-gated instead.
 */
export function settleStatus(settleTo: SettleTo): 'needs-input' | 'idle' {
  return settleTo ?? 'idle';
}

/**
 * Terminals whose program has proven it speaks the marker protocol (a 6790
 * marker arrived since spawn / since the last 'ended'). Module-level so the
 * knowledge survives observer re-subscribes (tab changes, cross-window moves):
 * a parked needs-input Claude emits nothing on remount, and it must NOT fall
 * back to quiet-timer rules. Entries drop on 'ended' (agent exited back to the
 * shell - SessionEnd hook) and on pty exit.
 */
const markerPtys = new Set<string>();

/** Whether an agent that reports through markers runs in terminal `ptyId` right now. */
export function isAgentPty(ptyId: string): boolean {
  return markerPtys.has(ptyId);
}

/**
 * Write one verdict to the session's row. Leaving needs-input in ANY way
 * (answered, resumed, finished, exited, its tab closed) makes the pending
 * question stale - a cheap no-op when none is stored. The row is read fresh
 * every time (an in-memory lookup) so a status another writer set - a manual
 * archive/unarchive - is always respected: NOTHING a terminal does moves an
 * archived session (only the user does - see observeSessionStatus); a stop
 * never touches an unseen 'finished' mark either (stopTarget). `quiet` routes a stop to plain idle and fires no
 * alert - for corrections, not events.
 */
function applyStatus(sessionId: string, next: LiveStatus, opts: { quiet?: boolean } = {}): void {
  if (next !== 'needs-input') clearSessionQuestion(sessionId);
  const current = agentSessionsCollection.get(sessionId);
  if (!current || current.status === 'archived') return;
  // A runtime session's row is written by main, from its agent AND its
  // terminal tabs: the tabs' verdict goes there. The alerts and the unseen
  // mark come from the row (observeRuntimeSessionStatus).
  if (runsInView(current)) {
    void sessionViewBridge()?.terminalStatus?.(sessionId, next);
    return;
  }
  const target =
    next === 'idle'
      ? stopTarget(current.status, opts.quiet === true || isSessionWatched(sessionId))
      : next;
  if (target === null || current.status === target) return;
  const prev = current.status;
  agentSessionsCollection.update(sessionId, (draft) => {
    draft.status = target;
  });
  if (!opts.quiet) signalStatusChange(sessionId, prev, target);
}

/**
 * What a session's terminals add up to, from the per-tab verdicts the busy
 * registry holds (terminal/busy.ts): a tab waiting on the user beats one
 * working beats none. Null when the answer would be 'idle' only because some
 * terminal has never reported to this renderer - a window that just loaded has
 * no evidence about a parked agent, and a parked needs-input agent emits
 * nothing until answered, so "no news" must not read as quiet. Pure over the
 * registry, for tests.
 */
export function aggregateTabStatus(shellPtyIds: string[]): LiveStatus | null {
  let running = false;
  let unknown = false;
  for (const id of shellPtyIds) {
    const busy = getTerminalBusy(id);
    if (busy === 'needs-input') return 'needs-input';
    if (busy === 'running') running = true;
    else if (!isTerminalKnown(id)) unknown = true;
  }
  if (running) return 'active';
  return unknown ? null : 'idle';
}

/** Settle a session on what its terminals add up to; an unknowable verdict
 * leaves the status as it is. Idle means nothing is running - the live
 * activity line goes with it. */
function settleFromTabs(sessionId: string, shellPtyIds: string[]): void {
  const derived = aggregateTabStatus(shellPtyIds);
  if (derived === null) return;
  if (derived === 'idle') clearSessionActivity(sessionId);
  applyStatus(sessionId, derived);
}

/**
 * Terminal tabs were closed for good (their shells killed - the tab-close
 * paths in workspace-context): re-derive the session's status from the tabs
 * it still has. A closed tab takes its verdict with it - the observer that
 * would have seen its shell exit is re-subscribed WITHOUT that pty the moment
 * the layout drops the tab, so the exit is never observed, and a status the
 * closed tab set ('needs-input', 'active') would otherwise linger on the
 * session - and, rolled up, on its project row and the dock - until some
 * other tab spoke. Everything the closed ptys left behind is retired first.
 */
export function recheckSessionStatus(
  sessionId: string,
  remainingShellPtyIds: string[],
  closedPtyIds: string[],
): void {
  for (const id of closedPtyIds) {
    markerPtys.delete(id);
    clearTerminalBusy(id);
  }
  settleFromTabs(sessionId, remainingShellPtyIds);
}

/**
 * Scan `carry + data` for the out-of-band signals we care about, OSC-aware so
 * control sequences aren't mistaken for content:
 *   - status markers from our injected agent hooks:
 *     ESC ] 6790 ; <verb> [; <payload>] (BEL|ST) - unknown verbs are ignored, so
 *     old and new app/hook versions degrade gracefully past each other
 *   - a standalone attention BEL that is NOT an OSC terminator - shells emit
 *     `ESC ] <title> BEL` every prompt, and that terminator BEL must not read as
 *     a bell (it would flag every idle shell as needs-input).
 * Returns the markers in stream order, whether a real bell is present, and any
 * unterminated trailing OSC span to feed back as `carry` next chunk (a span can
 * be split across reads). Pure, for tests.
 */
export function scanSignals(
  carry: string,
  data: string,
): { markers: StatusMarker[]; bell: boolean; carry: string } {
  const s = carry + data;
  const markers: StatusMarker[] = [];
  let bell = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC && s[i + 1] === ']') {
      let j = i + 2;
      // OSC ends at BEL or ST (ESC backslash, char code 92).
      while (j < s.length && s[j] !== BEL && !(s[j] === ESC && s.charCodeAt(j + 1) === 92)) j++;
      if (j >= s.length) return { markers, bell, carry: s.slice(i, i + CARRY_MAX) };
      const body = s.slice(i + 2, j); // OSC payload, e.g. "6790;running" or "0;title"
      if (body.startsWith(`${STATUS_OSC};`)) {
        const rest = body.slice(STATUS_OSC.length + 1);
        const sep = rest.indexOf(';');
        const verb = sep === -1 ? rest : rest.slice(0, sep);
        if (isMarkerVerb(verb)) {
          markers.push(sep === -1 ? { verb } : { verb, payload: rest.slice(sep + 1) });
        }
      }
      i = s[j] === BEL ? j + 1 : j + 2;
      continue;
    }
    if (s[i] === BEL) {
      bell = true;
      i++;
      continue;
    }
    i++;
  }
  return { markers, bell, carry: '' };
}

/**
 * Keep ONE session's row status in sync with what its terminals are doing -
 * aggregated across EVERY shell tab, not just the primary one, so an agent
 * running in any tab is detected.
 *
 * Two modes, chosen PER SESSION by evidence:
 *
 * MARKER-DRIVEN (main launched a tab through an agent adapter, or any tab has
 * emitted a 6790 marker - see src/main/terminal.ts): status is purely
 * event-driven, mission-control-style. NO interval heuristics: output and
 * quiet don't touch the status at all.
 *   - 'ready' marker (agent launched / resumed) → a stale 'active' /
 *     'needs-input' becomes 'idle' QUIETLY (no alert, nothing finished)
 *   - 'running' / 'question-done' marker → 'active' ('running' = a prompt was
 *     submitted: it opens a fresh turn in session/activity)
 *   - 'tool-start' / 'tool-done' marker  → 'active', and WHAT the agent is doing
 *     (tool name + argument) goes to session/activity for the row's text -
 *     the wildcard PostToolUse 'tool-done' is also the heal for a sticky
 *     needs-input: the main agent's own tool completing proves it resumed.
 *     A SUBAGENT's tool (payload tagged with its agent type) is shown but
 *     leaves a waiting session waiting - a background agent works on while
 *     the main one sits at its dialog
 *   - 'needs-input' / 'question' marker  → 'needs-input' (question also carries
 *     WHAT is asked - published to session-questions for the UI; needs-input
 *     may carry the notification's own message, kept in session/activity)
 *   - 'finished' marker (turn ended)     → 'idle', and the turn's summary
 *     ("Finished - 3 files edited") is written to the session's `detail`
 *   - 'ended' marker (agent exited)      → 'idle', terminal back to fallback
 *   - a commit keystroke (Enter/digit/Esc - the user answering) while
 *     needs-input → 'active' immediately; the PostToolUse 'running' heal
 *     confirms it when the approved tool completes
 *   - Esc / Ctrl+C in a working or waiting tab (the user stopping the turn,
 *     which no hook reports) → 'idle' quietly, once no tab is still busy
 *   - every tab's shell has exited       → 'idle'
 *
 * FALLBACK (no marker seen - a plain shell, an agent with no adapter):
 *   - genuine output on any tab → 'active'; a real attention BEL → 'needs-input'
 *     (sticky: plain output never clears it - only a commit keystroke, exit, or
 *     a marker); quiet with no signal → 'idle' after the idle window.
 *   Output right after WE resized/focused a terminal is a self-induced redraw,
 *   not the agent working (see terminal-activity-gate) - ignored for 'active'.
 *
 * 'needs-input' is SIGNAL-gated in both modes, never guessed from a live
 * process. Transitions also fire desk-side alerts (see status-alerts).
 *
 * A stop ('idle' by the rules above) lands on 'finished' instead when the
 * session is not on screen in a focused window (`stopTarget`): the unseen mark
 * the user asked for - "which session finished while I was away?" - cleared
 * by opening the session (session/attention). The finished alert fires on
 * that transition.
 *
 * An 'archived' session ignores its terminals: opening one to look at it
 * mounts its tabs, and the agent resuming / the TUI repainting there reads as
 * 'active' - which used to pull the session straight back out of the archive
 * just for being viewed. It leaves only on the USER's say-so: a manual
 * unarchive, opening a new terminal in it (workspace-context), or a commit
 * keystroke (Enter, a quick-select digit, y/n, Esc) typed into one of its
 * terminals - which then settles it on what its tabs are doing right now.
 * Returns an unsubscribe.
 *
 * `shellPtyIds` is the session's current set of terminal PTY ids (editor tabs
 * have none). The caller (the mounted surface / the detached window, which hold
 * the live layout) re-invokes this when tabs are added/removed.
 */
export function observeSessionStatus(sessionId: string, shellPtyIds: string[]): () => void {
  // A runtime session: alerts from its row, and its terminal tabs observed as
  // usual - their verdict reaches main (applyStatus), which combines it with
  // the agent's.
  const row = agentSessionsCollection.get(sessionId);
  if (row && runsInView(row)) {
    const offRow = observeRuntimeSessionStatus(sessionId);
    const offTerminals = observeTerminalStatus(sessionId, shellPtyIds);
    return () => {
      offRow();
      offTerminals();
    };
  }
  return observeTerminalStatus(sessionId, shellPtyIds);
}

/** The terminal half of `observeSessionStatus`: a session's status from its shells. */
function observeTerminalStatus(sessionId: string, shellPtyIds: string[]): () => void {
  const term = window.api?.terminal;
  // No PTY bridge (plain-browser dev) or an older preload without the observers:
  // nothing to derive from.
  if (!term?.onActivity || !term?.onActivityExit) return () => {};

  // No shells at all (every tab closed): the session is idle by definition -
  // settle it once so a status from the last shell ('active'/'needs-input')
  // can't linger on the sidebar forever, then there's nothing to observe.
  if (shellPtyIds.length === 0) {
    settleFromTabs(sessionId, []);
    return () => {};
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  // Fallback-mode settle verdict (see SettleTo). Cleared when output resumes.
  let settleTo: SettleTo = null;
  // Tabs whose shell has exited - they no longer count toward "a program is running".
  const exited = new Set<string>();
  // Fallback mode: whether the user sent something (Enter, an answer key)
  // into one of the session's terminals since the last stop - what makes the
  // next stop a turn they are waiting on. See settleQuiet.
  let solicited = false;

  const hookDriven = (): boolean => shellPtyIds.some((id) => markerPtys.has(id));

  const clearTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /**
   * Apply a verdict (applyStatus, for this session while the observer lives).
   * `quiet` is the 'ready' marker's correction at launch: a stale
   * running/waiting status becomes idle with no alert and no unseen mark -
   * nothing finished, the app merely caught up with reality.
   */
  const set = (next: LiveStatus, opts: { quiet?: boolean } = {}): void => {
    if (!cancelled) applyStatus(sessionId, next, opts);
  };

  /**
   * The turn's summary becomes the session's persisted detail - the line its
   * row shows once nothing is live any more, on every surface and after a
   * restart. One write per turn end; a no-op when nothing changed.
   */
  const persistDetail = (summary: string): void => {
    const current = agentSessionsCollection.get(sessionId);
    if (!current || current.detail === summary) return;
    agentSessionsCollection.update(sessionId, (draft) => {
      draft.detail = summary;
    });
  };

  const armSettle = (): void => {
    clearTimer();
    idleTimer = setTimeout(settleQuiet, settleTo ? SETTLE_MS : STATUS_IDLE_MS);
  };

  /**
   * A fallback-mode stop alerts (the 'finished' mark, "Finished - waiting
   * for your reply") only when the user asked for the work: a key sent into
   * one of the session's terminals since the last stop. Output nobody asked
   * for - a dev server's log lines, a watcher, a prompt redrawing - read as a
   * finished turn every time it went quiet, and an off-screen session alerted
   * over and over with nothing to reply to (2026-11-02). It still shows as
   * working while it prints; its stop is plain idle, quietly.
   */
  const settleQuiet = (): void => {
    if (cancelled) return;
    const verdict = settleStatus(settleTo);
    set(verdict, verdict === 'idle' && !solicited ? { quiet: true } : {});
    if (verdict === 'idle') solicited = false;
  };

  // One lifecycle marker from an injected hook. Markers are the sole authority
  // once a terminal speaks the protocol - each one applies its status NOW and
  // cancels any fallback timer still pending from before the first marker.
  const applyMarker = (ptyId: string, m: StatusMarker): void => {
    clearTimer();
    settleTo = null;
    if (m.verb === 'ended') {
      // Agent exited back to the shell: back to fallback rules for this pty -
      // and gate the shell-prompt redraw that follows so it doesn't instantly
      // read as the session becoming 'active' again.
      markerPtys.delete(ptyId);
      suppressTerminalActivity(ptyId);
      clearTerminalBusy(ptyId);
      clearSessionActivity(sessionId);
      set('idle');
      return;
    }
    markerPtys.add(ptyId);
    switch (m.verb) {
      case 'ready':
        // The agent is up and speaks the protocol (SessionStart at launch /
        // resume). Arm marker mode without guessing at a state: a session
        // still marked running/waiting from before a restart is corrected to
        // idle quietly, an unseen finished mark is left for the user. Nothing
        // is running yet either - a stale live line would lie.
        noteTerminalReady(ptyId);
        clearSessionActivity(sessionId);
        set('idle', { quiet: true });
        break;
      case 'question':
      case 'needs-input':
        // A question IS a needs-input, plus its content. Publish before set():
        // the needs-input transition's OS notification reads the stores for
        // its body - the question, or what the pending tool wants.
        if (m.verb === 'question') publishSessionQuestion(sessionId, m.payload);
        else noteSessionWaiting(sessionId, m.payload);
        setTerminalBusy(ptyId, 'needs-input');
        set('needs-input');
        break;
      case 'running':
        // A prompt was submitted: a new turn, counted from zero.
        beginSessionTurn(sessionId);
        setTerminalBusy(ptyId, 'running');
        set('active');
        break;
      case 'tool-start':
      case 'tool-done': {
        // A subagent's tool - the Agent tool's worker, whose hooks fire in the
        // same process; a BACKGROUND one works on while the main agent sits
        // at a permission dialog - is work, never the user answering: while
        // the session waits on you it changes nothing. The main agent's own
        // tool-done, or a commit keystroke, lifts needs-input.
        if (
          decodeToolPayload(m.payload)?.agent &&
          agentSessionsCollection.get(sessionId)?.status === 'needs-input'
        )
          break;
        // What the agent is doing, for the row's text (and the turn's
        // counters) - and proof it is working, whatever the status said.
        if (m.verb === 'tool-start') noteToolStart(sessionId, m.payload);
        else noteToolDone(sessionId, m.payload);
        setTerminalBusy(ptyId, 'running');
        set('active');
        break;
      }
      case 'question-done':
        setTerminalBusy(ptyId, 'running');
        set('active');
        break;
      case 'finished': {
        // The tab keeps its own finished mark (cleared when the user views the
        // tab) - a session-level mark alone can't say WHICH of several agent
        // tabs stopped. The turn's summary outlives the live activity as the
        // session's detail; a finished with no open turn (a `/clear`) leaves
        // the previous summary alone.
        const summary = finishSessionTurn(sessionId);
        if (summary) persistDetail(summary);
        noteTerminalFinished(ptyId);
        set('idle');
        break;
      }
    }
  };

  const offs: Array<() => void> = [];

  // The user answering a blocked agent: a commit keystroke (Enter, a digit
  // quick-select, y/n, Esc) into any of this session's terminals lifts
  // needs-input optimistically and immediately - an event, not a timer. The
  // agent's own markers (PostToolUse 'running', 'question-done') confirm, and a
  // false lift (e.g. a cancelled dialog re-prompting) re-marks via its next
  // needs-input marker.
  offs.push(
    subscribeTerminalCommitKey((ptyId) => {
      if (cancelled || !shellPtyIds.includes(ptyId)) return;
      solicited = true;
      noteTerminalCommitKey(ptyId, markerPtys.has(ptyId));
      // The user working in an archived session: the one thing that brings it
      // back on its own. Picks up whatever its tabs were doing meanwhile.
      if (unarchiveSession(sessionId)) {
        settleFromTabs(sessionId, shellPtyIds);
        return;
      }
      if (agentSessionsCollection.get(sessionId)?.status !== 'needs-input') return;
      settleTo = null;
      set('active');
      if (!hookDriven()) armSettle();
    }),
  );

  // The user stopping the turn: Esc or Ctrl+C in a marker-driven tab that is
  // working or waiting. Claude Code fires no hook for an interrupt, so the
  // turn's `running` stood for good - a prompt cancelled before its first
  // reply left the session "Working…" (2026-09-23). Quiet: nothing finished.
  // A false stop (an Esc that only closed a menu mid-turn) heals on the
  // agent's next marker. The session settles only once none of its tabs is
  // still busy.
  offs.push(
    subscribeTerminalInterruptKey((ptyId) => {
      if (cancelled || !shellPtyIds.includes(ptyId) || !markerPtys.has(ptyId)) return;
      const working = (id: string): boolean => {
        const s = getTerminalBusy(id);
        return s === 'running' || s === 'needs-input';
      };
      if (!working(ptyId)) return;
      noteTerminalInterrupted(ptyId);
      if (shellPtyIds.some(working)) return;
      clearTimer();
      settleTo = null;
      clearSessionActivity(sessionId);
      set('idle', { quiet: true });
    }),
  );

  for (const ptyId of shellPtyIds) {
    // Per-terminal carry: each shell's stream is its own; an OSC (title, or our
    // marker) can be split across chunks.
    let carry = '';

    offs.push(
      term.onActivity(ptyId, (data, info) => {
        exited.delete(ptyId);
        if (info?.replay) {
          // An adopt replay (a reload, a tear-off, a remote host back from
          // away): the terminal's recent history, and its markers are old
          // turns. Read live they replayed `running` … `finished`, and a
          // session not on screen raised "Finished - waiting for your reply"
          // for a turn that ended long ago (2026-11-02). The stream starts
          // over after it; what the agent is doing now is main's to say.
          carry = '';
          seedFromMain();
          return;
        }
        const sig = scanSignals(carry, data);
        carry = sig.carry;

        if (sig.markers.length > 0) {
          sig.markers.forEach((m) => applyMarker(ptyId, m));
          return;
        }

        // Per-TAB busy tracking (the close-a-busy-tab warning, terminal-busy.ts):
        // a pty that doesn't speak the marker protocol is judged by its own
        // output/bell, independent of the session-level mode below - a plain
        // `pnpm test` tab stays busy even while a marker-driven Claude tab owns
        // the session's aggregate status.
        if (!markerPtys.has(ptyId)) {
          if (sig.bell) noteTerminalBell(ptyId);
          else if (!isTerminalActivitySuppressed(ptyId)) noteTerminalOutput(ptyId);
        }

        // A marker-driven session's status moves on events only - output (TUI
        // repaints, streaming text, even its terminal bell: the markers already
        // cover "blocked on you") never touches it.
        if (hookDriven()) return;

        // --- Fallback mode (no marker protocol on this session) ---

        // A real attention bell: the agent is blocked on you.
        if (sig.bell) {
          settleTo = 'needs-input';
          armSettle();
          return;
        }

        // Output we caused by resizing/focusing this terminal (a TUI redraw), not
        // the agent working - don't let it flip the session to 'active'.
        if (isTerminalActivitySuppressed(ptyId)) return;

        // Sticky needs-input: while blocked on you, a TUI repaints on plenty of
        // non-answers - output alone never clears the verdict (a commit
        // keystroke, a marker, or exit does; see the subscription above).
        if (settleTo === 'needs-input') {
          armSettle();
          return;
        }

        // Genuine output: the agent is working.
        settleTo = null;
        set('active');
        armSettle();
      }),
    );
    offs.push(
      term.onActivityExit(ptyId, () => {
        exited.add(ptyId);
        markerPtys.delete(ptyId);
        clearTerminalBusy(ptyId);
        if (exited.size >= shellPtyIds.length) {
          clearTimer();
          settleTo = null;
          clearSessionActivity(sessionId);
          set('idle');
        } else if (!hookDriven()) {
          // A sibling tab may still hold a blocked agent - re-check after the quiet
          // window instead of calling the whole session idle on one tab closing.
          armSettle();
        }
      }),
    );
  }

  // Terminals main launched through an agent adapter speak the protocol from
  // the start - learn that up front, so a session observed afresh (a remount,
  // a renderer reload, an app start that resumed the agent) never sits in
  // fallback mode waiting for a first marker a parked agent won't send. A
  // fallback timer that got armed meanwhile is cancelled; the status itself is
  // left to the markers. Optional-chained: an older preload has no such bridge,
  // and the first marker still arms the mode there.
  void term.markerDriven?.(shellPtyIds).then((ids) => {
    if (cancelled || ids.length === 0) return;
    ids.forEach((id) => markerPtys.add(id));
    clearTimer();
    settleTo = null;
  });

  // ...and what each of those agents is doing, as main read it off the stream:
  // a window that just loaded or adopted a tab (a reload - an HMR full reload
  // counts - or a tear-off) has seen none of its markers, and an agent parked
  // on a background subagent sends none until the subagent reports back - its
  // tab sat unwashed with no dot while it worked. Fills gaps only (see
  // seedTerminalBusy). Known gap: a wait the user answered in the previous
  // renderer (the commit keystroke lifts it renderer-side only) reads as a
  // wait until the approved tool reports back.
  const seedFromMain = (): void => {
    void term.agentStatus?.(shellPtyIds).then(applyMainReading);
  };
  const applyMainReading = (
    statuses: { id: string; status: 'running' | 'needs-input' | 'idle' }[],
  ): void => {
    if (cancelled) return;
    for (const { id, status } of statuses) {
      if (shellPtyIds.includes(id)) seedTerminalBusy(id, status === 'idle' ? null : status);
    }
    // The row itself may be stale the same way: a 'finished' marker that
    // landed while no observer listened (a reload mid-turn) left it 'active',
    // and a marker-driven session has no quiet timer to undo that - the
    // sidebar said "Working…" over an idle agent until its next turn
    // (2026-10-07). Correct it quietly, but only when main vouches for every
    // agent tab as idle and nothing this renderer saw since says otherwise.
    // Tabs main has no reading for (plain shells) are left out: in a
    // marker-driven session their output never moves the row, so their
    // silence cannot keep it 'active' either. Requiring them too left a row
    // that output had flipped 'active' in the moment before main's answer
    // stuck on "Working…" for good - an idle Claude whose status line ticks
    // every second, beside a quiet shell tab (2026-10-14).
    const agentTabs = statuses.map((s) => s.id).filter((id) => shellPtyIds.includes(id));
    if (agentTabs.length === 0) return;
    // The other way round: a row a stray verdict settled idle mid-turn - an
    // observer of the wrong terminal (an evicted session watched through its
    // conversation tab while Claude ran in a second one) let the fallback
    // quiet timer fire - stayed idle under a green tab dot until the agent's
    // next marker, which a long Bash holds back for minutes (2026-10-29).
    // Restored quietly from the tabs as this renderer now reads them (its own
    // evidence first, main's seed only in the gaps), agent tabs only: a plain
    // shell's output never moves a marker-driven row. Only a row that reads
    // stopped is touched - one already working or waiting stays with the
    // markers (main never learns of the commit key that answered a wait).
    const live = aggregateTabStatus(agentTabs);
    if (live === 'active' || live === 'needs-input') {
      const row = agentSessionsCollection.get(sessionId)?.status;
      if (row === 'idle' || row === 'finished') set(live, { quiet: true });
      return;
    }
    if (statuses.some((s) => s.status !== 'idle')) return;
    if (aggregateTabStatus(agentTabs) !== 'idle') return;
    clearSessionActivity(sessionId);
    set('idle', { quiet: true });
  };
  seedFromMain();

  // Observed afresh (the tab set changed, a remount) with no window armed: a
  // fallback-mode session still marked running may already be quiet - the
  // previous observer took its timer with it - and would stay 'active' until
  // something printed again. Arm the quiet window so it settles on its own;
  // for a marker-driven session the bridge's answer above cancels it.
  if (!hookDriven() && agentSessionsCollection.get(sessionId)?.status === 'active') armSettle();

  return () => {
    cancelled = true;
    clearTimer();
    offs.forEach((off) => off());
  };
}

/**
 * Runtime sessions (`runsInView`): main writes the live status from the agent
 * (active / needs-input / idle); the window observing the
 * session turns its transitions into what a terminal session gets - the unseen
 * 'finished' mark for a turn that ended while nobody watched (`stopTarget`,
 * main's idle write leaves the mark alone) and the needs-input / finished
 * alerts. Called through `observeSessionStatus`, so it runs exactly where a
 * terminal session's observer would.
 */
export function observeRuntimeSessionStatus(sessionId: string): () => void {
  let prev = agentSessionsCollection.get(sessionId)?.status;
  const subscription = agentSessionsCollection.subscribeChanges?.((changes) => {
    for (const change of changes) {
      if (change.key !== sessionId || change.type === 'delete') continue;
      const next = change.value.status;
      const before = prev;
      prev = next;
      if (!before || before === next) continue;
      if (next === 'needs-input') {
        signalStatusChange(sessionId, before, 'needs-input');
      } else if (
        next === 'idle' &&
        stopTarget(before, isSessionWatched(sessionId)) === 'finished'
      ) {
        agentSessionsCollection.update(sessionId, (draft) => {
          draft.status = 'finished';
        });
        signalStatusChange(sessionId, before, 'finished');
      }
    }
  });
  return () => subscription?.unsubscribe();
}
