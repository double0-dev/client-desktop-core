import { describe, expect, it } from 'vitest';
import {
  KEY_CTRL_END,
  KEY_CTRL_HOME,
  KEY_PAGE_DOWN,
  KEY_PAGE_UP,
  SCROLLED_UP_HINT,
  TRANSCRIPT_FOOTER,
  canWalkAgentView,
  findPromptRow,
  messageArea,
  promptEchoHeight,
  promptNeedle,
  promptOnClaudeScreen,
  promptOnScreen,
  promptRowAbove,
  screenShift,
  scrollClaudeFromTop,
  scrollClaudeTo,
  type ClaudeViewIo,
} from '@renderer/lib/terminal/input-jump';

describe('canWalkAgentView', () => {
  it("walks Claude Code's view only - the keys were probed there and nowhere else", () => {
    expect(canWalkAgentView('claude')).toBe(true);
    // OpenCode 1.17.20: a click on its top row opens the Message Actions
    // dialog, PgUp barely moves it. Codex: no CLI to probe on the dev Mac.
    expect(canWalkAgentView('opencode')).toBe(false);
    expect(canWalkAgentView('codex')).toBe(false);
  });
});

describe('promptOnScreen', () => {
  it("finds a prompt's first line behind whatever the program draws before it", () => {
    // OpenCode's echo: a bar, two spaces, the text; the answer indented under it.
    const rows = ['', '  ┃  fix the flaky test', '  ┃', '     $ ls -la', ''];
    expect(promptOnScreen(rows, 'fix the flaky test')).toBe(true);
    expect(promptOnScreen(rows, 'add a test')).toBe(false);
    expect(promptOnScreen(rows, '')).toBe(false);
  });
});

describe('promptNeedle', () => {
  it("is the head of the prompt's first non-empty line", () => {
    expect(promptNeedle('\n  fix the token refresh flakiness  \nand more')).toBe(
      'fix the token refresh flakiness',
    );
    expect(promptNeedle('x'.repeat(100))).toHaveLength(40);
    expect(promptNeedle('   \n  ')).toBe('');
  });
});

describe('findPromptRow', () => {
  const rows = [
    '❯ continue',
    '⏺ Reading the test',
    '  continue reading the log',
    '> continue',
    '⏺ Done',
    '❯ fix the flaky test',
  ];

  it('finds the echoed prompt from the bottom, in either prompt style', () => {
    expect(findPromptRow(rows, 'fix the flaky test')).toBe(5);
    expect(findPromptRow(rows, 'continue')).toBe(3);
  });

  it('skips later prompts with the same first line', () => {
    // Typed "continue" twice: the earlier entry is the second match from the bottom.
    expect(findPromptRow(rows, 'continue', 1)).toBe(0);
    expect(findPromptRow(rows, 'continue', 2)).toBe(-1);
  });

  it('never matches the text outside a prompt row, or an empty needle', () => {
    expect(findPromptRow(rows, 'continue reading')).toBe(-1);
    expect(findPromptRow(rows, '')).toBe(-1);
  });
});

describe('promptRowAbove', () => {
  // Claude Code's inline renderer (probed on 2.1.278): each prompt's hook
  // marks the input box a few rows below its echo, rows the answer then fills.
  const rows = [
    '❯ continue', // echo of the first "continue"
    '',
    '⏺ Reading the test',
    '  continue reading the log', // the first one's mark landed here
    '❯ continue', // echo of the second
    '',
    '⏺ Done',
    '', // the second one's mark
  ];
  const row = (i: number): string => rows[i] ?? '';

  it('finds the echo above the row the hook marked, the nearest one first', () => {
    // Two prompts with the same first line: each mark finds its own echo.
    expect(promptRowAbove(row, 7, 'continue', 20)).toBe(4);
    expect(promptRowAbove(row, 3, 'continue', 20)).toBe(0);
  });

  it('takes the marked row itself - a mark that arrived before the echo was drawn', () => {
    expect(promptRowAbove(row, 4, 'continue', 0)).toBe(4);
  });

  it('looks no further up than the span, and never for an empty needle', () => {
    expect(promptRowAbove(row, 7, 'continue', 2)).toBe(-1);
    expect(promptRowAbove(row, 7, 'Reading the test', 20)).toBe(-1);
    expect(promptRowAbove(row, 7, '', 20)).toBe(-1);
  });
});

describe('promptEchoHeight', () => {
  /** A row of the echo: painted the full width, as Claude draws it. */
  const bar = (text: string): string => text.padEnd(40);

  it('covers every row the echo painted - wrapped lines and blank ones', () => {
    // "fix the login redirect loop that happens after a token refresh\n\nand add
    // a test": three lines, the first wrapped onto a second row.
    const rows = [
      bar('❯ fix the login redirect loop that'),
      bar('  happens after a token refresh'),
      bar(''),
      bar('  and add a test'),
      '',
      '⏺ Fixed',
    ];
    expect(promptEchoHeight((i) => rows[i] ?? '', 0, 3, 8)).toBe(4);
  });

  it('is at least the prompt’s lines, and at most the cap', () => {
    // An echo without the painted bar leaves a blank line of the prompt empty.
    const plain = ['❯ fix it', '', '  and test it', '', '⏺ Fixed'];
    expect(promptEchoHeight((i) => plain[i] ?? '', 0, 3, 8)).toBe(3);
    const long = Array.from({ length: 20 }, () => bar('  more'));
    expect(promptEchoHeight((i) => long[i] ?? '', 0, 1, 8)).toBe(8);
  });
});

const BORDER = '─'.repeat(60);

/**
 * Claude Code's full-screen normal view as probed on 2.1.278: a message area
 * of `height` rows over the input box; PgUp scrolls half the area, Ctrl+End
 * back to the bottom; while scrolled up the first row is pinned to the newest
 * prompt at or above it and the last carries the jump-to-bottom hint. `q`
 * closes the Ctrl+O transcript.
 *
 * A click on the pin scrolls its prompt to the top; that frame shows the
 * prompt's own row, and the pin stays away for `pinLag` more frames (0 or 1
 * when probed - it depends on how many renders the scroll took). A click
 * within a cell of the last one is a double-click, and a click anywhere but a
 * showing pin is Claude selecting text: `copied` counts both, and a jump must
 * never cause one. `clicks: false` is a program ignoring the mouse.
 * `tallAnswerPin` is Claude's pin while one answer fills the whole view: it
 * names the prompt BEFORE the right one.
 */
function fakeClaudeView(
  lines: string[],
  opts: {
    height?: number;
    draft?: string;
    transcript?: boolean;
    clicks?: boolean;
    pinLag?: number;
    tallAnswerPin?: boolean;
  } = {},
) {
  const height = opts.height ?? 12;
  const maxOffset = Math.max(0, lines.length - height);
  let offset = 0;
  let transcript = opts.transcript ?? false;
  /** Frames still to draw without the pin (the current one included). */
  let pinAway = 0;
  const written: string[] = [];
  const clicked: [number, number][] = [];
  let copied = 0;
  const top = (): number => Math.max(0, lines.length - offset - height);
  const promptAtOrAbove = (from: number): number => {
    for (let i = from; i >= 0; i--) if (lines[i].startsWith('❯ ')) return i;
    return -1;
  };
  /** No prompt and no turn footer anywhere in the view. */
  const insideOneAnswer = (): boolean =>
    lines
      .slice(top(), lines.length - offset)
      .every((l) => !l.startsWith('❯ ') && !l.startsWith('✻ '));
  /** The newest prompt at or above the view's first row - the pin's line. */
  const pinLine = (): number => {
    const line = promptAtOrAbove(top());
    return opts.tallAnswerPin && line > 0 && insideOneAnswer() ? promptAtOrAbove(line - 1) : line;
  };
  const body = (): string[] => {
    const end = lines.length - offset;
    const rows = lines.slice(top(), end);
    while (rows.length < height) rows.unshift('');
    if (offset > 0) {
      if (pinAway === 0) rows[0] = pinLine() === -1 ? '' : lines[pinLine()];
      rows[height - 1] = `${rows[height - 1]}   ${SCROLLED_UP_HINT}: fn+↓ to scroll`;
    }
    return rows;
  };
  const io: ClaudeViewIo = {
    screen: () =>
      transcript
        ? [...lines.slice(-height), BORDER, `  ${TRANSCRIPT_FOOTER} · ctrl+o to toggle`]
        : [...body(), BORDER, `❯ ${opts.draft ?? ''}`, BORDER, '  [Haiku 4.5] 📁 acme'],
    write: (keys) => {
      written.push(keys);
      pinAway = Math.max(0, pinAway - 1);
      if (keys === 'q') transcript = false;
      else if (keys === KEY_CTRL_END) offset = 0;
      else if (keys === KEY_CTRL_HOME) offset = maxOffset;
      else if (keys === KEY_PAGE_DOWN) offset = Math.max(0, offset - Math.floor(height / 2));
      else if (keys === KEY_PAGE_UP) offset = Math.min(maxOffset, offset + Math.floor(height / 2));
    },
    click: (row, col) => {
      const last = clicked.at(-1);
      clicked.push([row, col]);
      if (opts.clicks === false) return;
      const pin = pinLine();
      const double = last && Math.abs(last[0] - row) <= 1 && Math.abs(last[1] - col) <= 1;
      if (double || row !== 0 || offset === 0 || pinAway > 0 || pin === -1) {
        copied += 1;
        return;
      }
      offset = Math.max(0, lines.length - pin - height);
      pinAway = 1 + (opts.pinLag ?? 1);
    },
    settle: async () => {},
  };
  return { io, written, clicked, copied: () => copied, body };
}

/** A conversation under Claude's banner: each prompt, a blank, a numbered answer, the turn's footer. */
function turns(prompts: string[], answerLines = 10, banner = true): string[] {
  const head = banner ? ['▐▛███▛█   Claude Code v2.1.278', '▝▜██████▀  Haiku 4.5', ''] : [];
  return head.concat(
    prompts.flatMap((p, t) => [
      `❯ ${p}`,
      '',
      ...Array.from(
        { length: answerLines },
        (_, i) => `${i === 0 ? '⏺' : ' '} turn ${t} line ${i}`,
      ),
      '',
      '✻ Brewed for 1s',
      '',
    ]),
  );
}

describe('messageArea', () => {
  it('stops above the input box and skips the pinned row while scrolled up', () => {
    const bottom = ['⏺ 1', '  2', BORDER, '❯ draft', BORDER];
    expect(messageArea(bottom)).toEqual({ from: 0, to: 2 });
    const scrolled = ['❯ alpha', '  2', `  3   ${SCROLLED_UP_HINT}`, BORDER, '❯ ', BORDER];
    expect(messageArea(scrolled)).toEqual({ from: 1, to: 3 });
  });

  it('reads the hint that counts new output as scrolled up too', () => {
    // While the agent writes below a scrolled view the hint reads "N new messages".
    const pill = ['❯ alpha', '  2', '  3   3 new messages (click) ↓', BORDER, '❯ ', BORDER];
    expect(messageArea(pill)).toEqual({ from: 1, to: 3 });
    // The words in an answer are not the hint.
    const answer = ['⏺ I queued 3 new messages for review.', '  2', BORDER, '❯ ', BORDER];
    expect(messageArea(answer)).toEqual({ from: 0, to: 2 });
  });

  it('calls a prompt on screen only in the message area', () => {
    const scrolled = ['❯ alpha', '  2', `  3   ${SCROLLED_UP_HINT}`, BORDER, '❯ bravo', BORDER];
    // Pinned (above the view) and drafted prompts are not on screen.
    expect(promptOnClaudeScreen(scrolled, 'alpha')).toBe(false);
    expect(promptOnClaudeScreen(scrolled, 'bravo')).toBe(false);
    expect(promptOnClaudeScreen(['❯ alpha', '  2', BORDER], 'alpha')).toBe(true);
  });
});

describe('screenShift', () => {
  it('finds how far the content moved down', () => {
    const prev = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(screenShift(prev, ['x', 'y', 'a', 'b', 'c', 'd'])).toBe(2);
  });

  it('is 0 when nothing lines up', () => {
    expect(screenShift(['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(0);
  });
});

/** The prompts sent after `prompts[i]`, newest first - what the Inputs list says comes next. */
const after = (prompts: string[], i: number): string[] => prompts.slice(i + 1).reverse();

describe('scrollClaudeTo', () => {
  const PROMPTS = ['alpha - list 1 to 10', 'bravo - list 1 to 10', 'charlie - list 1 to 10'];

  it('leaves a prompt that already shows at the bottom where it is', async () => {
    const claude = fakeClaudeView(turns(['alpha', 'bravo'], 2), { height: 12 });
    expect(await scrollClaudeTo(claude.io, 'bravo', [])).toBe(true);
    // Not even Ctrl+End: at the bottom it draws nothing, and the jump used to
    // wait out the whole settle cap for the frame that never came.
    expect(claude.written).toEqual([]);
  });

  it('returns to the bottom first when the view was left scrolled up', async () => {
    const claude = fakeClaudeView(turns(['alpha', 'bravo'], 2), { height: 12 });
    claude.io.write(KEY_PAGE_UP);
    claude.written.length = 0;
    expect(await scrollClaudeTo(claude.io, 'bravo', [])).toBe(true);
    expect(claude.written).toEqual([KEY_CTRL_END]);
  });

  it('pages up until the prompt enters the view, in its upper half, never opening the transcript', async () => {
    const claude = fakeClaudeView(turns(PROMPTS));
    expect(await scrollClaudeTo(claude.io, PROMPTS[0], after(PROMPTS, 0))).toBe(true);
    expect(claude.written.every((k) => k === KEY_CTRL_END || k === KEY_PAGE_UP)).toBe(true);
    expect(claude.written).not.toContain('\x0f');
    const body = claude.body();
    // On a real row (not the pinned one), with its answer under it.
    const row = findPromptRow(body.slice(1), 'alpha - list 1 to 10') + 1;
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThanOrEqual(6);
    expect(body.slice(row).join('\n')).toContain('turn 0 line 0');
  });

  it('counts later prompts with the same first line off on the way up', async () => {
    // alpha, bravo, alpha, charlie: the list's first alpha has one later twin.
    const prompts = [
      'alpha - list 1 to 10',
      'bravo - list 1 to 10',
      'alpha - list 1 to 10',
      'charlie',
    ];
    const claude = fakeClaudeView(turns(prompts));
    expect(await scrollClaudeTo(claude.io, prompts[0], after(prompts, 0))).toBe(true);
    // The FIRST alpha shows: its answer is turn 0's.
    const body = claude.body();
    const row = findPromptRow(body.slice(1), 'alpha - list 1 to 10') + 1;
    expect(body[row + 2]).toContain('turn 0 line 0');
  });

  it('counts a twin once while it stays on screen across several pages', async () => {
    // A tall view keeps the later "continue" in sight for two PgUps while the
    // earlier one is still far above: counting it again on the second page
    // would stop there, with the wanted prompt nowhere on screen.
    const prompts = ['continue', 'bravo - list 1 to 20', 'continue', 'charlie - list 1 to 20'];
    const claude = fakeClaudeView(turns(prompts, 20), { height: 30 });
    expect(await scrollClaudeTo(claude.io, 'continue', after(prompts, 0))).toBe(true);
    expect(claude.body().join('\n')).toContain('turn 0 line 0');
  });

  it('never takes the pinned row or a draft for the prompt', async () => {
    // Both show "alpha" long before its own row scrolls into view.
    const claude = fakeClaudeView(turns(PROMPTS), { draft: 'alpha - list 1 to 10' });
    await scrollClaudeTo(claude.io, PROMPTS[0], after(PROMPTS, 0));
    expect(claude.written.filter((k) => k === KEY_PAGE_UP).length).toBeGreaterThan(1);
    expect(findPromptRow(claude.body().slice(1), 'alpha - list 1 to 10')).not.toBe(-1);
  });

  it('finds the first prompt at the very top, where only the pinned row shows it', async () => {
    // A conversation with nothing above its first prompt (resumed, compacted):
    // at the top the pinned row covers that prompt's own row.
    const claude = fakeClaudeView(turns(PROMPTS, 10, false));
    expect(await scrollClaudeTo(claude.io, PROMPTS[0], after(PROMPTS, 0))).toBe(true);
    expect(claude.written.at(-1)).toBe(KEY_PAGE_UP);
  });

  it('closes a transcript the user left open before scrolling', async () => {
    const claude = fakeClaudeView(turns(PROMPTS), { transcript: true });
    expect(await scrollClaudeTo(claude.io, PROMPTS[1], after(PROMPTS, 1))).toBe(true);
    expect(claude.written[0]).toBe('q');
  });

  it('gives up at the top and returns to the bottom', async () => {
    const claude = fakeClaudeView(turns(PROMPTS));
    expect(await scrollClaudeTo(claude.io, 'never sent', [])).toBe(false);
    expect(claude.written.at(-1)).toBe(KEY_CTRL_END);
    expect(claude.written.length).toBeLessThan(20);
  });

  it('stops sending keys once a newer jump takes over', async () => {
    const claude = fakeClaudeView(turns(PROMPTS));
    let cancelled = false;
    const io = {
      ...claude.io,
      settle: async () => void (cancelled = true),
      cancelled: () => cancelled,
    };
    expect(await scrollClaudeTo(io, PROMPTS[0], after(PROMPTS, 0))).toBe(false);
    expect(claude.written).toEqual([KEY_PAGE_UP]);
  });
});

describe('scrollClaudeTo over long answers', () => {
  const pageUps = (written: string[]): number => written.filter((k) => k === KEY_PAGE_UP).length;

  it('clicks the pin instead of paging through the answer under it', async () => {
    // 300 answer lines at 6 per PgUp would be ~50 pages per turn.
    const claude = fakeClaudeView(turns(['alpha', 'bravo', 'charlie'], 300));
    expect(await scrollClaudeTo(claude.io, 'alpha', ['charlie', 'bravo'])).toBe(true);
    expect(pageUps(claude.written)).toBeLessThan(12);
    expect(claude.clicked.length).toBeGreaterThan(0);
    expect(claude.copied()).toBe(0);
    // The prompt's own row on top, its answer under it.
    const body = claude.body();
    expect(body[0]).toBe('❯ alpha');
    expect(body[2]).toContain('turn 0 line 0');
  });

  it('never clicks a row it has not seen held still as the pin', async () => {
    // Whether the pin is back one or two frames after a click, the walk only
    // clicks what stayed on row 0 while the content moved - a click on the
    // prompt's own row would copy it to the user's clipboard.
    for (const pinLag of [0, 1, 2]) {
      const claude = fakeClaudeView(turns(['alpha', 'bravo', 'charlie', 'delta'], 80), { pinLag });
      expect(await scrollClaudeTo(claude.io, 'alpha', ['delta', 'charlie', 'bravo'])).toBe(true);
      expect(claude.copied()).toBe(0);
      expect(claude.clicked.every(([row]) => row === 0)).toBe(true);
    }
  });

  it('leaves a prompt’s own row alone while the pin is still away', async () => {
    // Every short turn is 12 lines - two PgUps - so two pages after delta was
    // clicked, charlie's own row stands on row 0 while the pin is still away:
    // taking it for the pin would click it, and Claude would copy it.
    const lines = turns(['alpha', 'bravo', 'charlie'], 7).concat(turns(['delta'], 60, false));
    const claude = fakeClaudeView(lines, { pinLag: 2 });
    expect(await scrollClaudeTo(claude.io, 'alpha', ['delta', 'charlie', 'bravo'])).toBe(true);
    expect(claude.clicked.length).toBeGreaterThan(0);
    expect(claude.copied()).toBe(0);
  });

  it('counts a clicked twin once', async () => {
    const claude = fakeClaudeView(turns(['continue', 'bravo', 'continue', 'charlie'], 100));
    expect(await scrollClaudeTo(claude.io, 'continue', ['charlie', 'continue', 'bravo'])).toBe(
      true,
    );
    const body = claude.body();
    expect(body[0]).toBe('❯ continue');
    expect(body[2]).toContain('turn 0 line 0');
  });

  it('finds a prompt a short answer brings into view on the way', async () => {
    // bravo's answer is short: it shows between two clicked pins.
    const lines = [
      ...turns(['alpha'], 60),
      ...turns(['bravo'], 2, false),
      ...turns(['charlie'], 60, false),
    ];
    const claude = fakeClaudeView(lines);
    expect(await scrollClaudeTo(claude.io, 'bravo', ['charlie'])).toBe(true);
    expect(findPromptRow(claude.body().slice(1), 'bravo')).not.toBe(-1);
    expect(claude.copied()).toBe(0);
  });

  it('pages the rest of the way when a click moves nothing', async () => {
    const claude = fakeClaudeView(turns(['alpha', 'bravo'], 60), { clicks: false });
    expect(await scrollClaudeTo(claude.io, 'alpha', ['bravo'])).toBe(true);
    // One try, then no more clicks.
    expect(claude.clicked).toHaveLength(1);
    expect(findPromptRow(claude.body().slice(1), 'alpha')).not.toBe(-1);
  });

  it('pages without clicking for a program that takes no clicks', async () => {
    const claude = fakeClaudeView(turns(['alpha', 'bravo'], 60));
    const io: ClaudeViewIo = { ...claude.io, click: undefined };
    expect(await scrollClaudeTo(io, 'alpha', ['bravo'])).toBe(true);
    expect(claude.clicked).toHaveLength(0);
  });

  it('never clicks a pin that names another prompt than the list says comes next', async () => {
    // While one answer fills the view Claude pins the prompt BEFORE the right
    // one: clicking it would jump over charlie, the prompt being looked for.
    const claude = fakeClaudeView(turns(['alpha', 'bravo', 'charlie'], 80), {
      tallAnswerPin: true,
    });
    expect(await scrollClaudeTo(claude.io, 'charlie', [])).toBe(true);
    expect(claude.clicked).toHaveLength(0);
    expect(findPromptRow(claude.body().slice(1), 'charlie')).not.toBe(-1);
  });

  it('still clicks the pin once it names the right prompt again', async () => {
    // Paging up out of charlie's answer, the pin is right while the turn
    // footer is in view: it is trusted there, and the answers are skipped.
    const claude = fakeClaudeView(turns(['alpha', 'bravo', 'charlie'], 80), {
      tallAnswerPin: true,
      height: 30,
    });
    expect(await scrollClaudeTo(claude.io, 'alpha', ['charlie', 'bravo'])).toBe(true);
    expect(claude.clicked.length).toBeGreaterThan(0);
    expect(claude.copied()).toBe(0);
    expect(claude.body().join('\n')).toContain('turn 0 line 0');
  });

  it('stops clicking once the screen shows a prompt the list never heard of', async () => {
    // A slash command drawn like a prompt that no prompt hook reported: the
    // list no longer says which prompt comes next, so no pin is trusted.
    const claude = fakeClaudeView(turns(['alpha', '/model', 'bravo'], 80));
    expect(await scrollClaudeTo(claude.io, 'alpha', ['bravo'])).toBe(true);
    expect(claude.body().join('\n')).toContain('turn 0 line 0');
    // bravo's pin was trusted; /model's never was.
    expect(claude.clicked).toHaveLength(1);
  });

  it('never clicks twice in the same place - Claude reads that as a double-click and copies', async () => {
    const claude = fakeClaudeView(turns(['alpha', 'bravo', 'charlie', 'delta'], 80));
    expect(await scrollClaudeTo(claude.io, 'alpha', ['delta', 'charlie', 'bravo'])).toBe(true);
    expect(claude.clicked.length).toBeGreaterThan(1);
    expect(claude.copied()).toBe(0);
  });
});

describe('scrollClaudeFromTop', () => {
  const PROMPTS = Array.from({ length: 12 }, (_, i) => `prompt ${String.fromCharCode(97 + i)}`);

  it('goes to the top and pages down to an old prompt - the short way in a long view', async () => {
    const claude = fakeClaudeView(turns(PROMPTS), { height: 12 });
    expect(await scrollClaudeFromTop(claude.io, 'prompt b')).toBe(true);
    expect(claude.written[0]).toBe(KEY_CTRL_HOME);
    expect(claude.written.slice(1).every((k) => k === KEY_PAGE_DOWN)).toBe(true);
    const body = claude.body();
    const { from, to } = messageArea([...body, BORDER]);
    expect(findPromptRow(body.slice(from, to), 'prompt b')).not.toBe(-1);
    // From the bottom it would have taken far more pages.
    const up = fakeClaudeView(turns(PROMPTS), { height: 12 });
    await scrollClaudeTo(up.io, 'prompt b', PROMPTS.slice(2).reverse());
    expect(up.written.length).toBeGreaterThan(claude.written.length);
  });

  it('gives up at the bottom when the view no longer holds the prompt, and stays there', async () => {
    const claude = fakeClaudeView(turns(PROMPTS.slice(6), 10, false), { height: 12 });
    expect(await scrollClaudeFromTop(claude.io, 'prompt a')).toBe(false);
    expect(claude.written.at(-1)).toBe(KEY_CTRL_END);
  });
});
