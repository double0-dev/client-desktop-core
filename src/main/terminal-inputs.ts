/**
 * The per-pty input log behind the status bar's Inputs popover: every command
 * typed at a shell prompt, every prompt sent to an agent and every line
 * entered into any other program, in the order they happened. Pure (no
 * Electron) - terminal.ts owns one log per pty and feeds it what the stream
 * carries (a private plan).
 *
 * Sources, all in-band so the order is the stream's own:
 * - shell integration (shell-integration.ts): `ps` before every prompt,
 *   `cmd;<base64 command line>` when a command starts, `done;<exit code>`
 *   when it ends;
 * - the Claude status hooks (claude-status-hooks.ts): `prompt;<base64 of the
 *   UserPromptSubmit stdin's head>` for each prompt submitted;
 * - the 6790 `ready` / `ended` verbs: an agent run starting or ending (exit,
 *   `/clear`), after which its prompts are no longer on its screen;
 * - `addLine`: a line the renderer saw entered into anything else (a REPL, a
 *   shell without integration) - read off the screen, reported over IPC.
 *
 * Positions: main never knows where a line sits in a terminal's buffer, so
 * it tells the renderer where each entry STARTS by splicing a tag into the
 * output right where the mark was (`at;<seq>` - the xterm registers a marker
 * at its cursor when it parses the tag), and where a shell command line ends
 * (`end;<seq>`, at the `cmd` mark: the line after the command). The tags ride
 * in the replay ring, so a window adopting the pty rebuilds the markers of
 * everything still in it.
 */

import { INPUT_OSC, STATUS_OSC } from './claude-status-hooks';

export { INPUT_OSC };

/** Entries kept per pty - the oldest go first. */
export const MAX_INPUT_ENTRIES = 500;

/** Characters of an input kept for the list (a pasted file needs no more). */
export const MAX_INPUT_TEXT = 500;

export type InputKind = 'command' | 'prompt' | 'line';

export type InputEntry = {
  /** Monotonic per pty, from 1 - the key the position tags name. */
  seq: number;
  kind: InputKind;
  /** Who received it: 'shell', 'claude', or a line's foreground program. */
  program: string;
  /** The input's first MAX_INPUT_TEXT characters, trailing blank lines dropped. */
  text: string;
  /** Lines in the whole input (a lower bound when `truncated`). */
  lines: number;
  /** The text we have is only the head of the input. */
  truncated: boolean;
  /** When it was entered (ms since the epoch). */
  at: number;
  /** A shell command's exit status, once its prompt came back; null until then. */
  exitCode: number | null;
  /**
   * An agent prompt whose run has ended (the agent exited, or `/clear`
   * started a fresh conversation): the agent no longer shows it.
   */
  gone: boolean;
  /** The agent run a prompt was sent in (internal; bumps on ready/ended). */
  run: number;
  /** The renderer's reference for a line it reported (`addLine`). */
  ref: number | null;
};

/** A mark the stream parser completed (terminal-modes.ts `takeInputMarks`). */
export type InputMark = {
  /** 6791 = an input mark; 6790 = an agent status verb (ready / ended only). */
  code: typeof INPUT_OSC | typeof STATUS_OSC;
  verb: string;
  payload?: string;
  /** Index in the chunk just past the mark's terminator. */
  end: number;
};

/** The position tag the renderer turns into an xterm marker. */
export function inputTag(verb: 'at' | 'end', seq: number): string {
  return `\x1b]${INPUT_OSC};${verb};${seq}\x07`;
}

/** Base64 → text; malformed input decodes to whatever survives. */
export function decodeBase64Text(b64: string | undefined): string {
  if (!b64) return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * An input as the list keeps it: control characters out (a command line can
 * carry an escape), trailing whitespace and blank lines dropped, the head
 * kept. `lines` counts the whole input.
 */
export function normalizeInput(
  raw: string,
  truncated = false,
): { text: string; lines: number; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const trimmed = clean.replace(/\s+$/, '').replace(/^\n+/, '');
  const lines = trimmed === '' ? 0 : trimmed.split('\n').length;
  const cut = trimmed.length > MAX_INPUT_TEXT;
  return {
    text: cut ? trimmed.slice(0, MAX_INPUT_TEXT) : trimmed,
    lines,
    truncated: truncated || cut,
  };
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * The `prompt` of a UserPromptSubmit hook's stdin JSON, from the head the
 * hook forwards (it caps the payload, so the JSON may be cut anywhere - a
 * strict parse would fail on exactly the long prompts). The key is matched
 * only where a key can stand (after `{` or `,`): inside a string value every
 * quote is escaped, so a prompt that quotes `"prompt":` cannot be mistaken
 * for it. `prompt` is the last key the CLI writes (verified on 2.1.278, after
 * `prompt_id`), so the head holds its start. Null when there is no prompt.
 */
/**
 * The agent a prompt mark's payload names - `{"program":"codex",…` at its
 * head, put there by the hook script under another CLI (claude-status-hooks.ts
 * › AGENT_NAME_ENV) or by the OpenCode plugin. Null for Claude's payload,
 * which is the hook's stdin verbatim. Only a plain lowercase word is taken:
 * the Inputs list shows it as a section label.
 */
export function programFromHookJson(json: string): string | null {
  const m = /^\s*\{\s*"program"\s*:\s*"([a-z][a-z0-9_-]{0,31})"/.exec(json);
  return m ? m[1] : null;
}

export function promptFromHookJson(json: string): { text: string; truncated: boolean } | null {
  const key = /[{,]\s*"prompt"\s*:\s*"/.exec(json);
  if (!key) return null;
  let i = key.index + key[0].length;
  let out = '';
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') return { text: out, truncated: false };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const esc = json[i + 1];
    if (esc === undefined) break;
    if (esc === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += ESCAPES[esc] ?? esc;
    i += 2;
  }
  // Ran off the end of the forwarded head: the prompt goes on past it.
  return { text: out, truncated: true };
}

/**
 * Prompts the agent was handed rather than typed: a background subagent
 * reporting back re-invokes the main agent as a fresh UserPromptSubmit
 * (claude-status-hooks.ts, `finished`), with the report as its prompt.
 */
function isSyntheticPrompt(text: string): boolean {
  return /^\s*<task-notification[\s>]/.test(text);
}

export class TerminalInputLog {
  private entries: InputEntry[] = [];
  private nextSeq = 1;
  /** An `at` tag for `nextSeq` already marks the current shell prompt. */
  private promptTagged = false;
  /** The seq of the shell command still waiting for its `done`. */
  private runningCommand: number | null = null;
  /** The agent run prompts are attributed to (see `gone`). */
  private run = 0;

  /** Every entry, oldest first (copies). */
  list(): InputEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * Apply the marks one output chunk completed. Returns the chunk with the
   * position tags spliced in right after the marks they belong to, and the
   * entries that were added or changed (for the push to the renderer).
   */
  apply(chunk: string, marks: InputMark[], now: number): { data: string; changed: InputEntry[] } {
    const changed = new Map<number, InputEntry>();
    const inserts: { at: number; tag: string }[] = [];
    for (const mark of marks) {
      const tag = this.applyMark(mark, now, changed);
      if (tag) inserts.push({ at: mark.end, tag });
    }
    let data = chunk;
    // Splice from the back so earlier indices stay valid.
    for (const { at, tag } of [...inserts].sort((a, b) => b.at - a.at)) {
      const pos = Math.max(0, Math.min(at, data.length));
      data = data.slice(0, pos) + tag + data.slice(pos);
    }
    return { data, changed: [...changed.values()].map((e) => ({ ...e })) };
  }

  /**
   * A line the renderer read off the screen when Enter was pressed in a
   * program without marks of its own. Returns the new entry (null for an
   * empty line) and the tag that places it in the replay ring.
   */
  addLine(
    raw: string,
    program: string,
    now: number,
    ref: number | null,
  ): { entry: InputEntry | null; tag: string } {
    const norm = normalizeInput(raw);
    if (norm.text === '') return { entry: null, tag: '' };
    const entry = this.push({ kind: 'line', program, ...norm, at: now, ref });
    return { entry: { ...entry }, tag: inputTag('at', entry.seq) };
  }

  private applyMark(mark: InputMark, now: number, changed: Map<number, InputEntry>): string {
    if (mark.code === STATUS_OSC) {
      if (mark.verb === 'ready' || mark.verb === 'ended') this.endRun(changed);
      return '';
    }
    switch (mark.verb) {
      case 'ps':
        // A fresh prompt: whatever is typed at it becomes entry `nextSeq`,
        // and the prompt's first line is where it starts on screen. An
        // empty Enter just re-tags the same seq at the next prompt.
        this.promptTagged = true;
        return inputTag('at', this.nextSeq);
      case 'cmd': {
        const norm = normalizeInput(decodeBase64Text(mark.payload));
        if (norm.text === '') return '';
        const entry = this.push({ kind: 'command', program: 'shell', ...norm, at: now, ref: null });
        changed.set(entry.seq, entry);
        this.runningCommand = entry.seq;
        const start = this.promptTagged ? '' : inputTag('at', entry.seq);
        this.promptTagged = false;
        return start + inputTag('end', entry.seq);
      }
      case 'done': {
        const seq = this.runningCommand;
        this.runningCommand = null;
        const code = Number.parseInt(mark.payload ?? '', 10);
        const entry = seq === null ? undefined : this.entries.find((e) => e.seq === seq);
        if (entry && Number.isFinite(code)) {
          entry.exitCode = code;
          changed.set(entry.seq, entry);
        }
        return '';
      }
      case 'prompt': {
        const json = decodeBase64Text(mark.payload);
        const prompt = promptFromHookJson(json);
        if (!prompt || isSyntheticPrompt(prompt.text)) return '';
        const norm = normalizeInput(prompt.text, prompt.truncated);
        if (norm.text === '') return '';
        const program = programFromHookJson(json) ?? 'claude';
        const entry = this.push({ kind: 'prompt', program, ...norm, at: now, ref: null });
        changed.set(entry.seq, entry);
        return inputTag('at', entry.seq);
      }
      default:
        return '';
    }
  }

  /** The agent run ended or restarted: its prompts leave its screen. */
  private endRun(changed: Map<number, InputEntry>): void {
    for (const e of this.entries) {
      if (e.kind !== 'prompt' || e.run !== this.run || e.gone) continue;
      e.gone = true;
      changed.set(e.seq, e);
    }
    this.run += 1;
  }

  private push(
    fields: Pick<InputEntry, 'kind' | 'program' | 'text' | 'lines' | 'truncated' | 'at' | 'ref'>,
  ): InputEntry {
    const entry: InputEntry = {
      ...fields,
      seq: this.nextSeq++,
      exitCode: null,
      gone: false,
      run: this.run,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_INPUT_ENTRIES) this.entries.shift();
    // Anything but the command it was placed for takes the prompt's seq: the
    // next command then tags its own start instead of trusting a stale one.
    if (fields.kind !== 'command') this.promptTagged = false;
    return entry;
  }
}
