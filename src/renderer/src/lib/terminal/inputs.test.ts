import { Terminal, type IDecorationOptions } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachInputTracking,
  ensureInputs,
  forgetInputs,
  inputReach,
  jumpToInput,
  noteInputKeys,
  type InputEntry,
} from '@renderer/lib/terminal/inputs';

/**
 * The renderer half of the Inputs list against REAL xterm parsing (never
 * `open()`ed - buffers, markers and the OSC parser work without a DOM
 * renderer): position tags become markers, markers say what is on screen and
 * where a jump goes, and Enter in a program that reports nothing is read off
 * the screen - but never at an integrated shell's prompt, under an agent, or
 * for a line nobody could see being typed.
 */

type Push = (id: string, entries: InputEntry[]) => void;
let push: Push;
let noteInput: ReturnType<typeof vi.fn<(id: string, text: string, ref: number) => void>>;
let write: ReturnType<typeof vi.fn<(id: string, data: string) => void>>;

// The bridge is connected once per module, on first use - one stub for the file.
const bridge = {
  onInputs: (cb: Push) => {
    push = cb;
    return () => {};
  },
  inputList: vi.fn(async () => [] as InputEntry[]),
  noteInput: vi.fn(),
  write: vi.fn(),
  markerDriven: vi.fn<(ids: string[]) => Promise<string[]>>(async () => []),
};
Object.defineProperty(window, 'api', {
  configurable: true,
  writable: true,
  value: { terminal: bridge },
});

let n = 0;
let id: string;
let term: Terminal;

beforeEach(() => {
  noteInput = bridge.noteInput = vi.fn();
  write = bridge.write = vi.fn();
  id = `pty-${++n}`;
  term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
  attachInputTracking(id, term);
  ensureInputs(id);
});

const feed = (data: string): Promise<void> => new Promise((r) => term.write(data, r));
const tag = (verb: 'at' | 'end', seq: number): string => `\x1b]6791;${verb};${seq}\x07`;
const lines = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `out ${from + i}\r\n`).join('');

let seqN = 0;
function entry(
  fields: Partial<InputEntry> & Pick<InputEntry, 'seq' | 'kind' | 'text'>,
): InputEntry {
  return {
    program: fields.kind === 'prompt' ? 'claude' : 'shell',
    lines: 1,
    truncated: false,
    at: ++seqN,
    exitCode: null,
    gone: false,
    run: 0,
    ref: null,
    ...fields,
  };
}

describe('positions', () => {
  it('turns a tag into a marker where the stream had it, and scrolls back to it', async () => {
    await feed(`${tag('at', 1)}% pnpm test\r\n${tag('end', 1)}`);
    await feed(lines(0, 30));
    const cmd = entry({ seq: 1, kind: 'command', text: 'pnpm test' });
    push(id, [cmd]);
    // 30 lines later the command is far above the viewport.
    expect(inputReach(id, [cmd]).get(1)).toBe('jump');
    expect(await jumpToInput(id, cmd)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(0);
    expect(inputReach(id, [cmd]).get(1)).toBe('screen');
  });

  it('keeps the last tag for a seq - a prompt redrawn after an empty Enter', async () => {
    await feed(`${tag('at', 1)}% \r\n${lines(0, 10)}${tag('at', 1)}% ls\r\n${tag('end', 1)}`);
    await feed(lines(10, 20));
    const cmd = entry({ seq: 1, kind: 'command', text: 'ls' });
    push(id, [cmd]);
    await jumpToInput(id, cmd);
    // Lands on the second prompt (row 11, one row of context above).
    expect(term.buffer.active.viewportY).toBe(10);
  });

  it('marks nothing on the alternate screen - it has nowhere to scroll back to', async () => {
    await feed(`\x1b[?1049h${tag('at', 1)}`);
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    await feed('\x1b[?1049l');
    expect(inputReach(id, [p]).get(1)).toBe('out');
  });

  it('reports an input whose lines left the scrollback as out of reach', async () => {
    await feed(`${tag('at', 1)}% ls\r\n`);
    await feed(lines(0, 200));
    const cmd = entry({ seq: 1, kind: 'command', text: 'ls' });
    push(id, [cmd]);
    expect(inputReach(id, [cmd]).get(1)).toBe('out');
    expect(await jumpToInput(id, cmd)).toBe(false);
  });

  it('starts a fresh xterm without the old one’s markers', async () => {
    await feed(`${tag('at', 1)}% ls\r\n`);
    const cmd = entry({ seq: 1, kind: 'command', text: 'ls' });
    push(id, [cmd]);
    term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
    attachInputTracking(id, term);
    expect(inputReach(id, [cmd]).get(1)).toBe('out');
    // The replay into it brings the tag, and the position, back.
    await feed(`${tag('at', 1)}% ls\r\n`);
    expect(inputReach(id, [cmd]).get(1)).toBe('screen');
  });
});

describe('agent prompts', () => {
  it('finds a prompt a classic-renderer Claude echoed, without a marker', async () => {
    await feed(`❯ why does auth.test.ts fail\r\n⏺ Looking\r\n${lines(0, 20)}`);
    const p = entry({ seq: 3, kind: 'prompt', text: 'why does auth.test.ts fail' });
    push(id, [p]);
    expect(inputReach(id, [p]).get(3)).toBe('jump');
    expect(await jumpToInput(id, p)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(0);
  });

  it('scrolls a full-screen agent’s own view, never opening its transcript', async () => {
    await feed('\x1b]6790;ready\x07\x1b[?1049h');
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    expect(inputReach(id, [p]).get(1)).toBe('jump');
    vi.useFakeTimers();
    try {
      const jump = jumpToInput(id, p);
      await vi.advanceTimersByTimeAsync(3000);
      // Not in this (blank) view, already at the bottom: one page up that
      // moves nothing - the top - and back to the bottom. Never Ctrl+O.
      expect(await jump).toBe(false);
      expect(write.mock.calls).toEqual([
        [id, '\x1b[5~'],
        [id, '\x1b[1;5F'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the frame on screen while it walks, and never sends the hold to the program', async () => {
    await feed('\x1b]6790;ready\x07\x1b[?1049h');
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    vi.useFakeTimers();
    try {
      const jump = jumpToInput(id, p);
      await vi.advanceTimersByTimeAsync(20);
      expect(term.modes.synchronizedOutputMode).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      await jump;
      await vi.advanceTimersByTimeAsync(20);
      expect(term.modes.synchronizedOutputMode).toBe(false);
      expect(write.mock.calls.some(([, data]) => data.includes('2026'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A full-screen Claude on a real xterm: every key redraws the screen the
   * way 2.1.278 does (see input-jump.test.ts for the semantics) - PgUp half a
   * page, Ctrl+End to the bottom, a click on the pinned row to its prompt.
   */
  function fullScreenClaude(conversation: string[], height = 10): { clicks: string[] } {
    term.resize(40, height + 4);
    const border = '─'.repeat(30);
    let offset = 0;
    let pinAway = 0;
    const clicks: string[] = [];
    const top = (): number => Math.max(0, conversation.length - offset - height);
    const pinLine = (): number => {
      for (let i = top(); i >= 0; i--) if (conversation[i].startsWith('❯ ')) return i;
      return -1;
    };
    const draw = (): void => {
      const rows = conversation.slice(top(), conversation.length - offset);
      while (rows.length < height) rows.unshift('');
      if (offset > 0) {
        if (pinAway === 0) rows[0] = conversation[pinLine()] ?? '';
        rows[height - 1] = 'Jump to bottom (click) ↓';
      }
      term.write(`\x1b[H\x1b[2J${[...rows, border, '❯ ', border, '  acme'].join('\r\n')}`);
    };
    write.mockImplementation((_, data) => {
      pinAway = Math.max(0, pinAway - 1);
      // An SGR press + release: ESC [ <0;col;row M, then the same with m.
      const [, press, release] = data.split('\x1b[');
      const click = press && /^<0;(\d+);(\d+)M$/.exec(press);
      if (click && release === press.replace(/M$/, 'm')) {
        clicks.push(data);
        if (click[2] !== '1' || pinAway > 0) throw new Error(`clicked a real row: ${data}`);
        offset = Math.max(0, conversation.length - pinLine() - height);
        pinAway = 2;
      } else if (data === '\x1b[5~') {
        offset = Math.min(conversation.length - height, offset + height / 2);
      } else if (data === '\x1b[1;5F') {
        offset = 0;
      } else {
        return;
      }
      draw();
    });
    void feed('\x1b]6790;ready\x07\x1b[?1049h');
    draw();
    return { clicks };
  }

  const conversation = ['alpha', 'bravo'].flatMap((prompt, t) => [
    `❯ ${prompt}`,
    '',
    ...Array.from({ length: 40 }, (_, i) => `  turn ${t} line ${i}`),
    '',
  ]);

  it('clicks the pinned row in the encoding the program asked for', async () => {
    const claude = fullScreenClaude(conversation);
    await feed('\x1b[?1000;1006h');
    const p = entry({ seq: 1, kind: 'prompt', text: 'alpha' });
    push(id, [p, entry({ seq: 2, kind: 'prompt', text: 'bravo' })]);
    vi.useFakeTimers();
    try {
      const jump = jumpToInput(id, p);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await jump).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // SGR, 1-based: the pin is the screen's first row.
    expect(claude.clicks.length).toBeGreaterThan(0);
    expect(claude.clicks[0]).toBe('\x1b[<0;4;1M\x1b[<0;4;1m');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('❯ alpha');
  });

  it('pages instead of clicking when the program reads no SGR mouse reports', async () => {
    const claude = fullScreenClaude(conversation);
    // Mouse on, but the legacy encoding: an SGR report would read as keys.
    await feed('\x1b[?1000h');
    const p = entry({ seq: 1, kind: 'prompt', text: 'alpha' });
    push(id, [p, entry({ seq: 2, kind: 'prompt', text: 'bravo' })]);
    vi.useFakeTimers();
    try {
      const jump = jumpToInput(id, p);
      await vi.advanceTimersByTimeAsync(20000);
      expect(await jump).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(claude.clicks).toEqual([]);
  });

  it('calls a full-screen agent’s prompt on screen only in its message area', async () => {
    const border = '─'.repeat(30);
    await feed(`\x1b]6790;ready\x07\x1b[?1049h❯ fix it\r\n⏺ ok\r\n${border}\r\n❯ add a test`);
    const shown = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    // A draft in the input box is not a sent prompt on screen.
    const drafted = entry({ seq: 2, kind: 'prompt', text: 'add a test' });
    push(id, [shown, drafted]);
    const reach = inputReach(id, [shown, drafted]);
    expect(reach.get(1)).toBe('screen');
    expect(reach.get(2)).toBe('jump');
  });

  it('leaves a prompt of an ended run out of the agent’s view', async () => {
    await feed('\x1b]6790;ready\x07\x1b[?1049h');
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it', gone: true });
    push(id, [p]);
    expect(inputReach(id, [p]).get(1)).toBe('out');
  });

  it('never sends a key into a full-screen program the walk cannot read - an OpenCode prompt', async () => {
    // OpenCode (1.17.20) echoes a prompt as `┃  <text>`; a click on its top
    // row opens a dialog and PgUp barely moves it (probed 2026-10-03), so its
    // prompts are on screen or scrolled out - never a jump, never a key.
    await feed('\x1b]6790;ready\x07\x1b[?1049h┃  fix it\r\n   $ ls -la\r\n');
    const shown = entry({ seq: 1, kind: 'prompt', text: 'fix it', program: 'opencode' });
    const scrolled = entry({ seq: 2, kind: 'prompt', text: 'add a test', program: 'opencode' });
    push(id, [shown, scrolled]);
    const reach = inputReach(id, [shown, scrolled]);
    expect(reach.get(1)).toBe('screen');
    expect(reach.get(2)).toBe('out');
    expect(await jumpToInput(id, scrolled)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('inline Claude prompts', () => {
  // Claude Code's inline renderer as captured on 2.1.278: after Enter it draws
  // the prompt's echo (a bar painted the full width), a blank row, the spinner
  // and the input box - and only then does the hook's mark arrive, with the
  // cursor in the input box, five rows under the echo's last row. The answer
  // is then written over those rows, so the marker sits on answer text.
  const bar = (text: string): string => text.padEnd(40);
  const border = '─'.repeat(40);
  function turn(seq: number, prompt: string, answer: string[]): string {
    const echo = prompt
      .split('\n')
      .map((l, i) => bar(`${i === 0 ? '❯' : ' '} ${l}`))
      .join('\r\n');
    return (
      `${echo}\r\n\r\n✻ Working…\r\n\r\n${border}\r\n❯ ${tag('at', seq)}\r\n${border}` +
      // Back up to the spinner row and write the answer over the live area,
      // line by line with EL as Claude does (ED would reset the rows and take
      // the marker with them).
      `\x1b[4A\r${[...answer, ''].map((l) => `\x1b[2K${l}\r\n`).join('')}`
    );
  }
  const answer = (word: string): string[] => [
    `⏺ ${word}`,
    '  line two',
    '  line three',
    '  line four',
  ];
  /** The rows a jump flashed, as [first row, height] per flash. */
  const flashes = (spy: { mock: { calls: [IDecorationOptions][] } }): [number, number][] =>
    spy.mock.calls.map(([o]) => [o.marker.line, o.height ?? 1]);

  it('flashes the prompt’s echo, never the answer text its mark sits on', async () => {
    const text = 'fix the login redirect\nafter a token refresh';
    await feed(`\x1b]6790;ready\x07${lines(0, 3)}${turn(1, text, answer('Found it'))}`);
    await feed(lines(3, 30));
    const p = entry({ seq: 1, kind: 'prompt', text, lines: 2 });
    push(id, [p]);
    const deco = vi.spyOn(term, 'registerDecoration');
    expect(inputReach(id, [p]).get(1)).toBe('jump');
    expect(await jumpToInput(id, p)).toBe(true);
    // The echo is rows 3-4; the mark landed on row 9, now '  line four'.
    expect(term.buffer.active.viewportY).toBe(2);
    expect(flashes(deco)).toEqual([[3, 2]]);
  });

  it('tells two prompts with the same first line apart by the echo above each mark', async () => {
    await feed(`\x1b]6790;ready\x07${turn(1, 'continue', answer('Reading'))}`);
    await feed(`${turn(2, 'continue', answer('Done'))}${lines(0, 30)}`);
    const first = entry({ seq: 1, kind: 'prompt', text: 'continue' });
    const second = entry({ seq: 2, kind: 'prompt', text: 'continue' });
    push(id, [first, second]);
    const deco = vi.spyOn(term, 'registerDecoration');
    await jumpToInput(id, first);
    await jumpToInput(id, second);
    expect(flashes(deco)).toEqual([
      [0, 1],
      [7, 1],
    ]);
  });

  it('finds unmarked prompts with the same first line by counting the later ones', async () => {
    // No tags: the marks left the replay ring, the echo is searched for in the
    // whole buffer - the older "continue" is the second match from the bottom.
    await feed(`❯ continue\r\n${lines(0, 10)}❯ continue\r\n${lines(10, 30)}`);
    const first = entry({ seq: 1, kind: 'prompt', text: 'continue' });
    const second = entry({ seq: 2, kind: 'prompt', text: 'continue' });
    const other = entry({ seq: 3, kind: 'prompt', text: 'never echoed' });
    push(id, [first, second, other]);
    term.scrollToLine(0);
    expect([...inputReach(id, [first, second, other])]).toEqual([
      [1, 'screen'],
      [2, 'jump'],
      [3, 'out'],
    ]);
    term.scrollToLine(11);
    expect([...inputReach(id, [first, second, other])]).toEqual([
      [1, 'jump'],
      [2, 'screen'],
      [3, 'out'],
    ]);
  });

  it('calls a prompt on screen by its echo, not by the mark below it', async () => {
    await feed(`\x1b]6790;ready\x07${lines(0, 3)}${turn(1, 'fix it', answer('Fixed'))}`);
    await feed(lines(3, 30));
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    // The view starts two rows under the echo (row 3): the mark (row 8) shows,
    // the prompt does not.
    term.scrollToLine(5);
    expect(inputReach(id, [p]).get(1)).toBe('jump');
    await jumpToInput(id, p);
    expect(term.buffer.active.viewportY).toBe(2);
    expect(inputReach(id, [p]).get(1)).toBe('screen');
  });

  it('still scrolls to a marked prompt whose echo is gone, and flashes nothing', async () => {
    // The rows around the mark hold no echo of the prompt any more.
    await feed(`${lines(0, 3)}⏺ Working on it\r\n${tag('at', 1)}  still going\r\n`);
    await feed(lines(3, 30));
    const p = entry({ seq: 1, kind: 'prompt', text: 'deploy it' });
    push(id, [p]);
    const deco = vi.spyOn(term, 'registerDecoration');
    expect(await jumpToInput(id, p)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(3);
    expect(deco).not.toHaveBeenCalled();
  });
});

describe('lines read off the screen at Enter', () => {
  /** Type `text` the way a program that echoes would show it. */
  async function type(text: string, echo = true): Promise<void> {
    for (const ch of text) {
      noteInputKeys(id, term, ch);
      if (echo) await feed(ch);
    }
  }

  it('reports the typed line without the program’s prompt', async () => {
    await feed('>>> ');
    await type('print(2 + 2)');
    noteInputKeys(id, term, '\r');
    expect(noteInput).toHaveBeenCalledTimes(1);
    const [pty, text, ref] = noteInput.mock.calls[0];
    expect([pty, text]).toEqual([id, 'print(2 + 2)']);
    // Main's entry names the ref: the marker placed at Enter becomes its position.
    await feed('\r\n4\r\n>>> ');
    push(id, [entry({ seq: 1, kind: 'line', text: 'print(2 + 2)', program: 'python3', ref })]);
    expect(inputReach(id, [entry({ seq: 1, kind: 'line', text: '' })]).get(1)).toBe('screen');
  });

  it('reads a line that wrapped across rows whole', async () => {
    await feed('$ ');
    const long = 'echo ' + 'x'.repeat(60);
    await type(long);
    noteInputKeys(id, term, '\r');
    expect(noteInput.mock.calls[0][1]).toBe(long);
  });

  it('stays quiet at an integrated shell prompt - the shell reports its command', async () => {
    await feed('\x1b]6791;ps\x07% ');
    await type('ls');
    noteInputKeys(id, term, '\r');
    expect(noteInput).not.toHaveBeenCalled();
  });

  it('reads lines typed into a program the integrated shell is running', async () => {
    await feed(`\x1b]6791;ps\x07% python3\r\n\x1b]6791;cmd;${btoa('python3')}\x07>>> `);
    await type('1 + 1');
    noteInputKeys(id, term, '\r');
    expect(noteInput.mock.calls[0][1]).toBe('1 + 1');
  });

  it('stays quiet while an agent with hooks owns the terminal, and after it ends reads again', async () => {
    await feed('\x1b]6790;ready\x07> ');
    await type('hello');
    noteInputKeys(id, term, '\r');
    expect(noteInput).not.toHaveBeenCalled();
    await feed('\x1b]6790;ended\x07\r\n$ ');
    await type('ls');
    noteInputKeys(id, term, '\r');
    expect(noteInput.mock.calls[0][1]).toBe('ls');
  });

  it('never reports what nobody could see typed - a password prompt', async () => {
    await feed('Password: ');
    await type('hunter2', false);
    noteInputKeys(id, term, '\r');
    expect(noteInput).not.toHaveBeenCalled();
  });

  it('ignores a bare Enter and a paste', async () => {
    await feed('$ ');
    noteInputKeys(id, term, '\r');
    noteInputKeys(id, term, 'ls -la\r');
    expect(noteInput).not.toHaveBeenCalled();
  });

  it('ignores keys on the alternate screen', async () => {
    await feed('\x1b[?1049h:');
    await type('wq');
    noteInputKeys(id, term, '\r');
    expect(noteInput).not.toHaveBeenCalled();
  });
});

describe('forgetInputs', () => {
  it('drops the pty - a closed tab, or one another window now owns', async () => {
    push(id, [entry({ seq: 1, kind: 'command', text: 'ls' })]);
    forgetInputs(id);
    expect(inputReach(id, [entry({ seq: 1, kind: 'command', text: 'ls' })]).get(1)).toBe('out');
  });
});

describe('a fresh xterm on a live agent', () => {
  /** A new xterm on the same pty - a reload, a revisit after eviction, a tear-off. */
  function reattach(): void {
    term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
    attachInputTracking(id, term);
  }

  it('takes the agent from main when the replay no longer holds a status verb', async () => {
    // A full-screen Claude rewrites every cell of every frame: minutes after
    // its last verb the 256 KB ring holds frames only. Without main's answer
    // every prompt read as scrolled out until the next turn.
    bridge.markerDriven.mockResolvedValueOnce([id]);
    reattach();
    await feed('\x1b[?1049h❯ earlier\r\n⏺ ok');
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    expect(bridge.markerDriven).toHaveBeenLastCalledWith([id]);
    expect(inputReach(id, [p]).get(1)).toBe('jump');
  });

  it('keeps a verb the replay carried over main’s answer', async () => {
    let answer: (ids: string[]) => void = () => {};
    bridge.markerDriven.mockReturnValueOnce(new Promise((r) => (answer = r)));
    reattach();
    // The agent exited on the way: the xterm heard `ended` before main answered.
    await feed('\x1b]6790;ended\x07\x1b[?1049h');
    answer([id]);
    await Promise.resolve();
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    expect(inputReach(id, [p]).get(1)).toBe('out');
  });

  it('ignores an answer that arrives for an xterm already replaced', async () => {
    let answer: (ids: string[]) => void = () => {};
    bridge.markerDriven.mockReturnValueOnce(new Promise((r) => (answer = r)));
    reattach();
    reattach();
    await feed('\x1b[?1049h');
    answer([id]);
    await Promise.resolve();
    const p = entry({ seq: 1, kind: 'prompt', text: 'fix it' });
    push(id, [p]);
    // The newer xterm's own ask said no agent.
    expect(inputReach(id, [p]).get(1)).toBe('out');
  });
});
