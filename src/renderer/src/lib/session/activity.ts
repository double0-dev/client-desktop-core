import { useSyncExternalStore } from 'react';
import {
  EMPTY_ACTIVITY,
  finishedLine,
  isEditTool,
  isShellTool,
  type SessionActivity,
  type ToolCall,
} from '@renderer/lib/session/activity-text';

/**
 * Per-window store of what each session's agent is doing right now, decoded
 * from the tool markers our injected hooks emit (see session-status.ts and
 * claude-status-hooks.ts in main): every tool call's name and headline
 * argument, before it runs (`tool-start`) and after (`tool-done`), plus the
 * message of a notification that blocked the agent on the user. The UI reads
 * it through session/activity-text.ts to say "Editing token.service.ts",
 * "Wants to run pnpm test", and - when the turn ends - to write the summary
 * ("Finished - 3 files edited") into the session's persisted `detail`.
 *
 * Ephemeral by design, like session/questions.ts: entries live only in the
 * window that observes the session's PTYs and are dropped when the agent
 * exits or is relaunched. Only the end-of-turn summary is persisted, so the
 * sidebar and the tabs agree after a restart too.
 */

// Immutable snapshot, swapped wholesale on every change so useSyncExternalStore
// consumers see a new reference (a per-session lookup on an unchanged entry
// returns the same object, so unaffected rows don't re-render).
let snapshot: ReadonlyMap<string, SessionActivity> = new Map();
const listeners = new Set<() => void>();

function swap(sessionId: string, next: SessionActivity | null): void {
  const map = new Map(snapshot);
  if (next) map.set(sessionId, next);
  else if (!map.delete(sessionId)) return;
  snapshot = map;
  listeners.forEach((l) => l());
}

function current(sessionId: string): SessionActivity {
  return snapshot.get(sessionId) ?? EMPTY_ACTIVITY;
}

/** The marker payload is base64 of UTF-8 text; null on anything undecodable. */
function decodeText(payload: string | undefined): string | null {
  if (!payload) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode a `tool-start` / `tool-done` payload - base64 of `<tool name>\n<arg>`,
 * plus a third line with the agent type when a subagent made the call, as the
 * hook script builds it - into the call. Null when there is no tool name (a
 * malformed or foreign payload); an empty arg becomes null, an absent agent
 * line the main agent's own call.
 */
export function decodeToolPayload(payload: string | undefined): ToolCall | null {
  const text = decodeText(payload);
  if (text === null) return null;
  const [first = '', second = '', third = ''] = text.split('\n');
  const tool = first.trim();
  if (!tool) return null;
  const arg = second.trim();
  const agent = third.trim();
  const call: ToolCall = { tool, arg: arg || null };
  return agent ? { ...call, agent } : call;
}

/** A prompt was submitted: a fresh turn, with nothing done yet. */
export function beginSessionTurn(sessionId: string): void {
  swap(sessionId, { ...EMPTY_ACTIVITY, turnOpen: true });
}

/**
 * A tool is about to run (its PreToolUse hook - which precedes any permission
 * prompt, so a needs-input that follows can say what the agent wants to do).
 * No-op on an undecodable payload.
 */
export function noteToolStart(sessionId: string, payload: string | undefined): void {
  const call = decodeToolPayload(payload);
  if (!call) return;
  swap(sessionId, { ...current(sessionId), turnOpen: true, current: call, waiting: null });
}

/**
 * A tool completed: count it - an edit tool's file (once per distinct path),
 * a shell tool's command - and clear the pending-permission state, since the
 * call went through. The completed call also stays the current one: "Editing
 * x" holds until the next tool starts.
 */
export function noteToolDone(sessionId: string, payload: string | undefined): void {
  const call = decodeToolPayload(payload);
  if (!call) return;
  const prev = current(sessionId);
  const editedFiles =
    isEditTool(call.tool) && call.arg && !prev.editedFiles.includes(call.arg)
      ? [...prev.editedFiles, call.arg]
      : prev.editedFiles;
  const commands = isShellTool(call.tool) ? prev.commands + 1 : prev.commands;
  swap(sessionId, { ...prev, turnOpen: true, current: call, editedFiles, commands, waiting: null });
}

/**
 * The agent is blocked on the user, with the notification's own message when
 * the hook carried one ("Claude needs your permission"). The
 * pending tool, if any, already says it better - see waitingLine.
 */
export function noteSessionWaiting(sessionId: string, payload: string | undefined): void {
  const message = decodeText(payload)?.trim() || null;
  const prev = current(sessionId);
  if (prev.waiting === message) return;
  swap(sessionId, { ...prev, waiting: message });
}

/**
 * The turn ended. Returns the summary line to persist as the session's detail
 * - or null when no turn was open (a `/clear`, a relaunch: nothing to sum up,
 * and the previous summary must survive). The live entry is dropped either
 * way: nothing is running any more.
 */
export function finishSessionTurn(sessionId: string): string | null {
  const prev = snapshot.get(sessionId);
  swap(sessionId, null);
  return prev?.turnOpen ? finishedLine(prev) : null;
}

/** The agent exited or was relaunched: nothing is running, nothing pending. */
export function clearSessionActivity(sessionId: string): void {
  swap(sessionId, null);
}

/** Non-reactive lookup - for one-shot consumers like the OS-notification body. */
export function getSessionActivity(sessionId: string): SessionActivity | null {
  return snapshot.get(sessionId) ?? null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Every session's live activity - for list surfaces that render many rows. */
export function useSessionActivityMap(): ReadonlyMap<string, SessionActivity> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** One session's live activity (null when nothing is known). */
export function useSessionActivity(sessionId: string): SessionActivity | null {
  return useSyncExternalStore(subscribe, () => snapshot.get(sessionId) ?? null);
}
