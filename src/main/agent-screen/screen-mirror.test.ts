import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenMirrors } from './screen-mirror';

const marker = '\u001b]6790;ready\u0007';

type Core = { writeSync?: unknown; _inputHandler: { print: (...args: unknown[]) => void } };
/** The mirror's xterm core for a terminal (private - only to break its parser on purpose). */
function coreOf(m: ScreenMirrors, id: string): Core {
  const entries = (m as unknown as { entries: Map<string, { term: { _core: Core } | null }> })
    .entries;
  return entries.get(id)!.term!._core;
}
/** Make the mirror's next `print` throw, the way xterm 6.0.0's did in the field. */
function breakNextPrint(m: ScreenMirrors, id: string): void {
  const handler = coreOf(m, id)._inputHandler;
  const print = handler.print.bind(handler);
  let thrown = false;
  handler.print = (...args) => {
    if (!thrown) {
      thrown = true;
      throw new TypeError("Cannot read properties of undefined (reading 'setCellFromCodepoint')");
    }
    print(...args);
  };
}

describe('ScreenMirrors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mirrors a terminal only once it speaks the status markers, from what came before', async () => {
    const m = new ScreenMirrors();
    m.resize('t', 40, 4);
    m.data('t', '$ claude\r\n');
    expect(m.lines('t')).toBeNull();
    m.data('t', `${marker}❯ \r\n ⏸ plan mode on`);
    await m.settled('t');
    expect(m.lines('t')).toEqual(['$ claude', '❯ ', ' ⏸ plan mode on', '']);
  });

  it('starts over from an adopt snapshot, at its size', async () => {
    const m = new ScreenMirrors();
    m.data('t', `${marker}old text`);
    m.snapshot('t', `${marker}\u001b[2J\u001b[Hfresh screen`, 20, 2);
    await m.settled('t');
    expect(m.lines('t')).toEqual(['fresh screen', '']);
  });

  it('never parses a plain shell, and keeps only a bounded tail of it', () => {
    const m = new ScreenMirrors();
    for (let i = 0; i < 2000; i++) m.data('t', 'x'.repeat(1000));
    expect(m.lines('t')).toBeNull();
    m.forget('t');
    expect(m.lines('t')).toBeNull();
  });

  it('rebuilds a mirrored terminal from an adopt snapshot that no longer holds a marker', async () => {
    const m = new ScreenMirrors();
    m.data('t', `${marker}first`);
    // A window reloads: the ring's few seconds of repaints hold no marker.
    m.snapshot('t', '\u001b[2J\u001b[H❯ 1. Yes, auto-accept edits', 40, 3);
    await m.settled('t');
    expect(m.lines('t')?.[0]).toBe('❯ 1. Yes, auto-accept edits');
  });

  it('finds a marker split across two chunks', async () => {
    const m = new ScreenMirrors();
    m.data('t', 'x\u001b]67');
    m.data('t', '90;ready\u0007hi');
    await m.settled('t');
    expect(m.lines('t')?.[0]).toBe('xhi');
  });

  it('rebuilds a copy started at the wrong size when a view starts following', async () => {
    const m = new ScreenMirrors();
    // The marker came before any size was known: 80x24.
    m.data('t', `${marker}${'─'.repeat(100)}`);
    m.follow('t', { data: `${marker}\u001b[H${'─'.repeat(100)}`, cols: 120, rows: 3 });
    await m.settled('t');
    expect(m.lines('t')?.[0]).toBe('─'.repeat(100));
  });

  it("parses in the caller's stack, so a parser fault reaches the mirror and not the event loop", () => {
    const m = new ScreenMirrors();
    m.resize('t', 20, 2);
    m.data('t', `${marker}now`);
    // No settled(): xterm's own write parses on a timer, where a throw is
    // uncaught (crash report 157343098) and stalls its queue for good.
    expect(m.lines('t')?.[0]).toBe('now');
    // The sync entry point is xterm-internal: an upgrade that drops it must fail here.
    expect(typeof coreOf(m, 't').writeSync).toBe('function');
  });

  it('settles while output keeps arriving, and parses every chunk', async () => {
    // xterm's queued write ('' + a callback) and its sync write share one
    // queue: a chunk parsed sync before the queued write's timer stopped at
    // the falsy '' and the timer then cleared the queue - the callback never
    // ran and the chunk was never parsed. A working agent repaints all the
    // time, so a prompt sent while awaiting `settled` hung for good.
    const m = new ScreenMirrors();
    m.resize('t', 20, 3);
    m.data('t', `${marker}one\r\n`);
    const settled = m.settled('t');
    m.data('t', 'two');
    const outcome = await Promise.race([
      settled.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(outcome).toBe('settled');
    expect(m.lines('t')).toEqual(['one', 'two', '']);
  });

  it('rebuilds the copy from the tail when the parser faults mid-stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new ScreenMirrors();
    m.resize('t', 20, 3);
    m.data('t', `${marker}first\r\n`);
    breakNextPrint(m, 't');
    expect(() => m.data('t', 'second')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.lines('t')).toEqual(['first', 'second', '']);
    // The rebuilt copy keeps following the stream.
    m.data('t', '\r\nthird');
    await m.settled('t');
    expect(m.lines('t')).toEqual(['first', 'second', 'third']);
  });

  it('goes without a copy when the seed itself faults, until the next snapshot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new ScreenMirrors();
    m.resize('t', 20, 2);
    m.data('t', `${marker}a`);
    breakNextPrint(m, 't');
    // Fault mid-stream, then the rebuild's seed faults too.
    const proto = Object.getPrototypeOf(coreOf(m, 't')._inputHandler) as Core['_inputHandler'];
    const print = vi.spyOn(proto, 'print').mockImplementation(() => {
      throw new TypeError('broken');
    });
    expect(() => m.data('t', 'b')).not.toThrow();
    expect(m.lines('t')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    print.mockRestore();
    m.snapshot('t', '\u001b[Hrecovered', 20, 2);
    expect(m.lines('t')?.[0]).toBe('recovered');
  });
});
