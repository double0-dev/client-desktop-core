/**
 * The pure half of jumping to an input (lib/terminal/inputs.ts has the xterm
 * half): which screen row shows an agent prompt, and how to scroll Claude
 * Code's own view to one when it draws full-screen.
 *
 * Claude Code in fullscreen mode (`tui: fullscreen`) lives on the alternate
 * screen: there is no scrollback for the xterm to move, the conversation
 * scrolls inside Claude. Its normal view (never the Ctrl+O detailed
 * transcript - that is a different screen) scrolls with PgUp, half its
 * message area per press, and Ctrl+End returns to the bottom. Probed on
 * 2.1.278:
 *
 * - while scrolled up, the message area's FIRST row is a pinned copy of the
 *   newest prompt above the view (`❯ …`, clickable) - it looks exactly like
 *   the prompt's own row, so it never counts as the prompt being there
 *   (except at the very top, where nothing is above: there it covers the
 *   first row's own prompt);
 * - the input box below the message area starts with a full-width `───`
 *   border and holds `❯ <draft>` - a draft never counts either;
 * - the view never jumps on its own while scrolled up (auto-follow pauses);
 * - a click on the pinned row scrolls its prompt to the top of the view - one
 *   frame, however long the answer under it. Right after, the top row is the
 *   prompt's own and the pin can stay away for a frame or two;
 * - two clicks within 500 ms and one cell of each other are a double-click:
 *   Claude selects the word under them and copies it to the clipboard;
 * - the pin is worked out from the top of Claude's render window, not the
 *   view: while one message taller than the view fills it (a 140-row answer)
 *   it can name an OLDER prompt than the newest one above.
 *
 * So the walk starts at the bottom and presses PgUp one step at a time,
 * reading the screen after each: every line enters at the top of the view, so
 * the prompt shows up in the upper half, where it is left. Later prompts with
 * the same first line (a second "continue") are counted off on the way:
 * matching consecutive screens tells how far each step shifted, hence which
 * rows are new.
 *
 * A long answer is what made a jump take seconds, so the walk clicks the pin
 * instead of paging through one - only a pin it can trust: row 0 held still
 * while the content moved under it (a real row moves with it), and it names
 * the prompt the Inputs list says comes next, every prompt uncovered so far
 * having matched the list in order (anything else - a wrong pin, a prompt the
 * list never heard of - and it pages the rest of the way). Clicks alternate
 * between two columns so they never make a double-click. Only harmless input
 * is sent - PgUp, Ctrl+End, a click on the pin, and `q` to leave a transcript
 * the user had open - nothing that could type into the prompt or answer a
 * dialog.
 */

/**
 * Whether the walk below can read and move the full-screen view of the
 * program a prompt was sent to (`InputEntry.program`): Claude Code's only -
 * every rule here was probed on its renderer. OpenCode's TUI (1.17.20,
 * probed 2026-10-03) takes the same keys otherwise: Ctrl+End draws nothing,
 * PgUp moves its message list a couple of rows, and a click on row 0 - the
 * pin's row here - opens its "Message Actions" dialog (Revert, Fork…) over
 * the conversation; it echoes a prompt as `┃  <text>` rows, with no pinned
 * copy and no `───` input border to tell the message area by. Codex is
 * unverified (no CLI on the dev Mac). So a prompt sent to any other program
 * is listed, called on screen while its first line shows (`promptOnScreen`)
 * and never walked to - no key, no click, reaches such a program.
 */
export function canWalkAgentView(program: string): boolean {
  return program === 'claude';
}

/**
 * Whether a prompt shows on the screen of a full-screen program whose layout
 * the walk does not know: any row carrying the prompt's first line, past
 * whatever bar or marker the program draws before it (OpenCode's `┃  `). A
 * draft in such a program's input box matches too - accepted, since nothing
 * is sent either way.
 */
export function promptOnScreen(rows: string[], needle: string): boolean {
  if (!needle) return false;
  return rows.some((row) => row.includes(needle));
}

/** Claude Code's transcript-mode footer (2.1.278). */
export const TRANSCRIPT_FOOTER = 'Showing detailed transcript';

/** The overlay Claude Code shows while its view is scrolled up (2.1.278). */
export const SCROLLED_UP_HINT = 'Jump to bottom';

/** The same overlay once output arrived below the view: `3 new messages ↓`. */
const NEW_MESSAGES_HINT = /\b\d+ new messages?(?: \(|: | ↓)/;

export const KEY_PAGE_UP = '\x1b[5~';
export const KEY_CTRL_END = '\x1b[1;5F';
export const KEY_PAGE_DOWN = '\x1b[6~';
/** Claude Code's view: to the top of what it still holds (probed on 2.1.289). */
export const KEY_CTRL_HOME = '\x1b[1;5H';

/** Characters of a prompt's first line matched against the screen. */
const NEEDLE_CHARS = 40;

/** Most PgUp steps one jump takes before it gives up. */
const MAX_STEPS = 200;

/**
 * Where the pin is clicked (0-based), taking turns: its text, clear of the
 * `❯`, and never within a cell of the last click (a double-click).
 */
const PIN_CLICK_COLS = [3, 7] as const;

/** The part of a prompt that identifies it on screen: its first line's head. */
export function promptNeedle(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.trim().slice(0, NEEDLE_CHARS).trimEnd();
}

/** Whether a row is Claude Code's echo of a prompt starting with `needle`. */
export function isPromptRow(row: string, needle: string): boolean {
  const r = row.trimStart();
  return r.startsWith(`❯ ${needle}`) || r.startsWith(`> ${needle}`);
}

/**
 * The row (index into `rows`) where Claude Code echoed a prompt starting
 * with `needle` - `❯ ` in both renderers (`> ` on older CLIs) - searching
 * from the bottom and skipping `skip` matches (later prompts with the same
 * first line). -1 when it is not there.
 */
export function findPromptRow(rows: string[], needle: string, skip = 0): number {
  if (!needle) return -1;
  let left = skip;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isPromptRow(rows[i], needle)) continue;
    if (left === 0) return i;
    left -= 1;
  }
  return -1;
}

/**
 * The row where Claude Code echoed a prompt its hook marked at row `anchor`:
 * the nearest row at or above it that starts with `❯ <needle>`, looking at
 * most `span` rows up (`row` reads one row, '' past the buffer). -1 when none
 * does.
 *
 * The inline renderer draws the echo before the hook's mark arrives, so the
 * mark lands where the cursor waits then - in the input box, below the echo,
 * the spinner and whatever else the live area showed - on rows the answer
 * later fills (probed on 2.1.278). The nearest match is the prompt's own echo:
 * an earlier prompt with the same first line sits above it.
 */
export function promptRowAbove(
  row: (i: number) => string,
  anchor: number,
  needle: string,
  span: number,
): number {
  if (!needle) return -1;
  for (let i = anchor; i >= Math.max(0, anchor - span); i--) {
    if (isPromptRow(row(i), needle)) return i;
  }
  return -1;
}

/**
 * How many rows Claude Code's echo of a prompt takes from its first row
 * `start`: every row written into, since the echo is a full-width bar (a
 * blank line of the prompt paints its spaces too) and the row under it is
 * left empty - at least the prompt's `lines`, at most `max`. `row` reads one
 * row with trailing unwritten cells trimmed.
 */
export function promptEchoHeight(
  row: (i: number) => string,
  start: number,
  lines: number,
  max: number,
): number {
  let n = Math.max(1, lines);
  while (n < max && row(start + n) !== '') n += 1;
  return Math.min(n, max);
}

/**
 * The rows of Claude Code's message area on a full-screen frame: everything
 * above the input box's top border, minus the pinned prompt row while the
 * view is scrolled up.
 */
export function messageArea(rows: string[]): { from: number; to: number } {
  const border = rows.findIndex((r) => /^\s*─{20,}/.test(r));
  const to = border === -1 ? rows.length : border;
  const scrolled = rows
    .slice(0, to)
    .some((r) => r.includes(SCROLLED_UP_HINT) || NEW_MESSAGES_HINT.test(r));
  return { from: scrolled ? 1 : 0, to };
}

/** Whether a prompt shows in Claude Code's message area (not its pinned row or input). */
export function promptOnClaudeScreen(rows: string[], needle: string): boolean {
  const { from, to } = messageArea(rows);
  return findPromptRow(rows.slice(from, to), needle) !== -1;
}

/**
 * How many rows the content moved down between two frames of the message
 * area: the shift under which most non-blank rows line up. 0 when nothing
 * lines up (the view did not move, or changed under us).
 */
export function screenShift(prev: string[], next: string[]): number {
  let best = 0;
  let bestHits = 0;
  for (let d = 1; d < next.length; d++) {
    let hits = 0;
    for (let i = 0; i + d < next.length && i < prev.length; i++) {
      if (prev[i].trim() !== '' && prev[i] === next[i + d]) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = d;
    }
  }
  return bestHits >= 2 ? best : 0;
}

/** What the scroll walk needs from a live terminal. */
export type ClaudeViewIo = {
  /** The visible rows, top to bottom. */
  screen: () => string[];
  /** Type into the program. */
  write: (keys: string) => void;
  /** Click a cell (0-based) - absent while the program takes no mouse clicks. */
  click?: (row: number, col: number) => void;
  /** Resolves once the program has answered the last keys (or gave up). */
  settle: () => Promise<void>;
  /** A newer jump took over - stop sending keys. */
  cancelled?: () => boolean;
};

/**
 * Scroll a full-screen Claude Code's view until the prompt `needle` shows.
 * `later` are the needles of the prompts sent after it in this run, newest
 * first: the ones sharing its first line are counted off on the way, and the
 * whole list says which prompt a trustworthy pin names next. True once it
 * shows; on a miss the view goes back to the bottom.
 */
export async function scrollClaudeTo(
  io: ClaudeViewIo,
  needle: string,
  later: string[],
): Promise<boolean> {
  if (!needle) return false;
  const laterTwins = later.filter((n) => n === needle).length;
  const stop = (): boolean => io.cancelled?.() === true;
  const inTranscript = (): boolean =>
    io
      .screen()
      .slice(-3)
      .some((row) => row.includes(TRANSCRIPT_FOOTER));
  /** Send, wait for the answer, read it - null once a newer jump took over. */
  const step = async (send: () => void): Promise<string[] | null> => {
    send();
    await io.settle();
    return stop() ? null : io.screen();
  };

  // A transcript the user left open would take the keys: close it first.
  if (inTranscript()) {
    io.write('q');
    await io.settle();
    if (stop() || inTranscript()) return false;
  }
  let rows = io.screen();
  // Already at the bottom, Ctrl+End draws nothing: waiting for its frame was
  // most of a short jump.
  if (messageArea(rows).from === 1) {
    const bottom = await step(() => io.write(KEY_CTRL_END));
    if (!bottom) return false;
    rows = bottom;
  }

  let seen = 0;
  /**
   * The later prompts not uncovered yet, newest first - null once a prompt
   * row showed up out of the list's order: the pin can no longer be checked.
   */
  let ahead: string[] | null = [...later];
  /** The prompt a trustworthy pin names next. */
  const nextUp = (): string | null => (ahead === null ? null : (ahead[0] ?? needle));
  /** Count the prompts in rows [from, to) bottom-up; true when the target is among them. */
  const take = (frame: string[], from: number, to: number): boolean => {
    for (let i = to - 1; i >= from; i--) {
      const row = frame[i];
      if (ahead !== null && row.startsWith('❯ ')) {
        if (ahead.length > 0 && isPromptRow(row, ahead[0])) ahead.shift();
        else if (!(ahead.length === 0 && isPromptRow(row, needle))) ahead = null;
      }
      if (!isPromptRow(row, needle)) continue;
      if (seen === laterTwins) return true;
      seen += 1;
    }
    return false;
  };

  let area = messageArea(rows);
  // The bottom view has no pinned row: all of it is new.
  if (take(rows, 0, area.to)) return true;

  let clicks = io.click !== undefined;
  let clickN = 0;
  /** The frame on screen came from a click: its first row is the clicked prompt's own. */
  let clicked = false;
  /** Row 0 of the frame on screen when a PgUp drew it while scrolled up. */
  let pin: string | null = null;

  for (let n = 0; n < MAX_STEPS; n++) {
    const next = await step(() => io.write(KEY_PAGE_UP));
    if (!next) return false;
    const nextArea = messageArea(next);
    const prevBody = rows.slice(area.from, area.to);
    const nextBody = next.slice(nextArea.from, nextArea.to);
    if (prevBody.join('\n') === nextBody.join('\n')) {
      // The top - nothing moved. Nothing is above the view any more, so the
      // pinned row can only be the first row's own prompt, covered by it
      // (a clicked prompt there was counted when it was clicked).
      if (!clicked && area.from === 1 && isPromptRow(rows[0], needle) && seen === laterTwins) {
        return true;
      }
      break;
    }
    // New content entered at the top: the rows the shift uncovered. Frames
    // that do not line up (output landed mid-walk) count as all new. Under a
    // click's frame the old first row is the clicked prompt, counted already.
    const shift = screenShift(prevBody, nextBody) || nextBody.length;
    const newTo = Math.min(nextArea.to, nextArea.from + shift - (clicked ? 1 : 0));
    if (take(next, nextArea.from, newTo)) return true;
    const nextPin = nextArea.from === 1 ? next[0] : null;
    const expected = nextUp();
    // A pin that held still while the content moved, naming the prompt the
    // list says comes next: jump to it rather than page through its answer.
    if (
      clicks &&
      !clicked &&
      expected !== null &&
      nextPin !== null &&
      nextPin === pin &&
      isPromptRow(nextPin, expected)
    ) {
      const col = PIN_CLICK_COLS[clickN++ % PIN_CLICK_COLS.length];
      const landed = await step(() => io.click?.(0, col));
      if (!landed) return false;
      const half = Math.max(2, Math.floor(nextArea.to / 2));
      if (landed.slice(1, half).join('\n') === next.slice(1, half).join('\n')) {
        // The view did not move (mouse clicks off): walk the rest.
        clicks = false;
      } else {
        // The pinned prompt is on top now: counted as it passes.
        if (take([nextPin], 0, 1)) return true;
        rows = landed;
        area = messageArea(landed);
        clicked = true;
        pin = null;
        continue;
      }
    }
    rows = next;
    area = nextArea;
    clicked = false;
    pin = nextPin;
  }
  if (!stop()) io.write(KEY_CTRL_END);
  return false;
}

/**
 * Scroll a full-screen Claude Code's view down from its TOP until the prompt
 * `needle` shows - the short way to an old prompt in a long conversation:
 * Ctrl+Home lands on the oldest message the view still holds (a long
 * session's view does not reach back to its first prompt - 2.1.289 held from
 * the 25th of 40 prompts on), then PgDn walks down. Only for a needle no
 * other prompt shares: the view's top is not the conversation's start, so
 * twins cannot be counted from there. True once it shows; on a miss the
 * view goes back to the bottom.
 */
export async function scrollClaudeFromTop(io: ClaudeViewIo, needle: string): Promise<boolean> {
  if (!needle) return false;
  const stop = (): boolean => io.cancelled?.() === true;
  const inTranscript = (): boolean =>
    io
      .screen()
      .slice(-3)
      .some((row) => row.includes(TRANSCRIPT_FOOTER));
  const step = async (keys: string): Promise<string[] | null> => {
    io.write(keys);
    await io.settle();
    return stop() ? null : io.screen();
  };
  if (inTranscript()) {
    io.write('q');
    await io.settle();
    if (stop() || inTranscript()) return false;
  }
  const shows = (rows: string[]): boolean => {
    const { from, to } = messageArea(rows);
    return findPromptRow(rows.slice(from, to), needle) !== -1;
  };
  let rows = await step(KEY_CTRL_HOME);
  if (!rows) return false;
  if (shows(rows)) return true;
  for (let n = 0; n < MAX_STEPS; n++) {
    const next = await step(KEY_PAGE_DOWN);
    if (!next) return false;
    if (shows(next)) return true;
    const a = messageArea(rows);
    const b = messageArea(next);
    // The bottom - nothing moved.
    if (rows.slice(a.from, a.to).join('\n') === next.slice(b.from, b.to).join('\n')) break;
    rows = next;
  }
  if (!stop()) io.write(KEY_CTRL_END);
  return false;
}
