import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  busyShellTabs,
  clearTerminalBusy,
  getTerminalBusy,
  getTerminalTabState,
  isTerminalKnown,
  markTerminalSeen,
  noteTerminalBell,
  noteTerminalCommitKey,
  noteTerminalFinished,
  noteTerminalInterrupted,
  noteTerminalOutput,
  noteTerminalReady,
  seedTerminalBusy,
  setTerminalBusy,
  subscribeTerminalBusy,
  useTerminalBusy,
  useTerminalBusyMap,
} from '@renderer/lib/terminal/busy';
import type { Tab } from '@renderer/lib/workspace/layout';

// Mirror STATUS_IDLE_MS / SETTLE_MS in session-status.ts.
const IDLE_MS = 8_000;
const SETTLE_MS = 1_000;

let seq = 0;
let pty: string;

beforeEach(() => {
  vi.useFakeTimers();
  pty = `pty-${++seq}`; // fresh id per test - the registry is module-level
});

afterEach(() => {
  clearTerminalBusy(pty);
  vi.useRealTimers();
});

describe('marker-driven ptys', () => {
  it('follows the markers exactly, with no quiet-window decay', () => {
    setTerminalBusy(pty, 'running');
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(getTerminalBusy(pty)).toBe('running');
    setTerminalBusy(pty, 'needs-input');
    expect(getTerminalBusy(pty)).toBe('needs-input');
    setTerminalBusy(pty, null);
    expect(getTerminalBusy(pty)).toBe(null);
  });

  it('a marker retires any pending fallback settle', () => {
    noteTerminalOutput(pty);
    setTerminalBusy(pty, 'needs-input');
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(getTerminalBusy(pty)).toBe('needs-input');
  });

  it('a commit keystroke lifts needs-input optimistically', () => {
    setTerminalBusy(pty, 'needs-input');
    noteTerminalCommitKey(pty, true);
    expect(getTerminalBusy(pty)).toBe('running');
    // No fallback timer was armed - only the agent's next marker moves it.
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(getTerminalBusy(pty)).toBe('running');
  });

  it('an interrupt clears a working or waiting tab without a finished mark', () => {
    // The user stopped the turn: nothing finished, so nothing to look at.
    setTerminalBusy(pty, 'running');
    noteTerminalInterrupted(pty);
    expect(getTerminalBusy(pty)).toBe(null);
    setTerminalBusy(pty, 'needs-input');
    noteTerminalInterrupted(pty);
    expect(getTerminalBusy(pty)).toBe(null);
  });

  it('an interrupt leaves a finished mark for the user', () => {
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    noteTerminalInterrupted(pty);
    expect(getTerminalTabState(pty)).toBe('finished');
  });
});

describe('markerless (fallback) ptys', () => {
  it('output marks running, and quiet settles it after the idle window', () => {
    noteTerminalOutput(pty);
    expect(getTerminalBusy(pty)).toBe('running');
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(getTerminalBusy(pty)).toBe('running');
    vi.advanceTimersByTime(2);
    expect(getTerminalBusy(pty)).toBe(null);
  });

  it('continued output keeps re-arming the idle window', () => {
    noteTerminalOutput(pty);
    vi.advanceTimersByTime(IDLE_MS - 1);
    noteTerminalOutput(pty);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(getTerminalBusy(pty)).toBe('running');
  });

  it('a bell settles to needs-input after the short settle window', () => {
    noteTerminalOutput(pty);
    noteTerminalBell(pty);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(getTerminalBusy(pty)).toBe('needs-input');
  });

  it('needs-input is sticky: output alone never clears the verdict', () => {
    noteTerminalBell(pty);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    noteTerminalOutput(pty); // a blocked TUI repainting
    expect(getTerminalBusy(pty)).toBe('needs-input');
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(getTerminalBusy(pty)).toBe('needs-input');
  });

  it('a commit keystroke lifts needs-input, then quiet settles to idle', () => {
    noteTerminalBell(pty);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    noteTerminalCommitKey(pty, false);
    expect(getTerminalBusy(pty)).toBe('running');
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(getTerminalBusy(pty)).toBe(null);
  });

  it('a commit keystroke on a not-blocked pty changes nothing', () => {
    noteTerminalOutput(pty);
    noteTerminalCommitKey(pty, false);
    expect(getTerminalBusy(pty)).toBe('running');
  });

  it('exit clears everything, including a pending bell verdict', () => {
    noteTerminalBell(pty);
    clearTerminalBusy(pty);
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(getTerminalBusy(pty)).toBe(null);
  });
});

describe('busyShellTabs', () => {
  it('lists only busy shell tabs, in order, skipping editors', () => {
    const other = `pty-${++seq}`;
    setTerminalBusy(pty, 'needs-input');
    noteTerminalOutput(other);
    const tabs: Tab[] = [
      { id: 't1', kind: 'conversation', title: 'Claude Code', ptyId: pty },
      { id: 't2', kind: 'editor', title: 'auth.ts', filePath: '/x/auth.ts' },
      { id: 't3', kind: 'terminal', title: 'Terminal 2', ptyId: other },
      { id: 't4', kind: 'terminal', title: 'Terminal 3', ptyId: `pty-${++seq}` },
    ];
    expect(busyShellTabs(tabs)).toEqual([
      { title: 'Claude Code', status: 'needs-input' },
      { title: 'Terminal 2', status: 'running' },
    ]);
    clearTerminalBusy(other);
  });
});

describe("reactivity (the tab strips' live band)", () => {
  it('notifies subscribers on a change, not on a write that changes nothing', () => {
    const seen = vi.fn();
    const off = subscribeTerminalBusy(seen);
    setTerminalBusy(pty, 'running');
    expect(seen).toHaveBeenCalledTimes(1);
    setTerminalBusy(pty, 'running');
    expect(seen).toHaveBeenCalledTimes(1);
    setTerminalBusy(pty, null);
    expect(seen).toHaveBeenCalledTimes(2);
    clearTerminalBusy(pty); // already clear - silent
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    setTerminalBusy(pty, 'needs-input');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('useTerminalBusy follows one pty and reads null for none', () => {
    const { result } = renderHook(() => useTerminalBusy(pty));
    expect(result.current).toBe(null);
    act(() => setTerminalBusy(pty, 'running'));
    expect(result.current).toBe('running');
    act(() => setTerminalBusy(pty, 'needs-input'));
    expect(result.current).toBe('needs-input');
    act(() => clearTerminalBusy(pty));
    expect(result.current).toBe(null);
    expect(renderHook(() => useTerminalBusy(undefined)).result.current).toBe(null);
  });

  it('useTerminalBusyMap hands out a fresh map per change, including fallback settles', () => {
    const { result } = renderHook(useTerminalBusyMap);
    const before = result.current;
    act(() => noteTerminalOutput(pty));
    expect(result.current).not.toBe(before);
    expect(result.current.get(pty)).toBe('running');
    const during = result.current;
    act(() => vi.advanceTimersByTime(IDLE_MS + 1));
    expect(result.current).not.toBe(during);
    // The settle no longer drops the entry: a running tab going quiet keeps
    // the finished-unseen mark until the user views the tab.
    expect(result.current.get(pty)).toBe('finished');
  });
});

describe('the finished-unseen tab mark', () => {
  it('marks a busy tab finished when its agent stops', () => {
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    expect(getTerminalTabState(pty)).toBe('finished');
  });

  it('marks a tab that was waiting on input too - its stop is just as unseen', () => {
    setTerminalBusy(pty, 'needs-input');
    noteTerminalFinished(pty);
    expect(getTerminalTabState(pty)).toBe('finished');
  });

  it('marks nothing on a tab that was not busy - no work, nothing finished', () => {
    noteTerminalFinished(pty);
    expect(getTerminalTabState(pty)).toBeNull();
  });

  it('is not busy: the close paths see null and warn about nothing', () => {
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    expect(getTerminalBusy(pty)).toBeNull();
    const tab = { id: 't1', kind: 'terminal', title: 'Claude Code', ptyId: pty } as Tab;
    expect(busyShellTabs([tab])).toEqual([]);
  });

  it('clears only when seen, and seeing a busy tab clears nothing', () => {
    setTerminalBusy(pty, 'running');
    markTerminalSeen(pty);
    expect(getTerminalBusy(pty)).toBe('running');
    noteTerminalFinished(pty);
    markTerminalSeen(pty);
    expect(getTerminalTabState(pty)).toBeNull();
  });

  it('a markerless tab going quiet after running earns the mark too', () => {
    noteTerminalOutput(pty);
    vi.advanceTimersByTime(IDLE_MS);
    expect(getTerminalTabState(pty)).toBe('finished');
  });

  it('a bell verdict still settles to needs-input, not finished', () => {
    noteTerminalOutput(pty);
    noteTerminalBell(pty);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(getTerminalBusy(pty)).toBe('needs-input');
  });

  it("'ready' retires a stale busy state but keeps the user's unseen mark", () => {
    setTerminalBusy(pty, 'running');
    noteTerminalReady(pty);
    expect(getTerminalTabState(pty)).toBeNull();
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    noteTerminalReady(pty);
    expect(getTerminalTabState(pty)).toBe('finished');
  });

  it('exit clears the mark with everything else', () => {
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    clearTerminalBusy(pty);
    expect(getTerminalTabState(pty)).toBeNull();
  });

  it('work starting again replaces the mark', () => {
    setTerminalBusy(pty, 'running');
    noteTerminalFinished(pty);
    setTerminalBusy(pty, 'running');
    expect(getTerminalTabState(pty)).toBe('running');
  });
});

describe('what this window knows', () => {
  // The session-level recheck after a tab closes (session/status.ts) must not
  // call a terminal idle just because this window has heard nothing from it -
  // a freshly loaded window knows nothing about a parked agent.
  it('knows nothing about a pty until it reports', () => {
    expect(isTerminalKnown(pty)).toBe(false);
  });

  it('output, a bell, a marker, a stop, a launch or an exit each count as evidence', () => {
    const ids = ['out', 'bell', 'marker', 'stop', 'ready', 'exit'].map((k) => `${pty}-${k}`);
    noteTerminalOutput(ids[0]);
    noteTerminalBell(ids[1]);
    setTerminalBusy(ids[2], null);
    noteTerminalFinished(ids[3]);
    noteTerminalReady(ids[4]);
    clearTerminalBusy(ids[5]);
    for (const id of ids) expect(isTerminalKnown(id)).toBe(true);
    for (const id of ids) clearTerminalBusy(id); // retire the fallback timers
  });

  it('viewing a tab is not evidence', () => {
    markTerminalSeen(pty);
    expect(isTerminalKnown(pty)).toBe(false);
  });

  it('a keystroke into a pty is not evidence either', () => {
    noteTerminalCommitKey(pty, true);
    expect(isTerminalKnown(pty)).toBe(false);
  });
});

describe("main's reading of a pty this window never watched", () => {
  // A window that just loaded or adopted a tab (a reload, a tear-off) has
  // seen none of its markers; main read them all (terminal:agentStatus).

  it('lights a tab the window knew nothing about - and counts as evidence', () => {
    // The bug: an agent parked on a background subagent sends no marker for
    // minutes, so after a reload its tab sat unwashed with no dot.
    seedTerminalBusy(pty, 'running');
    expect(getTerminalTabState(pty)).toBe('running');
    expect(isTerminalKnown(pty)).toBe(true);
  });

  it('an idle reading is evidence too, with nothing to show', () => {
    seedTerminalBusy(pty, null);
    expect(getTerminalTabState(pty)).toBe(null);
    expect(isTerminalKnown(pty)).toBe(true);
  });

  it("never overrides the window's own marker evidence, which is newer", () => {
    // A marker that lands before main's answer wins - the answer is older.
    setTerminalBusy(pty, 'needs-input');
    seedTerminalBusy(pty, 'running');
    expect(getTerminalTabState(pty)).toBe('needs-input');
    noteTerminalFinished(pty);
    seedTerminalBusy(pty, 'running');
    expect(getTerminalTabState(pty)).toBe('finished');
  });

  it('replaces a fallback guess made before main said the pty speaks markers', () => {
    // A fresh window reads a Claude repaint as work until it learns the pty is
    // marker-driven; left alone, that guess settles to a false finished mark.
    noteTerminalOutput(pty);
    seedTerminalBusy(pty, 'needs-input');
    expect(getTerminalTabState(pty)).toBe('needs-input');
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(getTerminalTabState(pty)).toBe('needs-input');
  });
});
