import { describe, expect, it } from 'vitest';
import { TerminalModeTracker, containsInterruptKey } from './terminal-modes';

// The Claude Code startup batch: alt screen, focus reporting, mouse
// (button-event protocol + SGR encoding), bracketed paste.
const CC_SETUP = '\x1b[?1049h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[?2004h';

describe('TerminalModeTracker', () => {
  it('is silent for plain shell output', () => {
    const t = new TerminalModeTracker();
    t.feed('ls -la\r\ntotal 8\r\ndrwxr-xr-x  emmaw staff acme\r\n');
    expect(t.preamble()).toBe('');
  });

  it('re-asserts a TUI setup that the replay ring no longer contains', () => {
    // The tracker sees ALL output, so a mode set once at startup survives any
    // amount of later output - the exact case where the 256 KB ring fails.
    const t = new TerminalModeTracker();
    t.feed(CC_SETUP);
    t.feed('x'.repeat(512 * 1024));
    const p = t.preamble();
    for (const seq of ['\x1b[?1049h', '\x1b[?1004h', '\x1b[?1002h', '\x1b[?1006h', '\x1b[?2004h']) {
      expect(p).toContain(seq);
    }
  });

  it('starts a non-empty preamble with ST, to close a mid-string replay cut', () => {
    // The ring trims whole chunks off the FRONT but its tail can end inside an
    // OSC - without a leading ST the terminator-less string would swallow the
    // assertions that follow.
    const t = new TerminalModeTracker();
    t.feed('\x1b[?2004h');
    expect(t.preamble().startsWith('\x1b\\')).toBe(true);
  });

  it('a disable cancels the earlier enable', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b[?2004h');
    t.feed('\x1b[?2004l');
    expect(t.preamble()).toBe('');
  });

  it('restores cursor-hidden and autowrap-off, the two non-default OFF states', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b[?25l\x1b[?7l');
    const p = t.preamble();
    expect(p).toContain('\x1b[?25l');
    expect(p).toContain('\x1b[?7l');
    // Turning them back on returns to defaults - nothing left to assert.
    t.feed('\x1b[?25h\x1b[?7h');
    expect(t.preamble()).toBe('');
  });

  it('tracks a sequence split at every possible chunk boundary', () => {
    const seq = '\x1b[?1049h';
    for (let cut = 1; cut < seq.length; cut++) {
      const t = new TerminalModeTracker();
      t.feed(seq.slice(0, cut));
      t.feed(seq.slice(cut));
      expect(t.preamble()).toContain('\x1b[?1049h');
    }
  });

  it('applies every mode of a multi-param DECSET', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b[?1049;2004h');
    const p = t.preamble();
    expect(p).toContain('\x1b[?1049h');
    expect(p).toContain('\x1b[?2004h');
  });

  it('re-enables mouse protocols in the order the program did, not numerically', () => {
    // A terminal holds ONE active mouse protocol - the last `h` wins. A
    // program that switched 1003 → 1000 must end on 1000 after restoration.
    const t = new TerminalModeTracker();
    t.feed('\x1b[?1003h');
    t.feed('\x1b[?1000h');
    const p = t.preamble();
    expect(p.indexOf('\x1b[?1003h')).toBeGreaterThan(-1);
    expect(p.indexOf('\x1b[?1000h')).toBeGreaterThan(p.indexOf('\x1b[?1003h'));
  });

  it('does not misread mode-like text inside an OSC payload', () => {
    const t = new TerminalModeTracker();
    // Both BEL- and ST-terminated strings, carrying text that LOOKS like a
    // DECSET (e.g. our own base64 status markers can contain anything).
    t.feed('\x1b]0;window [?1049h title\x07');
    t.feed('\x1bPsome [?2004h payload\x1b\\');
    expect(t.preamble()).toBe('');
    // …and the parser is back in ground state afterwards.
    t.feed('\x1b[?2004h');
    expect(t.preamble()).toContain('\x1b[?2004h');
  });

  it('an ESC inside a string aborts it and starts a real sequence (xterm semantics)', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]0;unterminated title\x1b[?1004h');
    expect(t.preamble()).toContain('\x1b[?1004h');
  });

  it('an ESC aborts an unfinished CSI without corrupting the next sequence', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b[?20\x1b[?2004h');
    const p = t.preamble();
    expect(p).toContain('\x1b[?2004h');
    expect(p).not.toContain('\x1b[?20h');
  });

  it('does not re-assert synchronized output (2026) or public SM modes', () => {
    // 2026 is toggled around every frame - asserting a mid-frame `h` would
    // hold rendering until the program's next frame. Public SM (no `?`) is
    // out of scope entirely.
    const t = new TerminalModeTracker();
    t.feed('\x1b[?2026h');
    t.feed('\x1b[4h');
    expect(t.preamble()).toBe('');
  });

  it('survives an overlong CSI without tracking garbage', () => {
    const t = new TerminalModeTracker();
    t.feed(`\x1b[?${'1'.repeat(200)}h`);
    expect(t.preamble()).toBe('');
    t.feed('\x1b[?1049h');
    expect(t.preamble()).toContain('\x1b[?1049h');
  });

  it('restores application keypad and the last cursor style', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b=');
    t.feed('\x1b[3 q\x1b[5 q');
    const p = t.preamble();
    expect(p).toContain('\x1b=');
    expect(p).toContain('\x1b[5 q');
    expect(p).not.toContain('\x1b[3 q');
    t.feed('\x1b>');
    expect(t.preamble()).not.toContain('\x1b=');
  });

  it('ignores SGR and cursor-addressing noise between mode changes', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b[1;31mred\x1b[0m\x1b[12;40H\x1b[2J\x1b[?1049h\x1b[K');
    expect(t.preamble()).toBe('\x1b\\\x1b[?1049h');
  });
});

describe('TerminalModeTracker title capture', () => {
  // OSC 0 (icon+title) and OSC 2 (title) both set the window title - the
  // session auto-namer follows them (see renderer session/auto-name.ts).
  it('captures a BEL-terminated OSC 0 title, and reading clears it', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]0;Fixing auth tokens\x07');
    expect(t.takeTitle()).toBe('Fixing auth tokens');
    expect(t.takeTitle()).toBeNull();
  });

  it('captures an ST-terminated OSC 2 title', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]2;deploy watcher\x1b\\');
    expect(t.takeTitle()).toBe('deploy watcher');
  });

  it('keeps only the latest of several titles', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]0;first\x07plain output\x1b]2;second\x07');
    expect(t.takeTitle()).toBe('second');
  });

  it('captures a title split at every possible chunk boundary', () => {
    const seq = '\x1b]0;split title\x07';
    for (let cut = 1; cut < seq.length; cut++) {
      const t = new TerminalModeTracker();
      t.feed(seq.slice(0, cut));
      t.feed(seq.slice(cut));
      expect(t.takeTitle()).toBe('split title');
    }
  });

  it('ignores non-title OSCs: icon-only, our status marker, and code-less strings', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]1;icon only\x07');
    t.feed('\x1b]6790;running\x07'); // the session-status marker (see terminal.ts)
    t.feed('\x1b]nosemicolon\x07');
    t.feed('\x1bPsome dcs payload\x1b\\'); // DCS is not an OSC at all
    expect(t.takeTitle()).toBeNull();
  });

  it('drops a title whose string was aborted by a real escape sequence', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]0;half a title\x1b[?1049h');
    expect(t.takeTitle()).toBeNull();
  });

  it('discards an overlong OSC instead of adopting a truncated title', () => {
    const t = new TerminalModeTracker();
    t.feed(`\x1b]0;${'x'.repeat(2048)}\x07`);
    expect(t.takeTitle()).toBeNull();
    // …and the next normal title still comes through.
    t.feed('\x1b]0;short again\x07');
    expect(t.takeTitle()).toBe('short again');
  });

  it('captures an explicit title CLEAR as the empty string', () => {
    // `ESC]0;BEL` is a program clearing its title - captured verbatim; the
    // auto-namer treats an empty title as nothing to adopt.
    const t = new TerminalModeTracker();
    t.feed('\x1b]0;\x07');
    expect(t.takeTitle()).toBe('');
  });
});

describe('TerminalModeTracker marker mode', () => {
  const marker = (verb: string, payload = ''): string =>
    `\x1b]6790;${verb}${payload ? `;${payload}` : ''}\x07`;

  it('is unknown until a status marker goes by', () => {
    const t = new TerminalModeTracker();
    t.feed(`${CC_SETUP}\x1b]0;✳ Claude Code\x07plain output`);
    expect(t.markerDriven).toBeNull();
  });

  it('learns the protocol from any marker and unlearns it on ended', () => {
    // A Claude launched through a wrapper (claude-shim.ts) is not known to be
    // marker-driven at spawn - only its stream can prove it. 'ended' means the
    // agent exited back to the shell prompt, which speaks no markers.
    const t = new TerminalModeTracker();
    t.feed(marker('ready'));
    expect(t.markerDriven).toBe(true);
    t.feed(marker('ended'));
    expect(t.markerDriven).toBe(false);
    t.feed(marker('tool-start', 'QmFzaApscwo='));
    expect(t.markerDriven).toBe(true);
    // An unknown verb still proves the hooks are in place (a newer hook set).
    t.feed(marker('ended'));
    t.feed(marker('discombobulate'));
    expect(t.markerDriven).toBe(true);
  });

  it('counts an overlong question marker - the verb sits at the front', () => {
    const t = new TerminalModeTracker();
    t.feed(marker('question', 'A'.repeat(6000)));
    expect(t.markerDriven).toBe(true);
  });

  it('follows a marker split across chunks, BEL- or ST-terminated', () => {
    const seq = marker('running');
    for (let cut = 1; cut < seq.length; cut++) {
      const t = new TerminalModeTracker();
      t.feed(seq.slice(0, cut));
      expect(t.markerDriven).toBeNull();
      t.feed(seq.slice(cut));
      expect(t.markerDriven).toBe(true);
    }
    const t = new TerminalModeTracker();
    t.feed('\x1b]6790;finished\x1b\\');
    expect(t.markerDriven).toBe(true);
  });

  it('is not fooled by a title or a foreign private OSC, and keeps titles working', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]6791;running\x07\x1b]0;6790;running\x07');
    expect(t.markerDriven).toBeNull();
    expect(t.takeTitle()).toBe('6790;running');
    t.feed(marker('ready'));
    t.feed('\x1b]2;Fix flaky tests\x07');
    expect(t.takeTitle()).toBe('Fix flaky tests');
    expect(t.markerDriven).toBe(true);
  });
});

describe('TerminalModeTracker agent status', () => {
  const marker = (verb: string, payload = ''): string =>
    `\x1b]6790;${verb}${payload ? `;${payload}` : ''}\x07`;
  /** A tool marker's payload as the hook script writes it - a subagent's
   * call carries its agent type as a third line. */
  const tool = (name: string, arg: string, agent?: string): string =>
    Buffer.from(`${name}\n${arg}\n${agent ? `${agent}\n` : ''}`).toString('base64');

  it('is idle until a marker says otherwise', () => {
    const t = new TerminalModeTracker();
    t.feed(`${CC_SETUP}\x1b]0;✳ Claude Code\x07plain output`);
    expect(t.agentStatus).toBe('idle');
  });

  it('stays running while the agent waits on a background subagent', () => {
    // The bug: the main agent's Stop is held back while its background
    // subagent works (claude-status-hooks.ts), so nothing follows the turn's
    // `running` for minutes - and a renderer that reloaded in between had no
    // tab state at all. Main must still say running for it to learn from.
    const t = new TerminalModeTracker();
    t.feed(marker('ready'));
    t.feed(marker('running'));
    t.feed(marker('tool-start', tool('Agent', 'Fix the colours')));
    t.feed(marker('tool-done', tool('Agent', 'Fix the colours')));
    expect(t.agentStatus).toBe('running');
    // A long quiet stretch of repaints is not a stop.
    t.feed(`\x1b[H\x1b[2J${'x'.repeat(4096)}\x07`);
    expect(t.agentStatus).toBe('running');
    t.feed(marker('finished'));
    expect(t.agentStatus).toBe('idle');
  });

  it('follows waits, answers and exits', () => {
    const t = new TerminalModeTracker();
    t.feed(marker('running'));
    t.feed(marker('needs-input', Buffer.from('Claude needs your permission').toString('base64')));
    expect(t.agentStatus).toBe('needs-input');
    // The main agent's own tool completing proves the prompt was answered.
    t.feed(marker('tool-done', tool('Bash', 'pnpm test')));
    expect(t.agentStatus).toBe('running');
    t.feed(marker('question', 'e30='));
    expect(t.agentStatus).toBe('needs-input');
    t.feed(marker('question-done'));
    expect(t.agentStatus).toBe('running');
    t.feed(marker('ended'));
    expect(t.agentStatus).toBe('idle');
    t.feed(marker('running'));
    // SessionStart on a relaunch: nothing is running yet.
    t.feed(marker('ready'));
    expect(t.agentStatus).toBe('idle');
  });

  it("never lets a subagent's tool lift a wait, but lets it mark work", () => {
    // A background subagent works on while the main agent sits at a
    // permission prompt - its tools completing are not the user answering.
    const t = new TerminalModeTracker();
    t.feed(marker('needs-input'));
    t.feed(marker('tool-start', tool('Bash', 'ls', 'general-purpose')));
    t.feed(marker('tool-done', tool('Bash', 'ls', 'general-purpose')));
    expect(t.agentStatus).toBe('needs-input');
    // Outside a wait, a subagent's tool is work like any other.
    t.feed(marker('finished'));
    t.feed(marker('tool-start', tool('Bash', 'ls', 'Explore')));
    expect(t.agentStatus).toBe('running');
  });

  it("reads a subagent's tag past the title cap", () => {
    // A long non-ASCII argument (up to 300 chars, several bytes each) pushes
    // the base64 payload past the 512-char OSC cap titles use; cut there, the
    // agent line was lost and the subagent's tool lifted the wait.
    const t = new TerminalModeTracker();
    t.feed(marker('needs-input'));
    const payload = tool('Edit', `docs/${'ü'.repeat(290)}.md`, 'general-purpose');
    expect(payload.length).toBeGreaterThan(512);
    t.feed(marker('tool-done', payload));
    expect(t.agentStatus).toBe('needs-input');
  });

  it('follows a marker split across chunks and ignores unknown verbs', () => {
    const seq = marker('tool-start', tool('Edit', 'src/app.ts', 'general-purpose'));
    for (let cut = 1; cut < seq.length; cut += 7) {
      const t = new TerminalModeTracker();
      t.feed(marker('needs-input'));
      t.feed(seq.slice(0, cut));
      t.feed(seq.slice(cut));
      expect(t.agentStatus).toBe('needs-input');
    }
    const t = new TerminalModeTracker();
    t.feed(marker('running'));
    t.feed(marker('discombobulate'));
    expect(t.agentStatus).toBe('running');
  });

  it('stops on Esc or Ctrl+C, which no hook reports', () => {
    // The bug: a prompt cancelled before its first reply left `running`
    // standing, and a window that reloaded asked main and learned "running".
    const t = new TerminalModeTracker();
    t.feed(marker('ready'));
    t.feed(marker('running'));
    t.noteInput(`\x1b[A\x1b[I\x1bb`); // an arrow, a focus report, Alt+b
    expect(t.agentStatus).toBe('running');
    t.noteInput('\x1b');
    expect(t.agentStatus).toBe('idle');
    // A false stop heals on the agent's next marker.
    t.feed(marker('tool-start', tool('Read', 'a.ts')));
    expect(t.agentStatus).toBe('running');
    t.feed(marker('needs-input'));
    t.noteInput('\x03');
    expect(t.agentStatus).toBe('idle');
  });

  it('ignores interrupt keys outside marker mode', () => {
    // A plain shell - or one whose agent has ended - has no turn to stop.
    const t = new TerminalModeTracker();
    t.noteInput('\x03');
    expect(t.agentStatus).toBe('idle');
    expect(containsInterruptKey('\x1b[<0;3;4M')).toBe(false);
    expect(containsInterruptKey('\x1b\x1b')).toBe(true);
  });

  it('still discards an overlong title', () => {
    // The marker cap must not leak to other OSCs: a 600-char title is no title.
    const t = new TerminalModeTracker();
    t.feed(`\x1b]0;${'T'.repeat(600)}\x07`);
    expect(t.takeTitle()).toBeNull();
  });
});

describe('TerminalModeTracker colour-scheme reports', () => {
  // DECSET 2031 is what Claude Code (theme "auto") uses to ask for light/dark
  // pushes; terminal.ts sends them only to a pty whose program asked.

  it('learns that the program wants tone reports and forgets it on disable', () => {
    const t = new TerminalModeTracker();
    expect(t.reportsColorScheme).toBe(false);
    t.feed(CC_SETUP + '\x1b[?2031h');
    expect(t.reportsColorScheme).toBe(true);
    t.feed('\x1b[?2031l');
    expect(t.reportsColorScheme).toBe(false);
  });

  it('reads it inside a multi-param DECSET split at every chunk boundary', () => {
    const seq = '\x1b[?2004;2031h';
    for (let cut = 1; cut < seq.length; cut++) {
      const t = new TerminalModeTracker();
      t.feed(seq.slice(0, cut));
      t.feed(seq.slice(cut));
      expect(t.reportsColorScheme).toBe(true);
    }
  });

  it('never re-asserts it in the replay preamble', () => {
    // It is the program's request to the terminal, not terminal state: a fresh
    // xterm has nothing to restore, and main answers it with the push instead.
    const t = new TerminalModeTracker();
    t.feed('\x1b[?2031h\x1b[?2004h');
    expect(t.preamble()).toContain('\x1b[?2004h');
    expect(t.preamble()).not.toContain('2031');
  });
});

describe('TerminalModeTracker - input marks (terminal-inputs.ts)', () => {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

  it('hands over each input mark with where it ends in the chunk', () => {
    const t = new TerminalModeTracker();
    const chunk = `out\x1b]6791;ps\x07% ls\r\n\x1b]6791;cmd;${b64('ls')}\x1b\\tail`;
    t.feed(chunk);
    const marks = t.takeInputMarks();
    expect(marks).toEqual([
      { code: '6791', verb: 'ps', payload: undefined, end: chunk.indexOf('% ls') },
      { code: '6791', verb: 'cmd', payload: b64('ls'), end: chunk.indexOf('tail') },
    ]);
    // Taking clears them: the next chunk's indices are its own.
    expect(t.takeInputMarks()).toEqual([]);
  });

  it('completes a mark split across chunks in the chunk that ends it', () => {
    const mark = `\x1b]6791;done;0\x07`;
    for (let cut = 1; cut < mark.length; cut++) {
      const t = new TerminalModeTracker();
      t.feed(mark.slice(0, cut));
      expect(t.takeInputMarks()).toEqual([]);
      t.feed(`${mark.slice(cut)}x`);
      expect(t.takeInputMarks()).toEqual([
        { code: '6791', verb: 'done', payload: '0', end: mark.length - cut },
      ]);
    }
  });

  it('reads a prompt payload far past the title cap whole', () => {
    // A prompt mark carries ~5 KB of base64 - past OSC_COLLECT_MAX, like a tool marker.
    const payload = b64('p'.repeat(4000));
    const t = new TerminalModeTracker();
    t.feed(`\x1b]6791;prompt;${payload}\x07`);
    expect(t.takeInputMarks()[0].payload).toBe(payload);
  });

  it('passes on the agent-run verbs the input log needs, and no other status verb', () => {
    const t = new TerminalModeTracker();
    t.feed('\x1b]6790;ready\x07\x1b]6790;running\x07\x1b]6790;ended\x07');
    expect(t.takeInputMarks().map((m) => [m.code, m.verb])).toEqual([
      ['6790', 'ready'],
      ['6790', 'ended'],
    ]);
  });

  it('never arms marker mode on an input mark - a plain shell stays a plain shell', () => {
    // Any 6790 verb means "an agent speaks the protocol"; the shell
    // integration's 6791 marks must not switch its terminal off the fallback.
    const t = new TerminalModeTracker();
    t.feed('\x1b]6791;ps\x07\x1b]6791;done;0\x07');
    expect(t.markerDriven).toBeNull();
  });

  it('knows when the stream sits between sequences', () => {
    const t = new TerminalModeTracker();
    expect(t.atGround).toBe(true);
    t.feed('text\x1b[3');
    expect(t.atGround).toBe(false);
    t.feed('1m');
    expect(t.atGround).toBe(true);
  });
});
