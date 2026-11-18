import { useSyncExternalStore } from 'react';

/**
 * Per-window store of the question an agent is currently asking a session's user,
 * decoded from the `question` status marker (see session-status.ts): our injected
 * PreToolUse hook forwards Claude's AskUserQuestion tool input - the whole hook
 * stdin JSON, base64-encoded - over the private OSC channel, and this store makes
 * it available to the UI (sidebar rows, OS-notification body).
 *
 * Ephemeral by design: entries live only in the window that observes the session's
 * PTYs (same ownership as session-status) and are cleared the moment the session
 * leaves 'needs-input' - the question was answered, the agent moved on, or the
 * shells exited. Nothing is persisted.
 */
export type SessionQuestion = {
  /** The first (usually only) question the agent is asking. */
  question: string;
  /** Its option labels, in order; empty when free-form. */
  options: string[];
};

/**
 * Decode a `question` marker payload - base64 of the PreToolUse hook's stdin
 * JSON - into the first question. Null on any malformed input (a truncated
 * payload, foreign JSON shape): the caller still has the needs-input status,
 * it just loses the richer text. Pure, for tests.
 */
export function decodeQuestionPayload(payload: string): SessionQuestion | null {
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const toolInput = (parsed as { tool_input?: unknown }).tool_input;
    if (typeof toolInput !== 'object' || toolInput === null) return null;
    const questions = (toolInput as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) return null;
    const first: unknown = questions[0];
    if (typeof first !== 'object' || first === null) return null;
    const question = (first as { question?: unknown }).question;
    if (typeof question !== 'string' || !question) return null;
    const rawOptions = (first as { options?: unknown }).options;
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .map((o: unknown) =>
            typeof o === 'string' ? o : ((o as { label?: unknown } | null)?.label ?? null),
          )
          .filter((label): label is string => typeof label === 'string' && label !== '')
      : [];
    return { question, options };
  } catch {
    return null;
  }
}

// Immutable snapshot, swapped wholesale on every change so useSyncExternalStore
// consumers see a new reference (and unchanged windows don't re-render: a
// per-session lookup on an unchanged entry returns the same object).
let snapshot: ReadonlyMap<string, SessionQuestion> = new Map();
const listeners = new Set<() => void>();

function swap(mutate: (next: Map<string, SessionQuestion>) => boolean): void {
  const next = new Map(snapshot);
  if (!mutate(next)) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

/** Record the question a session's agent just asked (no-op on undecodable payload). */
export function publishSessionQuestion(sessionId: string, payload: string | undefined): void {
  const parsed = payload ? decodeQuestionPayload(payload) : null;
  if (!parsed) return;
  swap((next) => {
    next.set(sessionId, parsed);
    return true;
  });
}

/** Drop a session's pending question (answered / agent resumed / shells gone). */
export function clearSessionQuestion(sessionId: string): void {
  swap((next) => next.delete(sessionId));
}

/** Non-reactive lookup - for one-shot consumers like the OS-notification body. */
export function getSessionQuestion(sessionId: string): SessionQuestion | null {
  return snapshot.get(sessionId) ?? null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** All pending questions - for list surfaces that render many session rows. */
export function useSessionQuestionMap(): ReadonlyMap<string, SessionQuestion> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** One session's pending question (null when none). */
export function useSessionQuestion(sessionId: string): SessionQuestion | null {
  return useSyncExternalStore(subscribe, () => snapshot.get(sessionId) ?? null);
}
