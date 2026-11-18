import type { InputEntry } from '@renderer/lib/terminal/inputs';

/**
 * What the Inputs popover shows (design `Popover/Inputs`, `InputRow`): the
 * entries of the focused tab grouped into one section per program run, in
 * the terminal's own order - a shell's commands, then the prompts of the
 * agent started from it, then the shell again. Pure.
 */

export type InputSectionKind = 'agent' | 'shell' | 'program';

export type InputSection = {
  /** Stable across renders: the first entry's seq. */
  key: number;
  kind: InputSectionKind;
  /** Section label (shown upper-case): the agent's name (`Claude Code`), `Shell`, or the program. */
  label: string;
  /** `3 prompts`, `1 command`, `2 lines`. */
  count: string;
  entries: InputEntry[];
};

/** The agents' display names, by the program a prompt entry is filed under (main's terminal-inputs.ts). */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function kindOf(e: InputEntry): InputSectionKind {
  if (e.kind === 'prompt') return 'agent';
  if (e.kind === 'command') return 'shell';
  return 'program';
}

function labelOf(e: InputEntry): string {
  if (e.kind === 'prompt') return AGENT_LABELS[e.program] ?? e.program;
  if (e.kind === 'command') return 'Shell';
  return e.program;
}

function countOf(kind: InputSectionKind, n: number): string {
  const noun = kind === 'agent' ? 'prompt' : kind === 'shell' ? 'command' : 'line';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Consecutive entries of the same program form one section. */
export function groupInputSections(entries: InputEntry[]): InputSection[] {
  const out: InputSection[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last.kind === kindOf(e) && last.label === labelOf(e)) {
      last.entries.push(e);
      continue;
    }
    out.push({ key: e.seq, kind: kindOf(e), label: labelOf(e), count: '', entries: [e] });
  }
  for (const s of out) s.count = countOf(s.kind, s.entries.length);
  return out;
}

/** Entries whose text contains the query (case-insensitive); all for an empty one. */
export function filterInputs(entries: InputEntry[], query: string): InputEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.text.toLowerCase().includes(q));
}

/** The line a row shows: the input's first non-empty line. */
export function inputFirstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? '';
}

/** `+2 lines` for a multi-line input (`+2 lines…` when the head was all we got). */
export function extraLinesLabel(e: InputEntry): string | null {
  const more = e.lines - 1;
  if (more <= 0) return e.truncated ? '+more' : null;
  return `+${more} line${more === 1 ? '' : 's'}${e.truncated ? '…' : ''}`;
}

/** The exit status a row calls out - only a failure; success is the norm. */
export function exitLabel(e: InputEntry): string | null {
  return e.kind === 'command' && e.exitCode !== null && e.exitCode !== 0
    ? `exit ${e.exitCode}`
    : null;
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** `10:41` today, `Sep 20` before - terminals can outlive a day. */
export function formatInputTime(at: number, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? TIME.format(d) : DAY.format(d);
}

/** `6 inputs` / `1 input` - the status bar item's label. */
export function inputsCountLabel(n: number): string {
  return `${n} input${n === 1 ? '' : 's'}`;
}
