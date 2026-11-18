import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NO_BUSY,
  busySummary,
  countBusyTerminals,
  planQuitConfirm,
  remoteNote,
  quitMayNeedConfirm,
  quitStopsSessions,
  type BusyCounts,
  type BusyProbe,
  planRuntimeQuitConfirm,
} from './quit-confirm';

/**
 * The quit confirm (a private plan › Quit): which quits ask,
 * what they say, and how the busy count is read off the terminal backend.
 */

const busy = (b: Partial<BusyCounts>): BusyCounts => ({ ...NO_BUSY, ...b });

describe('quitStopsSessions', () => {
  it('is the menu item, or the Keep-running switch off', () => {
    expect(quitStopsSessions({ stopRequested: false, keepRunning: true })).toBe(false);
    expect(quitStopsSessions({ stopRequested: true, keepRunning: true })).toBe(true);
    expect(quitStopsSessions({ stopRequested: false, keepRunning: false })).toBe(true);
  });
});

describe('quitMayNeedConfirm', () => {
  const user = (liveTerminals: number) => ({ liveTerminals, systemEnding: false });

  it('holds only a stopping quit with a live terminal - a held quit cancels a logout on macOS', () => {
    // Holding is `preventDefault` in `before-quit`, which the system takes as
    // a refusal: with the switch off and no terminal open, every logout was
    // cancelled for a question that had nothing to ask (2026-10-04).
    expect(quitMayNeedConfirm({ stopRequested: false, keepRunning: false }, user(0))).toBe(false);
    expect(quitMayNeedConfirm({ stopRequested: true, keepRunning: true }, user(0))).toBe(false);
    expect(quitMayNeedConfirm({ stopRequested: false, keepRunning: false }, user(1))).toBe(true);
    expect(quitMayNeedConfirm({ stopRequested: true, keepRunning: true }, user(2))).toBe(true);
    expect(quitMayNeedConfirm({ stopRequested: false, keepRunning: true }, user(5))).toBe(false);
  });

  it('never holds a quit the OS asked for - a logout, restart or shutdown proceeds with the setting as it stands', () => {
    // Keep-running off and a busy agent: the user's own quit asks; the
    // system's quit must not cancel the logout to ask a question nobody will
    // answer (user decision 2026-10-04).
    const ending = { liveTerminals: 3, systemEnding: true };
    expect(quitMayNeedConfirm({ stopRequested: false, keepRunning: false }, ending)).toBe(false);
    expect(quitMayNeedConfirm({ stopRequested: true, keepRunning: true }, ending)).toBe(false);
    // The intent itself is untouched: the switch off still means stop.
    expect(quitStopsSessions({ stopRequested: false, keepRunning: false })).toBe(true);
  });
});

describe('planQuitConfirm', () => {
  it('never asks when the quit keeps the sessions, however busy they are', () => {
    expect(
      planQuitConfirm(
        { stopRequested: false, keepRunning: true },
        busy({ working: 3, waiting: 2, shells: 1 }),
      ),
    ).toBeNull();
  });

  it('never asks when nothing is busy', () => {
    expect(planQuitConfirm({ stopRequested: true, keepRunning: true }, NO_BUSY)).toBeNull();
    expect(planQuitConfirm({ stopRequested: false, keepRunning: false }, NO_BUSY)).toBeNull();
  });

  it('"Quit and Stop All Sessions" confirms with Cancel as the safe default and no third way', () => {
    const plan = planQuitConfirm(
      { stopRequested: true, keepRunning: true },
      busy({ working: 2, waiting: 1 }),
    )!;
    expect(plan.message).toBe('Stop all sessions and quit?');
    expect(plan.detail).toBe(
      '2 agents are still working and 1 is waiting on you. Quitting this way ends every shell and agent on this machine; each session resumes its conversation the next time its tab starts.',
    );
    expect(plan.buttons).toEqual(['Stop sessions and quit', 'Cancel']);
    expect(plan.choices).toEqual(['proceed', 'cancel']);
    // Enter must not end anything: Cancel is both the default and the Escape
    // button (the design made the stop the default - deliberately not followed).
    expect(plan.buttons[plan.defaultId]).toBe('Cancel');
    expect(plan.cancelId).toBe(plan.defaultId);
  });

  it('never counts a remote terminal as busy, only names what keeps running on each host', () => {
    // A quit stops nothing on a host (spec 16): remote terminals alone ask nothing.
    expect(
      planQuitConfirm(
        { stopRequested: true, keepRunning: true },
        { ...NO_BUSY, remote: [{ label: 'build-box', terminals: 3 }] },
      ),
    ).toBeNull();
    const plan = planQuitConfirm(
      { stopRequested: true, keepRunning: true },
      { ...busy({ working: 1 }), remote: [{ label: 'build-box', terminals: 1 }] },
    )!;
    expect(plan.detail.endsWith(' 1 terminal on build-box keeps running there.')).toBe(true);
    expect(
      remoteNote([
        { label: 'build-box', terminals: 2 },
        { label: 'Build two', terminals: 1 },
        { label: 'idle', terminals: 0 },
      ]),
    ).toBe(' 2 terminals on build-box and 1 terminal on Build two keep running there.');
    expect(remoteNote(undefined)).toBe('');
  });

  it('a plain quit with Keep-running off also offers to keep the sessions this once', () => {
    const plan = planQuitConfirm(
      { stopRequested: false, keepRunning: false },
      busy({ working: 1 }),
    )!;
    expect(plan.message).toBe('Quit while sessions are busy?');
    expect(plan.detail).toBe(
      '1 agent is still working. Keep sessions running after quit is off, so quitting ends them - or keep them running this once and every tab picks its terminal up again on the next launch.',
    );
    expect(plan.buttons).toEqual([
      'Keep them running and quit',
      'Stop sessions and quit',
      'Cancel',
    ]);
    expect(plan.choices).toEqual(['keep-once', 'proceed', 'cancel']);
    // Return takes the way out that ends nothing; Escape cancels.
    expect(plan.choices[plan.defaultId]).toBe('keep-once');
    expect(plan.buttons[plan.cancelId]).toBe('Cancel');
  });

  it('"Restart to update" asks the same question with the restart verbs', () => {
    const plan = planQuitConfirm(
      { stopRequested: false, keepRunning: false, action: 'restart' },
      busy({ working: 1, shells: 1 }),
    )!;
    expect(plan.message).toBe('Restart while sessions are busy?');
    expect(plan.detail).toContain('so restarting ends them - or keep them running this once');
    expect(plan.buttons).toEqual([
      'Keep them running and restart',
      'Stop sessions and restart',
      'Cancel',
    ]);
  });

  it('the menu item through a restart is not a case - but the verbs would follow', () => {
    const plan = planQuitConfirm(
      { stopRequested: true, keepRunning: false, action: 'restart' },
      busy({ shells: 2 }),
    )!;
    expect(plan.message).toBe('Stop all sessions and restart?');
    expect(plan.buttons[0]).toBe('Stop sessions and restart');
  });
});

describe('busySummary', () => {
  it('words each bucket with its own count and number', () => {
    expect(busySummary(busy({ working: 1 }))).toBe('1 agent is still working');
    expect(busySummary(busy({ working: 2 }))).toBe('2 agents are still working');
    expect(busySummary(busy({ waiting: 1 }))).toBe('1 agent is waiting on you');
    expect(busySummary(busy({ waiting: 2 }))).toBe('2 agents are waiting on you');
    expect(busySummary(busy({ shells: 1 }))).toBe('1 shell is still running a command');
    expect(busySummary(busy({ shells: 3 }))).toBe('3 shells are still running a command');
  });

  it('joins the buckets as one sentence, the waiting count dropping its noun after the working one', () => {
    expect(busySummary(busy({ working: 2, waiting: 1 }))).toBe(
      '2 agents are still working and 1 is waiting on you',
    );
    expect(busySummary(busy({ waiting: 1, shells: 2 }))).toBe(
      '1 agent is waiting on you and 2 shells are still running a command',
    );
    expect(busySummary(busy({ working: 2, waiting: 1, shells: 1 }))).toBe(
      '2 agents are still working, 1 is waiting on you and 1 shell is still running a command',
    );
  });

  it('never uses a dash where the copy rule wants a hyphen', () => {
    // Spelled by code point so this file itself carries no dash character.
    const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    expect(busySummary(busy({ working: 1, waiting: 1, shells: 1 }))).not.toMatch(dashes);
    const plan = planQuitConfirm(
      { stopRequested: false, keepRunning: false },
      busy({ shells: 1 }),
    )!;
    expect(`${plan.message} ${plan.detail} ${plan.buttons.join(' ')}`).not.toMatch(dashes);
  });
});

describe('countBusyTerminals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function probe(
    verdicts: Record<string, 'running' | 'needs-input' | 'idle'>,
    foreground: Record<string, boolean>,
  ): BusyProbe & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      agentStatus: async (ids) =>
        ids.filter((id) => id in verdicts).map((id) => ({ id, status: verdicts[id]! })),
      foregroundBusy: async (id) => {
        asked.push(id);
        return foreground[id] ?? false;
      },
    };
  }

  it('reads agents off their markers and shells off their foreground, never both for one terminal', async () => {
    const p = probe(
      { a: 'running', b: 'needs-input', c: 'idle' },
      // `c` is an idle Claude at its prompt: `claude` IS in the foreground,
      // which must not make it a busy shell. `d` is `pnpm dev`, `e` an idle zsh.
      { c: true, d: true, e: false },
    );
    expect(await countBusyTerminals(['a', 'b', 'c', 'd', 'e'], p)).toEqual({
      working: 1,
      waiting: 1,
      shells: 1,
    });
    expect(p.asked).toEqual(['d', 'e']);
  });

  it('counts nothing for no terminals without touching the backend', async () => {
    const p = probe({}, {});
    const agentStatus = vi.fn(p.agentStatus);
    expect(await countBusyTerminals([], { ...p, agentStatus })).toEqual(NO_BUSY);
    expect(agentStatus).not.toHaveBeenCalled();
  });

  it('treats a backend that fails or hangs as nothing busy - the quit must not wait on it', async () => {
    const failing: BusyProbe = {
      agentStatus: async () => {
        throw new Error('socket gone');
      },
      foregroundBusy: async () => true,
    };
    expect(await countBusyTerminals(['a'], failing)).toEqual(NO_BUSY);

    vi.useFakeTimers();
    const hanging: BusyProbe = {
      agentStatus: () => new Promise(() => {}),
      foregroundBusy: async () => true,
    };
    const result = countBusyTerminals(['a'], hanging, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(NO_BUSY);
  });

  it('a single shell that refuses the foreground question counts as idle, the rest still count', async () => {
    const p: BusyProbe = {
      agentStatus: async () => [],
      foregroundBusy: async (id) => {
        if (id === 'x') throw new Error('unknown id');
        return true;
      },
    };
    expect(await countBusyTerminals(['x', 'y'], p)).toEqual({ working: 0, waiting: 0, shells: 1 });
  });
});

describe('planRuntimeQuitConfirm (no session daemon - runtime agents run in the app)', () => {
  it('asks only when a runtime agent is busy, defaulting to Cancel', () => {
    expect(planRuntimeQuitConfirm({ working: 0, waiting: 0 }, 'gadget')).toBeNull();
    const plan = planRuntimeQuitConfirm({ working: 2, waiting: 1 }, 'gadget', 'restart');
    expect(plan).toMatchObject({
      message: 'Restart while gadgets are busy?',
      buttons: ['Stop them and restart', 'Cancel'],
      choices: ['proceed', 'cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    expect(plan!.detail).toMatch(/^2 gadget agents are still working and 1 is waiting on you\./);
  });
});
