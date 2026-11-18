import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-tab agent conversation continuity: a terminal tab that auto-runs `claude`
 * comes back to ITS OWN conversation after an app restart, while a newly opened
 * tab always starts a fresh one.
 *
 * The whole thing rides on ids we already have:
 *
 * - Claude Code's `--session-id <uuid>` names a NEW conversation (it errors with
 *   "already in use" if that id exists) and `--resume <uuid>` reopens an existing
 *   one. Both want a plain UUID.
 * - Every terminal tab's `ptyId` is already a `crypto.randomUUID()` (see
 *   workspace-context.tsx), and the primary conversation tab's is
 *   `conversation:<session uuid>`. Both are stored in the session's persisted
 *   layout, so they survive a restart - and a brand-new tab mints a brand-new
 *   uuid it has never been launched under.
 *
 * So: pty id → Claude session id. A restored tab resolves to an id whose
 * transcript is already on disk → `--resume`. A new tab resolves to an unseen id
 * → `--session-id`. No DB column.
 *
 * One twist: the conversation a tab is IN drifts away from the id it was
 * LAUNCHED under. `/clear` doesn't empty the session in place - it ends it and
 * starts a new one under a fresh uuid (verified on CLI 2.1.245: SessionEnd
 * {reason:"clear"} then SessionStart {source:"clear", session_id:<new>}); `/resume`
 * inside Claude switches to another id outright. Relaunching the tab's own uuid
 * after that reopens the PRE-clear conversation - an older one than the user
 * was working in. So the injected SessionStart hook (claude-status-hooks.ts)
 * records the live session id into a per-tab file, keyed by the tab's uuid, and
 * `resolveClaudeSession` prefers that record over the uuid itself. The file
 * lives in userData (it must outlive tmpdir purges) and is dropped when the tab
 * or its session is deleted.
 *
 * Whether to `--resume` or `--session-id` is decided by looking for the
 * transcript rather than by remembering what we did last time, so wiping
 * `~/.claude` degrades to a fresh conversation instead of a hard "session not
 * found" error in the user's terminal. The same rule makes a `/clear` that was
 * never followed by a prompt (no transcript yet) come back as the empty
 * conversation it was, under the recorded id.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Claude session id a PTY should run under, or null for a PTY that must not
 * be pinned to one. Only the two shapes that are stable across restarts qualify:
 * the primary conversation PTY (`conversation:<uuid>`) and a terminal tab's own
 * uuid. Anything else - the one-shot worktree setup shell (`setup:<uuid>`), or a
 * legacy/hand-made id - is left alone, so its `claude` launches unpinned exactly
 * as it does today.
 */
export function claudeSessionIdForPty(ptyId: string): string | null {
  const bare = ptyId.startsWith('conversation:') ? ptyId.slice('conversation:'.length) : ptyId;
  return UUID_RE.test(bare) ? bare.toLowerCase() : null;
}

/**
 * Claude Code's per-directory transcript folder name: the absolute cwd with `/`
 * and `.` flattened to `-` (so `/Users/x/.config/app` → `-Users-x--config-app`).
 * Case is preserved. Verified against a live `~/.claude/projects` - but it is
 * Claude's own internal layout, not a documented contract, hence the sibling
 * scan in `claudeTranscriptExists`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

/** Claude Code's config root - `CLAUDE_CONFIG_DIR` wins, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

/** Where Claude Code keeps the transcript for `sessionId` started in `cwd`. */
export function claudeTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Whether `sessionId` has a transcript - i.e. whether to resume it or create it.
 *
 * The slug lookup is the answer in every normal case. The fallback stats the
 * same filename under every sibling project folder, which costs one `stat` per
 * folder and only ever runs on a miss (a genuinely new tab). It exists so that a
 * future change to Claude's folder-naming degrades to "slower" rather than to
 * "every restart tries to create an id that already exists and errors out". Ids
 * are random uuids, so a hit under a differently-named folder is the same
 * conversation, never someone else's.
 */
export function claudeTranscriptExists(configDir: string, cwd: string, sessionId: string): boolean {
  if (existsSync(claudeTranscriptPath(configDir, cwd, sessionId))) return true;
  const projects = join(configDir, 'projects');
  try {
    return readdirSync(projects, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && existsSync(join(projects, entry.name, `${sessionId}.jsonl`)),
    );
  } catch {
    // No projects folder yet (Claude has never run here) - nothing to resume.
    return false;
  }
}

// --- Live session records ----------------------------------------------------

/**
 * Environment variable the launch shell exports for the agent - and so for every
 * hook it spawns - naming the file the SessionStart hook writes the live session
 * id to (see STATUS_HOOK_SCRIPT). Absent for an unpinned launch, in which case
 * the hook records nothing.
 */
export const SESSION_RECORD_ENV = 'DOUBLE0_SESSION_FILE';

/** The folder of per-tab session records, under the app's userData. */
export function claudeSessionRecordsDir(userData: string): string {
  return join(userData, 'claude-sessions');
}

/** One tab's record file: its restart-stable uuid, never the raw pty id. */
export function claudeSessionRecordPath(recordsDir: string, tabId: string): string {
  return join(recordsDir, tabId);
}

/**
 * The session id last recorded for a tab, or null when there is no record or it
 * doesn't hold a uuid (a torn write, a hand-edited file). The hook writes the id
 * bare; whitespace is tolerated.
 */
export function recordedClaudeSessionId(recordPath: string): string | null {
  try {
    const id = readFileSync(recordPath, 'utf8').trim();
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Drop a tab's record (tab closed / session deleted). Never throws. */
export function forgetClaudeSession(recordsDir: string, ptyId: string): void {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return;
  const record = claudeSessionRecordPath(recordsDir, tabId);
  // The record and its sidecars: the transcript path, Claude's pid, a
  // following view's permission folder and pasted images.
  for (const path of [
    record,
    `${record}.transcript`,
    `${record}.pid`,
    `${record}.ask`,
    `${record}.images`,
  ]) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // Already gone, or the folder was never created.
    }
  }
}

// --- Codex ---------------------------------------------------------------------
//
// A Codex tab's record is ONLY for an extension's view over its CLI: no
// continuity yet (`codex resume <id>` takes none
// of the TUI's flags - a private plan). Its own folder, never
// the Claude record: a Codex thread id there would make the tab's next `claude`
// resume a conversation that does not exist. The hook script's `session` verb
// writes, under Codex, the thread id to the record, the rollout path to
// `<record>.transcript` and Codex's pid to `<record>.pid` - at the FIRST
// prompt (Codex fires SessionStart lazily, not at launch).

/** Env var naming the file the SessionStart hook records a tab's live Codex thread in. */
export const CODEX_SESSION_RECORD_ENV = 'DOUBLE0_CODEX_SESSION_FILE';

/** The folder of per-tab Codex records, under the app's userData. */
export function codexSessionRecordsDir(userData: string): string {
  return join(userData, 'codex-sessions');
}

/**
 * A launch's Codex record file, or null for a PTY with no restart-stable uuid.
 * Ensures the folder exists so the hook's write can't fail on a fresh install.
 */
export function codexSessionRecordFor(ptyId: string, recordsDir: string): string | null {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return null;
  try {
    mkdirSync(recordsDir, { recursive: true });
  } catch {
    // The hook's write fails quietly; a view then has no conversation to show.
  }
  return claudeSessionRecordPath(recordsDir, tabId);
}

/** Drop a tab's Codex record and its sidecars (tab closed / session deleted). Never throws. */
export function forgetCodexSession(recordsDir: string, ptyId: string): void {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return;
  const record = claudeSessionRecordPath(recordsDir, tabId);
  for (const path of [
    record,
    `${record}.transcript`,
    `${record}.pid`,
    `${record}.ask`,
    `${record}.images`,
  ]) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // Already gone, or never created.
    }
  }
}

// --- OpenCode ------------------------------------------------------------------
//
// The same idea for OpenCode, with two differences: OpenCode mints its own
// session ids (`ses_…`), so a tab can only CONTINUE a session it has run
// (`opencode -s <id>`), never name a new one - the record is the only pin,
// and a tab without one starts fresh; and whether the session still exists
// is checked by the `opencode` shim at launch (claude-shim.ts), since the
// sessions live in OpenCode's sqlite database. The status plugin
// (opencode-status-plugin.ts) writes the live top-level session's id to the
// record on every session.created / updated, and removes it on deleted.

/** Env var naming the file the OpenCode plugin records the tab's live session id in. */
export const OPENCODE_SESSION_RECORD_ENV = 'DOUBLE0_OPENCODE_SESSION_FILE';

/** The folder of per-tab OpenCode session records, under the app's userData. */
export function opencodeSessionRecordsDir(userData: string): string {
  return join(userData, 'opencode-sessions');
}

/** OpenCode's session id shape (`ses_` + its identifier characters). */
const OPENCODE_ID_RE = /^ses_[A-Za-z0-9]{6,}$/;

/** The OpenCode session id last recorded for a tab, or null (no record, a malformed one). */
export function recordedOpencodeSessionId(recordPath: string): string | null {
  try {
    const id = readFileSync(recordPath, 'utf8').trim();
    return OPENCODE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Drop a tab's OpenCode record (tab closed / session deleted). Never throws. */
export function forgetOpencodeSession(recordsDir: string, ptyId: string): void {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return;
  try {
    rmSync(claudeSessionRecordPath(recordsDir, tabId), { force: true });
  } catch {
    // Already gone, or the folder was never created.
  }
}

export type OpencodeSessionPlan = {
  /** The session to continue, or null when the tab has none recorded. */
  sessionId: string | null;
  /** The record file the plugin keeps current for this tab. */
  recordPath: string;
};

/**
 * The OpenCode continuity for a launch, or null for a PTY with no
 * restart-stable uuid (same rule as Claude's). Ensures the records folder
 * exists so the plugin's write can't fail on a fresh install.
 */
export function resolveOpencodeSession(
  ptyId: string,
  recordsDir: string,
): OpencodeSessionPlan | null {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return null;
  try {
    mkdirSync(recordsDir, { recursive: true });
  } catch {
    // Unwritable userData - the plugin's write will fail silently as well.
  }
  const recordPath = claudeSessionRecordPath(recordsDir, tabId);
  return { sessionId: recordedOpencodeSessionId(recordPath), recordPath };
}

export type ClaudeSessionPlan = {
  /** The conversation to run under - the recorded live id, else the tab's own. */
  sessionId: string;
  /** Whether that conversation has a transcript (→ `--resume`, else `--session-id`). */
  exists: boolean;
  /** The record file the SessionStart hook keeps current for this tab. */
  recordPath: string;
};

/**
 * Everything the adapter needs to pin a launch, or null for a PTY with no
 * restart-stable uuid. Ensures the records folder exists so the hook's write
 * can't fail on a fresh install; if that fails the launch still proceeds and
 * simply records nothing (degrading to the pre-record behaviour).
 */
export function resolveClaudeSession(
  ptyId: string,
  cwd: string,
  dirs: { configDir: string; recordsDir: string },
): ClaudeSessionPlan | null {
  const tabId = claudeSessionIdForPty(ptyId);
  if (!tabId) return null;
  try {
    mkdirSync(dirs.recordsDir, { recursive: true });
  } catch {
    // Unwritable userData - the hook's write will fail silently as well.
  }
  const recordPath = claudeSessionRecordPath(dirs.recordsDir, tabId);
  const sessionId = recordedClaudeSessionId(recordPath) ?? tabId;
  return {
    sessionId,
    exists: claudeTranscriptExists(dirs.configDir, cwd, sessionId),
    recordPath,
  };
}

/** Single-quote `value` for a POSIX shell (`'` → `'\''`) - userData has spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Flags that already pin the conversation. A user who typed their own
// `claude --resume`, `claude -c`, or `claude --session-id …` as the tab's start
// command means it, so we add nothing. `=`-joined forms (`--session-id=x`) count.
const SESSION_FLAGS = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--session-id',
  '--fork-session',
  '--cloud',
]);

export function pinsOwnSession(command: string): boolean {
  return command
    .split(/\s+/)
    .slice(1)
    .some((token) => SESSION_FLAGS.has(token.split('=')[0]));
}

/**
 * Pin a leading `claude` to `sessionId` - `--resume` when its transcript exists,
 * `--session-id` when it does not. Returns the command untouched when the id
 * isn't a uuid or the command already pins a conversation of its own.
 */
export function withClaudeSession(command: string, sessionId: string, exists: boolean): string {
  if (!UUID_RE.test(sessionId) || pinsOwnSession(command)) return command;
  return command.replace(/^claude/, `claude ${exists ? '--resume' : '--session-id'} ${sessionId}`);
}
