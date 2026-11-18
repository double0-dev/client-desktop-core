/**
 * A tab's start command, typed into its shell once the shell is ready - the
 * same as the user typing it at the prompt.
 *
 * The command used to run inside the launch shell (`$SHELL -i -c "<cmd>\nexec
 * $SHELL"`), which only works when the user's rc leaves that shell alone. An rc
 * that hands the session to something else - Kiro / Amazon Q / Fig wrap every
 * interactive zsh in their own pty and re-run the `-c` string in a shell that
 * never read the rc (measured 2026-10-08: `zsh:1: command not found:
 * claude-personal` while the same alias typed by hand worked), a tmux
 * auto-attach, an `exec fish` - lost or broke the command. Typed at the prompt,
 * it runs wherever the user would have typed it, with every alias, function
 * and PATH entry their rc set up, in any shell.
 *
 * A zsh that read our integration needs no typing at all: its first precmd
 * finds the launch script, says so (the `launch` mark, which calls this typer
 * off) and sources it before any prompt is drawn - nothing is echoed, so a new
 * tab never shows the launch line, not even for a frame (2026-10-12). Typing
 * is for every other shell, and for a zsh whose rc dropped the integration.
 *
 * Where the line IS typed, its echo never reaches the screen (TypedEchoHold).
 *
 * "Ready" is the shell's first prompt:
 * - our zsh integration marks every prompt (`ps`, shell-integration.ts): type
 *   just after the first one, once the prompt itself has been drawn;
 * - a shell without the marks (bash, fish, integration off, Windows): type
 *   once its startup output has gone quiet;
 * - marks expected but none came (an rc that replaced the shell drops our
 *   integration): fall back to a longer quiet;
 * - output that never goes quiet: type after a cap anyway.
 * Typing early is mostly harmless (the tty buffers it), but the line would
 * be echoed twice - once by the tty while the rc still runs, once by the line
 * editor - so the wait is worth it.
 */

import { renameSync } from 'node:fs';
import { INPUT_OSC } from './claude-status-hooks';
import { AGENT_BINS_SNIPPET } from './agent-bins';

/** What a terminal types at its first prompt (HostSpawnRequest.typeWhenReady). */
export type StartupTyping = {
  /** The line, without the Enter. */
  line: string;
  /** The shell reports its prompts (`ps` marks), so readiness is exact. */
  promptMarks: boolean;
};

/** Quiet after a prompt mark: the prompt the mark precedes has been drawn. */
export const AFTER_PROMPT_QUIET_MS = 50;
/** Quiet that means "at the prompt" for a shell that does not mark it. */
export const UNMARKED_QUIET_MS = 250;
/** Quiet that means "at the prompt" when marks were expected but none came. */
export const MISSING_MARK_QUIET_MS = 1500;
/** From the first output: type no later than this, quiet or not. */
export const MAX_WAIT_MS = 6000;

export class StartupTyper {
  private done = false;
  private sawPrompt = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private cap: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly typing: StartupTyping,
    private readonly type: (text: string) => void,
  ) {}

  /** The shell wrote a chunk; `prompt` = it carried a prompt mark. */
  output(prompt: boolean): void {
    if (this.done) return;
    if (prompt) this.sawPrompt = true;
    this.cap ??= setTimeout(() => this.fire(), MAX_WAIT_MS);
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.fire(), this.quietMs());
  }

  /** The shell is gone, or ran the command itself: never type. */
  dispose(): void {
    this.done = true;
    this.clear();
  }

  private quietMs(): number {
    if (this.sawPrompt) return AFTER_PROMPT_QUIET_MS;
    return this.typing.promptMarks ? MISSING_MARK_QUIET_MS : UNMARKED_QUIET_MS;
  }

  private fire(): void {
    if (this.done) return;
    this.done = true;
    this.clear();
    this.type(`${this.typing.line}\r`);
  }

  private clear(): void {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.cap) clearTimeout(this.cap);
    this.quiet = null;
    this.cap = null;
  }
}

/**
 * Env var naming the tab's launch script. A POSIX shell gets the start command
 * through it: what the agent injection adds to the command (the hook env, the
 * shims on PATH, the conversation pin - launch-plan.ts) is long, and typed as is
 * it would fill the screen and the shell history. The script carries it; the
 * shell sees one short line.
 */
export const LAUNCH_ENV = 'DOUBLE0_LAUNCH';

/** Folder (in the agent files folder) holding the launch scripts, one per tab. */
export const LAUNCH_DIR_NAME = 'double0-launch';

/**
 * Who runs a tab's launch script is settled by a rename, which only one side
 * can win: the zsh integration moves it to `<path>.sourced` and sources that
 * (shell-integration.ts); the host moves it to `<path>.typed` and only then
 * types the line below (`claimLaunchScript`). Without it both ran: the shell
 * sourced the script from its first precmd while the line the host had typed
 * early - a slow rc - still sat in the tty's input, and the agent the script
 * started read ` . "$DOUBLE0_LAUNCH"` as its first prompt (2026-10-12).
 */
export const LAUNCH_TYPED_SUFFIX = '.typed';
export const LAUNCH_SOURCED_SUFFIX = '.sourced';

/**
 * The line typed for a launch script. The leading space keeps it out of a
 * history that ignores such lines (bash `ignorespace`, zsh
 * `HIST_IGNORE_SPACE`); our zsh integration drops it from history and from the
 * Inputs list either way.
 */
export const LAUNCH_LINE = ` . "$${LAUNCH_ENV}${LAUNCH_TYPED_SUFFIX}"`;

/**
 * Take the launch script at `path` for typing. False when it is not there to
 * take - the shell ran it itself (or it is gone): type nothing.
 */
export function claimLaunchScript(path: string): boolean {
  try {
    renameSync(path, path + LAUNCH_TYPED_SUFFIX);
    return true;
  } catch {
    return false;
  }
}

/** Every path a tab's launch script may be at. */
export function launchScriptPaths(path: string): string[] {
  return [path, path + LAUNCH_TYPED_SUFFIX, path + LAUNCH_SOURCED_SUFFIX];
}

/**
 * The launch script's first output (OSC 6791, invisible): "the start command
 * runs now". It tells the terminal's host (pty-host.ts) either that nothing
 * needs typing (the zsh integration sourced the script) or where the echo of
 * the line it typed ends.
 */
export const LAUNCH_MARK_VERB = 'launch';
export const LAUNCH_MARK = `\x1b]${INPUT_OSC};${LAUNCH_MARK_VERB}\x07`;

/**
 * The launch script for `command` (POSIX sh, sourced by the tab's shell). It
 * deletes itself (wherever the claim moved it) and forgets its own path first
 * - the shell already holds it open - so it runs once, and a later `exec zsh`
 * in the tab finds nothing.
 */
export function launchScript(command: string): string {
  const own = ['', LAUNCH_TYPED_SUFFIX, LAUNCH_SOURCED_SUFFIX]
    .map((suffix) => `"$${LAUNCH_ENV}${suffix}"`)
    .join(' ');
  const mark = String.raw`command printf '\033]${INPUT_OSC};${LAUNCH_MARK_VERB}\007'`;
  // The agent folders after the mark (it must stay the first output; the
  // snippet prints nothing): a start command finds a CLI its installer put
  // in ~/.local/bin under any shell, integration or not (agent-bins.ts).
  return `command rm -f -- ${own}; unset ${LAUNCH_ENV}; ${mark}\n${AGENT_BINS_SNIPPET}\n${command}\n`;
}

/**
 * Env var holding the start command for a Windows shell (`windowsLaunch`).
 * The command line refers to it by name, so the command itself never meets
 * node-pty's argv quoting, which backslash-escapes inner quotes - cmd.exe
 * reads `\"` literally.
 */
export const WINDOWS_LAUNCH_ENV = 'DOUBLE0_START_COMMAND';

/**
 * How a Windows shell runs the start command itself at startup, staying
 * interactive after it - null for a shell we do not know (typed, as before).
 * Typed into cmd.exe or PowerShell, the line was echoed at the prompt and
 * stayed on screen until the program covered it; TypedEchoHold needs the
 * launch script's mark, which neither shell can print, and ConPTY repaints
 * the screen in diffs, so dropping the echo from its output would desync the
 * xterm. Run from the command line, nothing is echoed. The user's profile
 * (PowerShell) and AutoRun (cmd.exe) still run first; a doskey macro does not
 * expand there.
 */
export function windowsLaunch(
  shell: string,
  command: string,
): { args: string[]; env: Record<string, string> } | null {
  const name =
    shell
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? '';
  const env = { [WINDOWS_LAUNCH_ENV]: command };
  // cmd.exe expands the variable before it parses the line, so `&`, quotes and
  // redirections in the command behave as if typed.
  if (name === 'cmd') return { args: ['/K', `%${WINDOWS_LAUNCH_ENV}%`], env };
  if (name === 'powershell' || name === 'pwsh') {
    return {
      args: ['-NoExit', '-Command', `Invoke-Expression $env:${WINDOWS_LAUNCH_ENV}`],
      env,
    };
  }
  return null;
}

/** How long the echo of a typed launch line is held back waiting for the mark. */
export const ECHO_HOLD_MS = 1500;
/** Held output past this is shown as is: that is not an echo. */
export const ECHO_HOLD_CHARS = 64 * 1024;

/** To the start of the row, erase it: the prompt the launch line was typed at. */
const ERASE_PROMPT_ROW = '\r\x1b[2K';

/**
 * Mode switches kept from a hidden echo: DEC private modes (zsh turns
 * bracketed paste and application cursor keys off at Enter) and the keypad
 * mode (`ESC =` / `ESC >`). Dropped, the terminal would stay in the line
 * editor's modes under the program.
 */
// eslint-disable-next-line no-control-regex
const MODE_SWITCHES = /\x1b\[\?[0-9;]*[hl]|\x1b[=>]/g;

/**
 * Keeps the typed launch line off the screen, in any shell. A new tab showed
 * ` . "$DOUBLE0_LAUNCH"` at its first prompt until the program covered it
 * (2026-10-12) - a line of ours, not something the user typed. Erasing it
 * from the script still let it show for a moment, and only a zsh with the
 * integration can skip the typing.
 *
 * So the host withholds the terminal's output from the moment it types the
 * line until the script's mark: everything in between is the line editor's
 * echo (twice when the tty echoed it first, with whatever a highlighter or a
 * preexec hook adds - a window title naming the line, too) and the newline
 * of Enter. It is dropped, bar the mode switches in it, and the prompt row
 * the cursor still stands on is erased; the program's output starts there. A
 * prompt of several rows keeps its upper ones.
 *
 * No mark in time (the line did not run: a shell that is not at a prompt) or
 * far too much output: everything held is shown after all - nothing is lost.
 */
export class TypedEchoHold {
  private held = '';
  private over = false;
  private timer: ReturnType<typeof setTimeout> | null;

  /** `show` gets what was held when the mark never comes. */
  constructor(show: (data: string) => void) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.over = true;
      if (this.held !== '') show(this.held);
    }, ECHO_HOLD_MS);
  }

  /** The hold has ended: output passes untouched again. */
  get done(): boolean {
    return this.over;
  }

  /** A chunk the terminal wrote while held: what of it (and before) to show now. */
  take(chunk: string): string {
    if (this.over) return chunk;
    this.held += chunk;
    const at = this.held.indexOf(LAUNCH_MARK);
    if (at === -1 && this.held.length <= ECHO_HOLD_CHARS) return '';
    this.dispose();
    if (at === -1) return this.held;
    const modes = this.held.slice(0, at).match(MODE_SWITCHES)?.join('') ?? '';
    return modes + ERASE_PROMPT_ROW + this.held.slice(at);
  }

  /** The shell is gone. */
  dispose(): void {
    this.over = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
