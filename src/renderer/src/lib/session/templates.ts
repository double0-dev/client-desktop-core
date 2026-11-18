import { useSyncExternalStore } from 'react';

/**
 * Session templates: named presets that seed the New Session dialog's start
 * command. Built-ins ship in code; users save their own from the dialog ("Save
 * as template"). A session does NOT reference a template after creation - it
 * stores its own resolved `startCommand` - so editing or deleting a template
 * never changes a live session.
 *
 * User templates live in a module-level, localStorage-backed store (settings-
 * like), synced across windows via the `storage` event - the same pattern as
 * `terminal-settings`.
 */
export type SessionTemplate = {
  /** Stable id: a fixed slug for built-ins, a uuid for user templates. */
  id: string;
  /** Display name; also stored on the session's `agent` field (label + tab icon). */
  name: string;
  /** Command the primary terminal auto-runs on first spawn; '' = plain shell. */
  startCommand: string;
  builtin: boolean;
};

/** Shipped presets, shown first in the dialog's chip row. */
export const BUILTIN_TEMPLATES: readonly SessionTemplate[] = [
  { id: 'terminal', name: 'Terminal', startCommand: '', builtin: true },
  { id: 'claude-code', name: 'Claude Code', startCommand: 'claude', builtin: true },
  { id: 'codex', name: 'Codex', startCommand: 'codex', builtin: true },
  { id: 'opencode', name: 'OpenCode', startCommand: 'opencode', builtin: true },
];

/** The chip selected when the dialog opens - always the plain Terminal (no agent). */
export const DEFAULT_TEMPLATE_ID = 'terminal';

/**
 * Whether a session runs in an extension's runtime rather than a terminal
 * (`agent_sessions.runtime` set): its agent shows in a view, it has no shell
 * of its own.
 */
export function runsInView(session: { runtime?: string | null }): boolean {
  return session.runtime != null;
}

/**
 * The command a session's terminals run: its start command (pre-column sessions
 * derive it from the agent label) - and nothing for a runtime session, whose
 * start command launches its runtime's agent and must never run in a shell.
 */
export function sessionTerminalCommand(session: {
  runtime?: string | null;
  startCommand?: string | null;
  agent: string;
}): string | undefined {
  if (runsInView(session)) return undefined;
  return session.startCommand ?? agentStartupCommand(session.agent);
}

/** Whether a session's `agent` label reads as Claude Code (drives the tab icon). */
export function isClaudeCodeAgent(agent: string): boolean {
  return /claude/i.test(agent);
}

/** Whether a session's `agent` label reads as OpenCode (drives the tab icon). */
export function isOpenCodeAgent(agent: string): boolean {
  return /open\s*code/i.test(agent);
}

/** Whether a session's `agent` label reads as Codex (drives the tab icon). */
export function isCodexAgent(agent: string): boolean {
  return /codex/i.test(agent);
}

/** The agent a tab or session label names, for its icon - null for a plain shell. */
export type AgentIconKind = 'claude' | 'codex' | 'opencode';

export function agentIconKind(label: string): AgentIconKind | null {
  if (isClaudeCodeAgent(label)) return 'claude';
  if (isCodexAgent(label)) return 'codex';
  if (isOpenCodeAgent(label)) return 'opencode';
  return null;
}

/** The label a session gets when its start command matches no template or agent. */
export const CUSTOM_AGENT_LABEL = 'Custom';

/** Words that run the program after them: `env -u X claude`, `exec claude`. */
const COMMAND_PREFIXES = new Set(['env', 'exec', 'command', 'nohup', 'time', 'builtin']);
/** `env` options that take the next word as their value. */
const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The simple commands of a command line, each as its words: split on `&&`,
 * `||`, `;`, `|`, `&` and newlines outside quotes, quotes removed. Enough to
 * find the program each part runs - not a shell parser.
 */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n') {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The program a simple command runs, past `VAR=value` words and `env`-style prefixes. */
function programOf(words: string[]): string | undefined {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ASSIGNMENT.test(w)) {
      i++;
    } else if (COMMAND_PREFIXES.has(w)) {
      i++;
      // `env`'s own options (`-i`, `-u NAME`); `command -v` / `time -p` too.
      while (i < words.length && words[i].startsWith('-')) {
        i += ENV_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
      }
    } else {
      return w.split('/').pop() || undefined;
    }
  }
  return undefined;
}

/**
 * The built-in agent a start command launches, read off the program each part
 * of the line runs: a wrapper named after the CLI (`claude-personal`,
 * `~/bin/claude-work --resume`), one behind environment assignments
 * (`CLAUDE_CONFIG_DIR=~/.claude-personal claude`, `env -u X claude`) or after
 * another command (`cd app && claude`) reads as "Claude Code" instead of
 * "Custom", so the session and its tabs get the agent's label and icon.
 * Undefined for a plain shell or any other command.
 */
export function builtinAgentForCommand(command: string): string | undefined {
  for (const words of simpleCommands(command)) {
    const program = programOf(words);
    if (!program) continue;
    const agent = BUILTIN_TEMPLATES.find(
      (t) => t.startCommand && program.startsWith(t.startCommand),
    );
    if (agent) return agent.name;
  }
  return undefined;
}

/**
 * The agent label a session shows (its tabs' titles and icon): the stored
 * label, except a stored "Custom" whose command launches a built-in agent - a
 * session created before the command was recognised keeps "Custom" in its row
 * until edited, and its tabs would read "Custom 2".
 */
export function sessionAgentLabel(session: {
  agent: string;
  startCommand?: string | null;
  runtime?: string | null;
}): string {
  if (session.agent !== CUSTOM_AGENT_LABEL || runsInView(session)) return session.agent;
  return builtinAgentForCommand(session.startCommand ?? '') ?? session.agent;
}

/**
 * Fallback startup command for sessions created BEFORE the `startCommand` column
 * existed (they carry only an `agent` label). New sessions store their command
 * directly, so callers use `session.startCommand ?? agentStartupCommand(agent)`.
 */
export function agentStartupCommand(agent: string): string | undefined {
  return isClaudeCodeAgent(agent) ? 'claude' : undefined;
}

// --- User templates (localStorage store, synced across windows) -------------

const USER_TEMPLATES_STORAGE_KEY = 'double0-session-templates';

/**
 * Validate a parsed JSON blob into user templates, field-by-field, so a corrupt
 * entry is dropped rather than fatal. Exported for tests; `loadUserTemplates`
 * feeds it the parsed localStorage value.
 */
export function parseUserTemplates(parsed: unknown): SessionTemplate[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((t): SessionTemplate[] => {
    if (typeof t !== 'object' || t === null) return [];
    const r = t as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) return [];
    return [
      {
        id: typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID(),
        name,
        startCommand: typeof r.startCommand === 'string' ? r.startCommand : '',
        builtin: false,
      },
    ];
  });
}

function loadUserTemplates(): SessionTemplate[] {
  try {
    const raw = window.localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
    return raw ? parseUserTemplates(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

// Built-in templates other than Terminal are deletable too - but we can't remove
// a code constant, so we remember which built-in ids the user has hidden.
const HIDDEN_BUILTINS_STORAGE_KEY = 'double0-hidden-builtin-templates';

function loadHiddenBuiltins(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_BUILTINS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

let userTemplates: SessionTemplate[] = loadUserTemplates();
let hiddenBuiltins: Set<string> = loadHiddenBuiltins();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// A template saved (or a built-in hidden) in one window - e.g. the main window's
// New Session dialog - must show up in torn-off windows too. `storage` fires in
// every OTHER same-origin window, so re-load and notify there.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === USER_TEMPLATES_STORAGE_KEY) {
      userTemplates = loadUserTemplates();
      notify();
    } else if (event.key === HIDDEN_BUILTINS_STORAGE_KEY) {
      hiddenBuiltins = loadHiddenBuiltins();
      notify();
    }
  });
}

function persist(): void {
  try {
    window.localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(userTemplates));
  } catch {
    // Storage failure - templates still apply for this session.
  }
  notify();
}

function persistHidden(): void {
  try {
    window.localStorage.setItem(HIDDEN_BUILTINS_STORAGE_KEY, JSON.stringify([...hiddenBuiltins]));
  } catch {
    // Storage failure - the hidden set still applies for this session.
  }
  notify();
}

function getHiddenBuiltins(): Set<string> {
  return hiddenBuiltins;
}

export function getUserTemplates(): SessionTemplate[] {
  return userTemplates;
}

/**
 * Save a user template. Upsert by (case-insensitive) name, so re-saving an
 * existing name updates its command instead of creating a duplicate.
 */
export function addUserTemplate(input: { name: string; startCommand: string }): void {
  const name = input.name.trim();
  if (!name) return;
  const startCommand = input.startCommand.trim();
  const existing = userTemplates.find((t) => t.name.toLowerCase() === name.toLowerCase());
  userTemplates = existing
    ? userTemplates.map((t) => (t.id === existing.id ? { ...t, name, startCommand } : t))
    : [...userTemplates, { id: crypto.randomUUID(), name, startCommand, builtin: false }];
  persist();
}

export function removeUserTemplate(id: string): void {
  userTemplates = userTemplates.filter((t) => t.id !== id);
  persist();
}

/** The one template that's always present and can't be removed (the plain shell). */
const PROTECTED_TEMPLATE_ID = 'terminal';

/** Whether a chip shows a delete affordance - everything except the base Terminal. */
export function isTemplateDeletable(template: SessionTemplate): boolean {
  return template.id !== PROTECTED_TEMPLATE_ID;
}

/**
 * Remove a template. A user template is dropped from the store; a built-in other
 * than Terminal is hidden instead (its command lives in code, so we just remember
 * not to show it). No-op for the protected Terminal.
 */
export function removeTemplate(template: SessionTemplate): void {
  if (!isTemplateDeletable(template)) return;
  if (template.builtin) {
    if (!hiddenBuiltins.has(template.id)) {
      hiddenBuiltins = new Set(hiddenBuiltins).add(template.id);
      persistHidden();
    }
  } else {
    removeUserTemplate(template.id);
  }
}

// --- Settings-transfer surface (see lib/settings-transfer.ts) ---------------

/** The template state as settings-document data (built-ins live in code). */
export type SessionTemplateSettings = {
  user: { id: string; name: string; startCommand: string }[];
  hiddenBuiltins: string[];
};

export function getSessionTemplateSettings(): SessionTemplateSettings {
  return {
    user: userTemplates.map(({ id, name, startCommand }) => ({ id, name, startCommand })),
    hiddenBuiltins: [...hiddenBuiltins],
  };
}

/**
 * Replace the template state from a settings document (JSON editor / import).
 * Sanitized like the localStorage load, so a hand-edited entry with a blank
 * name is dropped rather than fatal; unknown hidden ids are kept (they may be
 * built-ins from a newer app and round-trip harmlessly).
 */
export function importSessionTemplateSettings(doc: SessionTemplateSettings): void {
  userTemplates = parseUserTemplates(doc.user);
  hiddenBuiltins = new Set(doc.hiddenBuiltins.filter((id) => id !== PROTECTED_TEMPLATE_ID));
  persist();
  persistHidden();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Visible built-ins (minus any the user deleted) followed by their saved
 * templates, reactive to saves/deletes in any window.
 */
export function useSessionTemplates(): SessionTemplate[] {
  const user = useSyncExternalStore(subscribe, getUserTemplates);
  const hidden = useSyncExternalStore(subscribe, getHiddenBuiltins);
  return [...BUILTIN_TEMPLATES.filter((t) => !hidden.has(t.id)), ...user];
}
