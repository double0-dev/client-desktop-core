import type { AgentSession } from '@renderer/lib/collections';
import type { SessionQuestion } from '@renderer/lib/session/questions';

/**
 * The words on a session row's second line - what the agent is doing, what
 * it is blocked on, or what its last turn came to. Pure: everything here is
 * derived from the hook-reported activity (session/activity.ts), the pending
 * question (session/questions.ts) and the persisted `detail` column, so every
 * surface (sidebar rows, tabs, notifications) says the same thing.
 */

/**
 * One tool call as the injected hooks report it: the tool's name and its
 * headline argument - a file path, a shell command, a search pattern, a
 * delegated task's description - or null when the tool has none we show.
 */
export type ToolCall = {
  tool: string;
  arg: string | null;
  /**
   * The agent type when a subagent (the Agent tool's worker, foreground or
   * background) made the call; absent for the main agent's own. Shown like
   * any other call, but never taken as the user answering (session/status).
   */
  agent?: string;
};

export type SessionActivity = {
  /** A prompt was submitted and no finished marker has closed the turn yet. */
  turnOpen: boolean;
  /** The tool most recently started this turn (its PreToolUse hook). */
  current: ToolCall | null;
  /** Distinct files an edit tool completed on this turn, in first-touch order. */
  editedFiles: readonly string[];
  /** Shell commands completed this turn. */
  commands: number;
  /**
   * The agent's own words for what it is blocked on (the message of the
   * notification that flipped it to needs-input), when the hooks carried one.
   */
  waiting: string | null;
};

export const EMPTY_ACTIVITY: SessionActivity = {
  turnOpen: false,
  current: null,
  editedFiles: [],
  commands: 0,
  waiting: null,
};

/** How a line is coloured: the muted second line, or the warning tint of a session blocked on you. */
export type LineTone = 'muted' | 'warning';
export type SessionLine = {
  text: string;
  tone: LineTone;
  /**
   * The line reports the agent right now - what it is doing or what it is
   * blocked on - rather than the summary a past turn left. A row gives a live
   * line the room other row-2 content would take (the sidebar's folder chip).
   */
  live: boolean;
};

// The tools, by the names their CLIs report to hooks, grouped by what they do
// to the user's project: Claude Code's CamelCase names, Codex's (`apply_patch`,
// `shell`, `exec_command`, `local_shell`, `read_file`) and OpenCode's lowercase
// ones (`edit`, `write`, `read`, `bash`, `grep`, `glob`, `webfetch`, `task`,
// `question`, `todowrite`, `skill`, `patch`). Compared lowercased, so a CLI's
// casing never decides a row's phrase. Unknown tools fall through to a
// generic "Using".
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch']);
const WRITE_TOOLS = new Set(['write']);
const READ_TOOLS = new Set(['read', 'read_file']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);

function canon(tool: string): string {
  return tool.toLowerCase();
}

/** Whether a completed call of this tool edited the file in its argument. */
export function isEditTool(tool: string): boolean {
  const t = canon(tool);
  return EDIT_TOOLS.has(t) || WRITE_TOOLS.has(t);
}

/** Whether a completed call of this tool ran a shell command. */
export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(canon(tool));
}

const MAX_ARG = 60;

/** The last path segment - rows have no room for directories. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/**
 * A shell command as a headline: its first line, whitespace collapsed, a
 * dangling backslash (the hook cut the string at an escaped quote) dropped,
 * and capped at a row's worth of characters.
 */
function headline(command: string): string {
  const first = command.split(/\\n|\n/)[0] ?? '';
  const flat = first.replace(/\s+/g, ' ').replace(/\\$/, '').trim();
  return flat.length > MAX_ARG ? `${flat.slice(0, MAX_ARG - 1)}…` : flat;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return headline(url);
  }
}

/** `mcp__github__create_issue` → `github: create_issue`; anything else unchanged. */
function toolLabel(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  return m ? `${m[1]}: ${m[2]}` : tool;
}

/** What a tool call is doing, present tense - the running row's text. */
export function describeTool({ tool, arg }: ToolCall): string {
  const t = canon(tool);
  if (EDIT_TOOLS.has(t)) return arg ? `Editing ${basename(arg)}` : 'Editing a file';
  if (WRITE_TOOLS.has(t)) return arg ? `Writing ${basename(arg)}` : 'Writing a file';
  if (READ_TOOLS.has(t)) return arg ? `Reading ${basename(arg)}` : 'Reading a file';
  if (SHELL_TOOLS.has(t)) return arg ? `Running ${headline(arg)}` : 'Running a command';
  if (SEARCH_TOOLS.has(t)) return arg ? `Searching "${headline(arg)}"` : 'Searching the project';
  switch (t) {
    case 'task':
      return arg ? `Delegating: ${headline(arg)}` : 'Delegating a task';
    case 'webfetch':
      return arg ? `Fetching ${host(arg)}` : 'Fetching a page';
    case 'websearch':
      return arg ? `Searching the web: ${headline(arg)}` : 'Searching the web';
    case 'skill':
      return arg ? `Running skill ${headline(arg)}` : 'Running a skill';
    case 'todowrite':
    case 'todoread':
    case 'enterplanmode':
      return 'Planning';
    case 'exitplanmode':
      return 'Wrapping up the plan';
    case 'askuserquestion':
    case 'question':
      return 'Asking a question';
    default:
      return `Using ${toolLabel(tool)}`;
  }
}

/** What a blocked agent is asking leave to do - the needs-input row's text. */
export function describeWant({ tool, arg }: ToolCall): string {
  const t = canon(tool);
  if (EDIT_TOOLS.has(t)) return arg ? `Wants to edit ${basename(arg)}` : 'Wants to edit a file';
  if (WRITE_TOOLS.has(t)) return arg ? `Wants to write ${basename(arg)}` : 'Wants to write a file';
  if (READ_TOOLS.has(t)) return arg ? `Wants to read ${basename(arg)}` : 'Wants to read a file';
  if (SHELL_TOOLS.has(t)) return arg ? `Wants to run ${headline(arg)}` : 'Wants to run a command';
  switch (t) {
    case 'webfetch':
      return arg ? `Wants to fetch ${host(arg)}` : 'Wants to fetch a page';
    case 'exitplanmode':
      return 'Plan ready for review';
    case 'askuserquestion':
    case 'question':
      return 'Asking a question';
    default:
      return `Wants to use ${toolLabel(tool)}`;
  }
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The running row: the current tool, plus how many files the turn has touched. */
export function runningLine(a: SessionActivity): string {
  const head = a.current ? describeTool(a.current) : 'Working…';
  return a.editedFiles.length >= 2
    ? `${head} · ${plural(a.editedFiles.length, 'file')} so far`
    : head;
}

/** The blocked row: the pending tool, else the agent's own message, else generic. */
export function waitingLine(a: SessionActivity): string {
  if (a.current) return describeWant(a.current);
  return a.waiting ?? 'Needs your input';
}

/**
 * What the turn came to - persisted as the session's detail when it ends. A
 * turn with neither edits nor commands says plain "Finished": it only ever
 * saw THIS turn's tools, and "no changes" under a session whose folder held
 * an earlier turn's new files read as a claim about the folder. The row's
 * `+N -M` counts are what speak for the folder.
 */
export function finishedLine(a: SessionActivity): string {
  if (a.editedFiles.length > 0) return `Finished - ${plural(a.editedFiles.length, 'file')} edited`;
  if (a.commands > 0) return `Finished - ${plural(a.commands, 'command')} run`;
  return 'Finished';
}

/**
 * The one line a session row shows under its name, or null for nothing.
 * Precedence follows what the user needs to know first: a blocked session says
 * what it is blocked on (the question it asked, the tool it wants to use, its
 * own message); a working session says what it is doing; a parked one keeps
 * the summary its last turn left in `detail`.
 *
 * A working session never falls back to that summary. The status is persisted
 * and shared by every window; the activity is not - it lives only in the
 * window whose observer heard the turn open. After a renderer reload, or for
 * a session torn off into its own window, an agent mid-turn has no activity
 * here, and a "Finished" summary next to a working dot reads as an agent
 * that stopped. It says "Working…" until a tool marker brings the detail back.
 */
export function resolveSessionLine(input: {
  status: AgentSession['status'];
  activity: SessionActivity | null | undefined;
  question: SessionQuestion | null | undefined;
  detail: string;
}): SessionLine | null {
  const { status, activity, question, detail } = input;
  if (status === 'needs-input') {
    if (question?.question) return { text: question.question, tone: 'warning', live: true };
    return { text: waitingLine(activity ?? EMPTY_ACTIVITY), tone: 'warning', live: true };
  }
  if (status === 'active') {
    const turn = activity?.turnOpen ? activity : EMPTY_ACTIVITY;
    return { text: runningLine(turn), tone: 'muted', live: true };
  }
  return detail ? { text: detail, tone: 'muted', live: false } : null;
}
