import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanSignals, settleStatus, stopTarget } from '@renderer/lib/session/status';

// Build terminal control sequences without putting raw control chars in source.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('scanSignals', () => {
  it('detects a standalone attention bell', () => {
    expect(scanSignals('', `done${BEL}`)).toEqual({ markers: [], bell: true, carry: '' });
  });

  it('ignores a BEL that terminates an OSC window-title sequence', () => {
    // What a shell emits every prompt: ESC ] 0 ; <title> BEL - not an attention bell.
    expect(scanSignals('', `${ESC}]0;~/project${BEL}$ `)).toEqual({
      markers: [],
      bell: false,
      carry: '',
    });
  });

  it('ignores an OSC terminated by ST (ESC backslash) instead of BEL', () => {
    expect(scanSignals('', `${ESC}]0;title${ESC}\\$ `)).toEqual({
      markers: [],
      bell: false,
      carry: '',
    });
  });

  it('still finds a real bell that follows an OSC title', () => {
    expect(scanSignals('', `${ESC}]0;t${BEL}${BEL}`).bell).toBe(true);
  });

  it('carries an unterminated OSC span across chunks (a split title)', () => {
    const first = scanSignals('', `${ESC}]0;~/long-pa`);
    expect(first).toEqual({ markers: [], bell: false, carry: `${ESC}]0;~/long-pa` });
    const second = scanSignals(first.carry, `th${BEL}$ `);
    expect(second).toEqual({ markers: [], bell: false, carry: '' });
  });

  it('passes plain output through with no signal', () => {
    expect(scanSignals('', 'compiled in 184 ms\n')).toEqual({
      markers: [],
      bell: false,
      carry: '',
    });
  });

  it('detects the needs-input marker (BEL-terminated) without reading it as a bell', () => {
    expect(scanSignals('', `${ESC}]6790;needs-input${BEL}`)).toEqual({
      markers: [{ verb: 'needs-input' }],
      bell: false,
      carry: '',
    });
  });

  it('detects a marker terminated by ST', () => {
    expect(scanSignals('', `${ESC}]6790;needs-input${ESC}\\`).markers).toEqual([
      { verb: 'needs-input' },
    ]);
  });

  it('detects the running, finished, and ended lifecycle markers', () => {
    expect(scanSignals('', `${ESC}]6790;running${BEL}`).markers).toEqual([{ verb: 'running' }]);
    expect(scanSignals('', `${ESC}]6790;finished${BEL}`).markers).toEqual([{ verb: 'finished' }]);
    expect(scanSignals('', `${ESC}]6790;ended${BEL}`).markers).toEqual([{ verb: 'ended' }]);
  });

  it('detects a question marker and returns its payload verbatim', () => {
    expect(scanSignals('', `${ESC}]6790;question;eyJhIjoxfQ==${BEL}`).markers).toEqual([
      { verb: 'question', payload: 'eyJhIjoxfQ==' },
    ]);
  });

  it('returns multiple markers in stream order', () => {
    const data = `${ESC}]6790;finished${BEL}…${ESC}]6790;running${BEL}`;
    expect(scanSignals('', data).markers).toEqual([{ verb: 'finished' }, { verb: 'running' }]);
  });

  it('finds a marker amid surrounding output', () => {
    const data = `rendering…${ESC}]6790;needs-input${BEL}`;
    expect(scanSignals('', data).markers).toEqual([{ verb: 'needs-input' }]);
  });

  it('carries a split marker across chunks', () => {
    const first = scanSignals('', `${ESC}]6790;need`);
    expect(first.markers).toEqual([]);
    expect(first.carry).toBe(`${ESC}]6790;need`);
    expect(scanSignals(first.carry, `s-input${BEL}`).markers).toEqual([{ verb: 'needs-input' }]);
  });

  it('carries a question payload split across chunks intact', () => {
    const payload = 'A'.repeat(5000); // near the hook script's 6000-char cap
    const first = scanSignals('', `${ESC}]6790;question;${payload.slice(0, 2500)}`);
    expect(first.markers).toEqual([]);
    const second = scanSignals(first.carry, `${payload.slice(2500)}${BEL}`);
    expect(second.markers).toEqual([{ verb: 'question', payload }]);
  });

  it('ignores an unknown verb on our OSC code (forward compatibility)', () => {
    expect(scanSignals('', `${ESC}]6790;discombobulate${BEL}`)).toEqual({
      markers: [],
      bell: false,
      carry: '',
    });
  });

  it('ignores an unrelated private OSC code', () => {
    expect(scanSignals('', `${ESC}]6791;needs-input${BEL}`).markers).toEqual([]);
  });
});

describe('stopTarget', () => {
  it('lands a watched stop on idle', () => {
    expect(stopTarget('active', true)).toBe('idle');
    expect(stopTarget('needs-input', true)).toBe('idle');
  });

  it('lands an unwatched stop on the finished-unseen mark', () => {
    expect(stopTarget('active', false)).toBe('finished');
    expect(stopTarget('needs-input', false)).toBe('finished');
  });

  it('never moves a session that was not running or waiting', () => {
    // In particular an existing 'finished' mark: a later idle verdict (the
    // agent exiting after its turn, a quiet window) must not wipe the unseen
    // mark before the user looked.
    for (const status of ['idle', 'finished', 'done', 'archived']) {
      expect(stopTarget(status, true)).toBeNull();
      expect(stopTarget(status, false)).toBeNull();
    }
  });
});

describe('settleStatus', () => {
  it('is needs-input when that verdict is pending (agent blocked on you)', () => {
    expect(settleStatus('needs-input')).toBe('needs-input');
  });

  it('is idle when a finished marker set the verdict', () => {
    expect(settleStatus('idle')).toBe('idle');
  });

  it('is idle when nothing is pending - a finished/parked agent is not needs-input', () => {
    expect(settleStatus(null)).toBe('idle');
  });
});

// --- observeSessionStatus -----------------------------------------------------

/** A hook marker as the injected agent scripts emit it. */
const marker = (verb: string, payload?: string): string =>
  `${ESC}]6790;${verb}${payload ? `;${payload}` : ''}${BEL}`;

const SESSION = 'session-1';
const IDLE_MS = 8_000;
const SETTLE_MS = 1_000;

type Status = 'idle' | 'active' | 'needs-input' | 'finished' | 'done' | 'archived';

const { collection, signalStatusChange, watched } = vi.hoisted(() => {
  const rows = new Map<
    string,
    { id: string; status: string; agent: string; label: string; runtime?: string | null }
  >();
  type Change = { key: string; type: 'insert' | 'update' | 'delete'; value: { status: string } };
  const listeners = new Set<(changes: Change[]) => void>();
  const emit = (id: string) => {
    const row = rows.get(id);
    if (row) for (const l of [...listeners]) l([{ key: id, type: 'update', value: { ...row } }]);
  };
  return {
    collection: {
      rows,
      listeners,
      get: (id: string) => rows.get(id),
      update: (id: string, mutate: (draft: { status: string }) => void) => {
        const row = rows.get(id);
        if (row) {
          mutate(row);
          emit(id);
        }
      },
      subscribeChanges: (cb: (changes: Change[]) => void) => {
        listeners.add(cb);
        return { unsubscribe: () => listeners.delete(cb) };
      },
      /** A write from main (db:change) landing in the collection. */
      mainWrites: (id: string, status: string) => {
        const row = rows.get(id);
        if (row) {
          row.status = status;
          emit(id);
        }
      },
    },
    signalStatusChange: vi.fn(),
    // Whether the observed session counts as on screen in a focused window -
    // the fact that routes a stop to 'idle' (watched) or 'finished' (away).
    // Defaults to watched so the settle-mechanics tests below stay about
    // settling; the finished-unseen block flips it.
    watched: { value: true },
  };
});

vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: collection }));
vi.mock('@renderer/lib/session/status-alerts', () => ({ signalStatusChange }));
vi.mock('@renderer/lib/session/attention', () => ({
  isSessionWatched: () => watched.value,
}));

/** Terminal activity/exit callbacks the observer registered, keyed by pty id. */
let activity: Map<string, (data: string) => void>;
let activityExit: Map<string, () => void>;
let offCalls: number;
/** What main reports as launched-with-hooks (terminal:markerDriven). */
let markerDrivenIds: string[] = [];

/** Fresh module copy per test - `markerPtys` is module-level and would leak. */
async function loadModule(): Promise<typeof import('@renderer/lib/session/status')> {
  vi.resetModules();
  // Core reads the session-view bridge through the extension's slot - install it in
  // the registry the fresh module copy imports.
  const { installRendererExtension } = await import('@renderer/lib/extension/registry');
  const { bridgeSlots } = await import('@renderer/test-support');
  installRendererExtension(bridgeSlots());
  return import('@renderer/lib/session/status');
}

function seedSession(status: Status = 'idle'): void {
  collection.rows.clear();
  collection.rows.set(SESSION, { id: SESSION, status, agent: 'claude', label: 'Fix flaky tests' });
}

beforeEach(() => {
  vi.useFakeTimers();
  activity = new Map();
  activityExit = new Map();
  offCalls = 0;
  markerDrivenIds = [];
  signalStatusChange.mockClear();
  watched.value = true;
  seedSession('idle');
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      terminal: {
        onActivity: (ptyId: string, cb: (data: string) => void) => {
          activity.set(ptyId, cb);
          return () => {
            offCalls += 1;
          };
        },
        onActivityExit: (ptyId: string, cb: () => void) => {
          activityExit.set(ptyId, cb);
          return () => {
            offCalls += 1;
          };
        },
        markerDriven: async (): Promise<string[]> => markerDrivenIds,
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const statusOf = (): string | undefined => collection.rows.get(SESSION)?.status;
const emit = (ptyId: string, data: string): void => activity.get(ptyId)!(data);

describe('observeSessionStatus - no shells', () => {
  it('settles a lingering status to idle when every tab is gone', async () => {
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, []);
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).toHaveBeenCalledWith(SESSION, 'active', 'idle');
  });

  it('leaves an archived session archived', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, []);
    expect(statusOf()).toBe('archived');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('does nothing when the session is already idle', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, []);
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('is inert without a pty bridge', async () => {
    Object.defineProperty(window, 'api', { configurable: true, writable: true, value: {} });
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    expect(() => observeSessionStatus(SESSION, ['p1'])()).not.toThrow();
    expect(statusOf()).toBe('active');
  });
});

describe('observeSessionStatus - marker-driven (an agent that speaks the protocol)', () => {
  it('goes active on a running marker and needs-input on a needs-input marker', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);

    emit('p1', marker('running'));
    expect(statusOf()).toBe('active');

    emit('p1', marker('needs-input'));
    expect(statusOf()).toBe('needs-input');
  });

  it('goes idle on a finished marker', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');
  });

  it('ignores output entirely once a marker has arrived', async () => {
    // The whole point of the marker protocol: a TUI repainting must not read as
    // the agent working, and its own bell must not read as needs-input.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('needs-input'));

    // Assert after EACH step: checking only the end state hides a wrong
    // intermediate (output flipping to active, then a bell flipping back).
    emit('p1', 'a wall of repainted TUI output');
    expect(statusOf(), 'output must not make a marker-driven session active').toBe('needs-input');

    emit('p1', BEL);
    expect(statusOf(), 'a bell must not re-decide a marker-driven session').toBe('needs-input');

    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(statusOf(), 'no fallback timer may run in marker mode').toBe('needs-input');
  });

  it('does not let output revive a marker-driven session that finished', async () => {
    // The inverse of the above: after 'finished' the session is idle, and a
    // trailing repaint must not read as the agent working again.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');

    emit('p1', 'trailing output after the turn ended');
    expect(statusOf()).toBe('idle');
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('idle');
  });

  it('cancels a pending fallback timer when the first marker lands', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'plain output'); // fallback: active + idle timer armed
    expect(statusOf()).toBe('active');

    emit('p1', marker('needs-input'));
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('needs-input');
  });

  it('falls back to quiet-timer rules after an ended marker', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('ended'));
    expect(statusOf()).toBe('idle');

    // Back in fallback mode: output means working again.
    vi.advanceTimersByTime(5_000); // past the post-'ended' suppression window
    emit('p1', 'the shell prompt, then a build');
    expect(statusOf()).toBe('active');
  });

  it('stays marker-driven across a /clear (ended immediately followed by finished)', async () => {
    // Claude's `/clear` fires SessionEnd (→ 'ended') and then SessionStart
    // (→ 'finished' via the injected hook). The 'ended' drops the pty to
    // fallback; the 'finished' must re-arm marker mode so the idle-prompt bell
    // Claude rings ~60s later (terminal_bell channel) is ignored like any other
    // bell in marker mode - instead of settling to needs-input as fallback would.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');
    emit('p1', marker('ended'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');
    // Neither transition fired an alert: idle → idle is a no-op.
    expect(signalStatusChange).not.toHaveBeenCalledWith(SESSION, 'idle', 'idle');

    emit('p1', BEL);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('idle');
  });

  it('follows a turn tool by tool and leaves its summary as the session detail', async () => {
    const { observeSessionStatus } = await loadModule();
    const { getSessionActivity } = await import('@renderer/lib/session/activity');
    const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    expect(statusOf()).toBe('active');
    expect(getSessionActivity(SESSION)).toMatchObject({ turnOpen: true, current: null });

    emit('p1', marker('tool-start', b64('Edit\n/repo/src/token.service.ts\n')));
    expect(getSessionActivity(SESSION)?.current).toEqual({
      tool: 'Edit',
      arg: '/repo/src/token.service.ts',
    });
    emit('p1', marker('tool-done', b64('Edit\n/repo/src/token.service.ts\n')));
    emit('p1', marker('tool-done', b64('Bash\npnpm test\n')));
    expect(getSessionActivity(SESSION)).toMatchObject({
      editedFiles: ['/repo/src/token.service.ts'],
      commands: 1,
    });

    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');
    expect(collection.rows.get(SESSION)).toMatchObject({ detail: 'Finished - 1 file edited' });
    // Nothing is live any more.
    expect(getSessionActivity(SESSION)).toBeNull();
  });

  it('heals a sticky needs-input on a tool completing, and knows what was pending before', async () => {
    const { observeSessionStatus } = await loadModule();
    const { getSessionActivity } = await import('@renderer/lib/session/activity');
    const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    // PreToolUse, then the permission dialog (bare), then its late notification.
    emit('p1', marker('tool-start', b64('Bash\npnpm db:migrate\n')));
    emit('p1', marker('needs-input'));
    expect(statusOf()).toBe('needs-input');
    emit('p1', marker('needs-input', b64('Claude needs your permission')));
    expect(getSessionActivity(SESSION)).toMatchObject({
      current: { tool: 'Bash', arg: 'pnpm db:migrate' },
      waiting: 'Claude needs your permission',
    });
    // Approved: the tool runs to completion.
    emit('p1', marker('tool-done', b64('Bash\npnpm db:migrate\n')));
    expect(statusOf()).toBe('active');
    expect(getSessionActivity(SESSION)?.waiting).toBeNull();
  });

  it('keeps the last summary through a /clear and drops live activity when the agent goes', async () => {
    const { observeSessionStatus } = await loadModule();
    const { getSessionActivity } = await import('@renderer/lib/session/activity');
    collection.rows.get(SESSION)!.status = 'idle';
    (collection.rows.get(SESSION) as { detail?: string }).detail = 'Finished - 2 files edited';
    observeSessionStatus(SESSION, ['p1']);
    // `/clear`: ended, then SessionStart(clear) → finished - no turn was open.
    emit('p1', marker('ended'));
    emit('p1', marker('finished'));
    expect(collection.rows.get(SESSION)).toMatchObject({ detail: 'Finished - 2 files edited' });
    // A relaunch mid-turn: whatever was live is gone, the summary stays.
    emit('p1', marker('running'));
    emit('p1', marker('tool-start', Buffer.from('Read\na.ts\n').toString('base64')));
    emit('p1', marker('ready'));
    expect(getSessionActivity(SESSION)).toBeNull();
    expect(collection.rows.get(SESSION)).toMatchObject({ detail: 'Finished - 2 files edited' });
  });

  it('settles to needs-input on the idle bell if nothing re-arms marker mode after ended', async () => {
    // The failure mode the SessionStart(clear) hook exists to prevent - kept
    // as the documented contract of a bare 'ended': fallback rules apply.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    emit('p1', marker('ended'));
    emit('p1', BEL);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(statusOf()).toBe('needs-input');
  });

  it('treats a question marker as needs-input', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('question', btoa(JSON.stringify({ text: 'Proceed?' }))));
    expect(statusOf()).toBe('needs-input');
  });

  it('goes back to active on question-done', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('question', btoa(JSON.stringify({ text: 'Proceed?' }))));
    emit('p1', marker('question-done'));
    expect(statusOf()).toBe('active');
  });

  it('applies several markers in one chunk in order', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running') + marker('needs-input'));
    expect(statusOf()).toBe('needs-input');
  });
});

describe('observeSessionStatus - the user stopping the turn (Esc / Ctrl+C)', () => {
  /** The module graph loadModule() just reset, so the gate is status.ts's own copy. */
  async function load(): Promise<{
    observeSessionStatus: typeof import('@renderer/lib/session/status').observeSessionStatus;
    type: (ptyId: string, data: string) => void;
  }> {
    const { observeSessionStatus } = await loadModule();
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    return { observeSessionStatus, type: noteTerminalUserInput };
  }

  it('settles a cancelled prompt to idle quietly', async () => {
    // The bug: a prompt cancelled before its first reply fires
    // UserPromptSubmit (running) and then no hook at all - Stop does not fire
    // on an interrupt - so the session read "Working…" for good.
    const { observeSessionStatus, type } = await load();
    watched.value = false;
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    expect(statusOf()).toBe('active');
    signalStatusChange.mockClear();
    type('p1', ESC);
    // Quiet: nothing finished - no alert, and not the unseen mark even while
    // the session is off screen.
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('stops on Ctrl+C and on Esc at a permission prompt', async () => {
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    type('p1', String.fromCharCode(3));
    expect(statusOf()).toBe('idle');
    emit('p1', marker('running'));
    emit('p1', marker('needs-input'));
    type('p1', ESC);
    expect(statusOf()).toBe('idle');
  });

  it('never reads arrows, focus reports or Alt+key as a stop', async () => {
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    type('p1', `${ESC}[A`);
    type('p1', `${ESC}[I`);
    type('p1', `${ESC}OB`);
    type('p1', `${ESC}b`);
    type('p1', 'queued follow-up');
    expect(statusOf()).toBe('active');
  });

  it('heals a false stop on the next marker', async () => {
    // An Esc that only closed a menu mid-turn: the agent's next tool says so.
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    type('p1', ESC);
    expect(statusOf()).toBe('idle');
    emit('p1', marker('tool-start', btoa('Read\na.ts\n')));
    expect(statusOf()).toBe('active');
  });

  it('leaves an idle session alone', async () => {
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    signalStatusChange.mockClear();
    type('p1', ESC);
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('leaves a plain shell to the fallback rules', async () => {
    // A markerless shell running a build: Ctrl+C there is the quiet window's
    // business (the shell may keep printing), not a stop.
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'building…');
    expect(statusOf()).toBe('active');
    type('p1', String.fromCharCode(3));
    expect(statusOf()).toBe('active');
  });

  it('keeps the session working while another agent tab still is', async () => {
    const { observeSessionStatus, type } = await load();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('running'));
    emit('p2', marker('running'));
    type('p1', ESC);
    expect(statusOf()).toBe('active');
    type('p2', ESC);
    expect(statusOf()).toBe('idle');
  });
});

describe("observeSessionStatus - a subagent's tools (the Agent tool's worker)", () => {
  // Tool payloads as the hook script builds them: `<tool>\n<arg>\n` for the
  // main agent, a third line with the agent type for a subagent's call.
  const own = (tool: string, arg: string): string => btoa(`${tool}\n${arg}\n`);
  const sub = (tool: string, arg: string): string => btoa(`${tool}\n${arg}\ngeneral-purpose\n`);

  it('never lets a background subagent lift needs-input', async () => {
    // The bug: the main agent asked for permission while a background agent
    // it had launched ran on. The subagent's hooks fire in the same process,
    // into the same pty, and its next tool-done "healed" the needs-input -
    // the dialog was still up, and the row said running.
    const { observeSessionStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('tool-start', own('Bash', 'pnpm test')));
    emit('p1', marker('needs-input')); // the permission dialog for it
    expect(statusOf()).toBe('needs-input');
    emit('p1', marker('tool-start', sub('Read', '/repo/README.md')));
    emit('p1', marker('tool-done', sub('Read', '/repo/README.md')));
    expect(statusOf()).toBe('needs-input');
    expect(busy.getTerminalBusy('p1')).toBe('needs-input');
    // The main agent's own tool completing - the user approved it - does lift it.
    emit('p1', marker('tool-done', own('Bash', 'pnpm test')));
    expect(statusOf()).toBe('active');
    expect(busy.getTerminalBusy('p1')).toBe('running');
  });

  it("still counts a subagent's tool as work for a session that is not waiting", async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('ready'));
    expect(statusOf()).toBe('idle');
    emit('p1', marker('tool-start', sub('Grep', 'refreshToken')));
    expect(statusOf()).toBe('active');
  });
});

describe('observeSessionStatus - fallback mode (a plain shell)', () => {
  it('goes active on output and idle after the quiet window', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);

    emit('p1', 'running tests...');
    expect(statusOf()).toBe('active');

    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(statusOf()).toBe('active');
    vi.advanceTimersByTime(1);
    expect(statusOf()).toBe('idle');
  });

  it('re-arms the quiet window on every chunk', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'chunk one');
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    emit('p1', 'chunk two');
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    expect(statusOf()).toBe('active');
  });

  it('settles to needs-input promptly after an attention bell', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', BEL);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(statusOf()).toBe('needs-input');
  });

  it('does not read an OSC title terminator as a bell', async () => {
    // Shells emit `ESC ] 0 ; title BEL` on every prompt - treating that as an
    // attention bell would mark every idle shell as needs-input.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', `${ESC}]0;emmaw@mac: ~/code${BEL}`);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('idle');
  });

  it('keeps needs-input sticky while the TUI repaints', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', BEL);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(statusOf()).toBe('needs-input');

    emit('p1', 'a repaint that is not an answer');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(statusOf()).toBe('needs-input');
  });
});

describe('observeSessionStatus - shells exiting', () => {
  it('goes idle when the last shell exits', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'working');
    expect(statusOf()).toBe('active');

    activityExit.get('p1')!();
    expect(statusOf()).toBe('idle');
  });

  it('does not call the session idle while a sibling shell lives', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', 'working');
    activityExit.get('p1')!();
    expect(statusOf()).toBe('active');

    // The remaining tab has to prove quiet before the session settles.
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
  });

  it('goes idle once every shell has exited', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p2', 'working');
    activityExit.get('p1')!();
    activityExit.get('p2')!();
    expect(statusOf()).toBe('idle');
  });
});

describe('observeSessionStatus - transitions and teardown', () => {
  it('alerts on each transition with the previous status', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('needs-input'));
    expect(signalStatusChange.mock.calls).toEqual([
      [SESSION, 'idle', 'active'],
      [SESSION, 'active', 'needs-input'],
    ]);
  });

  it('does not alert when the status has not moved', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('running'));
    expect(signalStatusChange).toHaveBeenCalledTimes(1);
  });

  it('stops writing after unsubscribe', async () => {
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, ['p1']);
    off();
    emit('p1', marker('running'));
    expect(statusOf()).toBe('idle');
  });

  it('unsubscribes every observer it registered', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2'])();
    // activity + exit per pty, plus the commit-key subscription.
    expect(offCalls).toBe(4);
  });

  it('cancels a pending quiet timer on unsubscribe', async () => {
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'working');
    off();
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('active'); // left as-is, not settled after teardown
  });
});

describe('observeSessionStatus - an archived session (only the user unarchives)', () => {
  it('stays archived on a running marker - viewing it resumes the agent', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('ready'));
    emit('p1', marker('running'));
    expect(statusOf()).toBe('archived');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('stays archived on a needs-input marker', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('needs-input'));
    expect(statusOf()).toBe('archived');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('stays archived on plain-shell output (fallback mode)', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', '$ pnpm test\n');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('archived');
  });

  it('comes out of the archive on a commit keystroke, settling on its tabs', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running')); // working while archived - not shown
    expect(statusOf()).toBe('archived');
    noteTerminalUserInput('p1', '\r');
    expect(statusOf()).toBe('active');
  });

  it('ignores keystrokes that are not commits (scroll, focus, arrows)', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    observeSessionStatus(SESSION, ['p1']);
    noteTerminalUserInput('p1', '\u001b[I\u001b[A');
    expect(statusOf()).toBe('archived');
  });

  it('stays archived on a finished marker - settling is not a sign of life', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('archived');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('stays archived when its shells exit', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    activityExit.get('p1')!();
    expect(statusOf()).toBe('archived');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('stays archived on output we induced ourselves (a reveal redraw)', async () => {
    seedSession('archived');
    const { observeSessionStatus } = await loadModule();
    const { suppressTerminalActivity } = await import('@renderer/lib/terminal/activity-gate');
    observeSessionStatus(SESSION, ['p1']);
    suppressTerminalActivity('p1');
    emit('p1', 'repaint after resize');
    expect(statusOf()).toBe('archived');
  });
});

describe('observeSessionStatus - the finished-unseen mark (session not watched)', () => {
  beforeEach(() => {
    watched.value = false;
  });

  it('lands a stop on finished instead of idle, and alerts on that transition', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('finished');
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'active', 'finished');
  });

  it('marks a fallback session finished when work the user asked for goes quiet while away', async () => {
    const { observeSessionStatus } = await loadModule();
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    observeSessionStatus(SESSION, ['p1']);
    noteTerminalUserInput('p1', 'pnpm build\r');
    emit('p1', 'building...');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('finished');
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'active', 'finished');
  });

  it('settles output nobody asked for quietly - no mark, no alert', async () => {
    // The report (2026-11-02): "Finished - waiting for your reply" out of the
    // blue. A dev server's log lines in a session with no agent hooks read as
    // a turn every time they went quiet.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'GET /api/health 200 in 3ms\r\n');
    expect(statusOf()).toBe('active');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalledWith(SESSION, 'active', 'finished');
  });

  it('alerts once per request: the logs after a finished command stay quiet', async () => {
    const { observeSessionStatus } = await loadModule();
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    observeSessionStatus(SESSION, ['p1']);
    noteTerminalUserInput('p1', 'pnpm dev\r');
    emit('p1', 'ready on http://localhost:5173\r\n');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('finished');
    // The user looks, then goes away again; the server logs a request.
    collection.rows.get(SESSION)!.status = 'idle';
    signalStatusChange.mockClear();
    emit('p1', 'GET / 200\r\n');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalledWith(SESSION, 'active', 'finished');
    // A new prompt makes the next stop the user's again.
    noteTerminalUserInput('p1', 'explain the build\r');
    emit('p1', 'thinking...');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('finished');
  });

  it("keeps a marker-driven stop's alert without any keystroke", async () => {
    // Markers are the agent's own word: a turn a background subagent's
    // hand-back started finishes with its alert like any other.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'active', 'finished');
  });

  it('keeps the mark through later idle verdicts - only the user clears it', async () => {
    // The agent exits after its turn ('ended'), the shell exits - neither is
    // the user looking, so the unseen mark must survive both.
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('finished');
    emit('p1', marker('ended'));
    expect(statusOf()).toBe('finished');
    activityExit.get('p1')!();
    expect(statusOf()).toBe('finished');
  });

  it('gives way to the agent starting again', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    emit('p1', marker('running'));
    expect(statusOf()).toBe('active');
  });

  it('lands a watched stop on plain idle - no mark, nothing unseen', async () => {
    watched.value = true;
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    emit('p1', marker('finished'));
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'active', 'idle');
  });

  it('marks a session finished when its last shell closes while it was running', async () => {
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, []);
    expect(statusOf()).toBe('finished');
    expect(signalStatusChange).toHaveBeenCalledWith(SESSION, 'active', 'finished');
  });
});

describe('observeSessionStatus - the ready marker (agent launched / resumed)', () => {
  it('corrects a stale running status to idle quietly - no alert, no mark', async () => {
    // The app relaunched and resumed the agent: the session row still says
    // 'active' from before the restart. Nothing finished - the app is merely
    // catching up with reality, so no finished alert and no unseen mark even
    // though nobody is watching.
    watched.value = false;
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('ready'));
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('leaves an unseen finished mark for the user', async () => {
    watched.value = false;
    seedSession('finished');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('ready'));
    expect(statusOf()).toBe('finished');
  });

  it('arms marker mode: the resume transcript repaint no longer reads as work', async () => {
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('ready'));
    emit('p1', 'a wall of resumed-transcript output');
    expect(statusOf()).toBe('idle');
    emit('p1', BEL); // the idle-prompt bell - covered by markers, not a signal
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
  });
});

describe('observeSessionStatus - main says a terminal is marker-driven at launch', () => {
  it('skips the fallback heuristics from the very first output', async () => {
    // A Claude launched by the app emits no marker until its first lifecycle
    // event, but main already knows the hooks are in place - the observer asks
    // (terminal:markerDriven) instead of treating the launch banner as work.
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    await vi.advanceTimersByTimeAsync(0); // let the bridge promise resolve
    emit('p1', 'the resume transcript and launch banner');
    expect(statusOf()).toBe('idle');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
  });

  it('cancels a fallback timer armed before the answer arrived', async () => {
    let resolve!: (ids: string[]) => void;
    window.api!.terminal!.markerDriven = vi.fn(() => new Promise<string[]>((r) => (resolve = r)));
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', 'output before the bridge answered'); // fallback: active + timer
    expect(statusOf()).toBe('active');
    resolve(['p1']);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(IDLE_MS);
    // The quiet window never fires - status stays whatever the markers say.
    expect(statusOf()).toBe('active');
  });

  it('stays in fallback mode when main knows of no adapter', async () => {
    window.api!.terminal!.markerDriven = vi.fn(async () => []);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    await vi.advanceTimersByTimeAsync(0);
    emit('p1', 'plain shell output');
    expect(statusOf()).toBe('active');
    vi.advanceTimersByTime(IDLE_MS);
    expect(statusOf()).toBe('idle');
  });
});

describe('observeSessionStatus - a window that starts watching mid-turn', () => {
  type AgentStatus = { id: string; status: 'running' | 'needs-input' | 'idle' };
  /** The observer's own registry instance (loadModule resets modules). */
  const registry = (): Promise<typeof import('@renderer/lib/terminal/busy')> =>
    import('@renderer/lib/terminal/busy');

  it("lights the tab from main's reading when no marker is coming", async () => {
    // The bug: a reload (an HMR full reload counts) while the agent waited on
    // a background subagent - its Stop is held back, so no marker follows for
    // minutes and the tab showed no wash and no dot while the agent worked.
    seedSession('active');
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    window.api!.terminal!.agentStatus = vi.fn(async (): Promise<AgentStatus[]> => [
      { id: 'p1', status: 'running' },
      { id: 'p2', status: 'needs-input' },
      { id: 'p3', status: 'idle' },
    ]);
    const { observeSessionStatus } = await loadModule();
    const { getTerminalTabState, isTerminalKnown } = await registry();
    observeSessionStatus(SESSION, ['p1', 'p2', 'p3']);
    expect(getTerminalTabState('p1')).toBe(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTerminalTabState('p1')).toBe('running');
    expect(getTerminalTabState('p2')).toBe('needs-input');
    expect(getTerminalTabState('p3')).toBe(null);
    expect(isTerminalKnown('p3')).toBe(true);
    // The session row is persisted and already right - the seed leaves it be.
    expect(statusOf()).toBe('active');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('settles a row left active by a missed finished marker, quietly', async () => {
    // The bug: the Stop hook's 'finished' landed while no observer listened
    // (an HMR reload mid-turn), so the row stayed 'active' and the sidebar
    // said "Working…" over an idle Claude until its next turn.
    seedSession('active');
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    window.api!.terminal!.agentStatus = vi.fn(async (): Promise<AgentStatus[]> => [
      { id: 'p1', status: 'idle' },
      { id: 'p2', status: 'idle' },
    ]);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    expect(statusOf()).toBe('active');
    await vi.advanceTimersByTimeAsync(0);
    // Plain idle, never an unseen 'finished' or an alert: nothing finished
    // now, the app only caught up.
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('settles over a quiet plain shell tab main has no reading for', async () => {
    // The bug: an idle Claude whose status line redraws every second, beside
    // a plain shell tab. A window starting to watch reads that redraw as work
    // before main says the tab is hook-driven (row -> 'active'), main's answer
    // cancels the quiet timer, and the correction waited on a reading for the
    // shell that never comes - "Working…" for good (2026-10-14). In a
    // marker-driven session a shell's output never moves the row, so its
    // silence must not hold it either.
    seedSession('idle');
    let answer!: (ids: string[]) => void;
    window.api!.terminal!.markerDriven = vi.fn(() => new Promise<string[]>((r) => (answer = r)));
    window.api!.terminal!.agentStatus = vi.fn(async (): Promise<AgentStatus[]> => [
      { id: 'p1', status: 'idle' },
    ]);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', 'status line clock tick'); // before main answered: a fallback guess
    expect(statusOf()).toBe('active');
    signalStatusChange.mockClear();
    answer(['p1']);
    await vi.advanceTimersByTimeAsync(0);
    // A correction, not a turn ending: no alert, no unseen 'finished'.
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('leaves the row alone when no tab speaks the protocol', async () => {
    // Plain shells only: the fallback rules own the row, not this correction.
    seedSession('active');
    window.api!.terminal!.markerDriven = vi.fn(async () => []);
    window.api!.terminal!.agentStatus = vi.fn(async (): Promise<AgentStatus[]> => []);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('active');
  });

  it('leaves the row alone while another agent tab is still working', async () => {
    seedSession('active');
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    window.api!.terminal!.agentStatus = vi.fn(async (): Promise<AgentStatus[]> => [
      { id: 'p1', status: 'idle' },
      { id: 'p2', status: 'running' },
    ]);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('active');
  });

  it('does not settle over a turn that opened before the answer', async () => {
    seedSession('active');
    let resolve!: (statuses: AgentStatus[]) => void;
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    window.api!.terminal!.agentStatus = vi.fn(
      () => new Promise<AgentStatus[]>((r) => (resolve = r)),
    );
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('running'));
    resolve([{ id: 'p1', status: 'idle' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('active');
  });

  it('lets a marker that lands before the answer win', async () => {
    let resolve!: (statuses: AgentStatus[]) => void;
    window.api!.terminal!.agentStatus = vi.fn(
      () => new Promise<AgentStatus[]>((r) => (resolve = r)),
    );
    const { observeSessionStatus } = await loadModule();
    const { getTerminalTabState } = await registry();
    observeSessionStatus(SESSION, ['p1']);
    emit('p1', marker('needs-input'));
    resolve([{ id: 'p1', status: 'running' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTerminalTabState('p1')).toBe('needs-input');
  });

  it('seeds nothing once the observer is gone', async () => {
    // The tab set changed (or the view unmounted) before main answered.
    let resolve!: (statuses: AgentStatus[]) => void;
    window.api!.terminal!.agentStatus = vi.fn(
      () => new Promise<AgentStatus[]>((r) => (resolve = r)),
    );
    const { observeSessionStatus } = await loadModule();
    const { getTerminalTabState } = await registry();
    const off = observeSessionStatus(SESSION, ['p1']);
    off();
    resolve([{ id: 'p1', status: 'running' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTerminalTabState('p1')).toBe(null);
  });
});

describe('aggregateTabStatus - what a session’s tabs add up to', () => {
  it('a tab waiting on the user beats a working one', async () => {
    const { aggregateTabStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    busy.setTerminalBusy('a', 'running');
    busy.setTerminalBusy('b', 'needs-input');
    expect(aggregateTabStatus(['a', 'b'])).toBe('needs-input');
  });

  it('a working tab makes the session active, a quiet known one adds nothing', async () => {
    const { aggregateTabStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    busy.setTerminalBusy('a', 'running');
    busy.clearTerminalBusy('b');
    expect(aggregateTabStatus(['a', 'b'])).toBe('active');
  });

  it('every tab known and quiet is idle - and so is no tab at all', async () => {
    const { aggregateTabStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    busy.noteTerminalReady('a');
    busy.clearTerminalBusy('b');
    expect(aggregateTabStatus(['a', 'b'])).toBe('idle');
    expect(aggregateTabStatus([])).toBe('idle');
  });

  it('a tab this window has never heard from cannot be called idle', async () => {
    // A window that just loaded (a reload, a tear-off) has seen nothing from a
    // parked agent - and a parked needs-input agent emits nothing until it is
    // answered. "No news" must leave the status alone, not read as quiet.
    const { aggregateTabStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    expect(aggregateTabStatus(['fresh'])).toBe(null);
    // Positive evidence from another tab still counts.
    busy.setTerminalBusy('b', 'running');
    expect(aggregateTabStatus(['fresh', 'b'])).toBe('active');
  });
});

describe('recheckSessionStatus - a closed tab takes its verdict with it', () => {
  // The bug: close the tab whose agent was waiting on you, and the session (and
  // its project row) kept saying needs-input - the observer re-subscribed
  // without that pty before its shell exit arrived, so nothing ever settled it.
  it('stops waiting when the tab that was waiting is closed', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('ready')); // the conversation tab: an agent parked at its prompt
    emit('p2', marker('needs-input')); // a second agent tab, blocked on you
    expect(statusOf()).toBe('needs-input');

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'needs-input', 'idle');
  });

  it('retires what the closed tab left in the busy registry', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    const busy = await import('@renderer/lib/terminal/busy');
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('ready'));
    emit('p2', marker('needs-input'));
    expect(busy.getTerminalBusy('p2')).toBe('needs-input');

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(busy.getTerminalBusy('p2')).toBe(null);
  });

  it('keeps waiting while another tab is still blocked on you', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('needs-input'));
    emit('p2', marker('needs-input'));
    const alerts = signalStatusChange.mock.calls.length;

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('needs-input');
    expect(signalStatusChange.mock.calls.length).toBe(alerts); // nothing changed, nothing fired
  });

  it('falls back to active while another tab is still working', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('running'));
    emit('p2', marker('needs-input'));
    expect(statusOf()).toBe('needs-input');

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('active');
  });

  it('drops the activity line along with the last working tab', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    const { getSessionActivity } = await import('@renderer/lib/session/activity');
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('ready'));
    emit('p2', marker('running'));
    emit('p2', marker('tool-start', btoa(JSON.stringify({ tool_name: 'Bash' }))));
    expect(getSessionActivity(SESSION)).not.toBeNull();

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('idle');
    expect(getSessionActivity(SESSION)).toBeNull();
  });

  it('leaves the status alone when a remaining tab has not reported to this window', async () => {
    // A torn-off / reloaded window: the conversation tab's agent may well be
    // parked at a question this window never saw. Closing another tab must not
    // guess it idle - the stale-but-safe status stays until the agent speaks.
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p2', marker('needs-input'));

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('needs-input');
  });

  it('lands on the unseen finished mark when the session is not on screen', async () => {
    watched.value = false;
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('ready'));
    emit('p2', marker('needs-input'));

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('finished');
    expect(signalStatusChange).toHaveBeenLastCalledWith(SESSION, 'needs-input', 'finished');
  });

  it('never wakes an archived session - a close is not activity', async () => {
    const { observeSessionStatus, recheckSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1', 'p2']);
    emit('p1', marker('ready'));
    seedSession('archived');

    recheckSessionStatus(SESSION, ['p1'], ['p2']);

    expect(statusOf()).toBe('archived');
  });
});

describe('observeSessionStatus - observed afresh while marked running', () => {
  it('re-arms the quiet window, so a fallback session whose timer was lost still settles', async () => {
    // A tab was added or removed: the previous observer took its timer with
    // it. Without a fresh window the session would stay 'active' until
    // something printed again - even though every terminal is already quiet.
    window.api!.terminal!.markerDriven = vi.fn(async () => []);
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(statusOf()).toBe('active');
    vi.advanceTimersByTime(1);
    expect(statusOf()).toBe('idle');
  });

  it('leaves a marker-driven session to its markers', async () => {
    window.api!.terminal!.markerDriven = vi.fn(async (ids: string[]) => ids);
    seedSession('active');
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p1']);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(statusOf()).toBe('active');
  });
});

describe('runtime sessions: status from main, marks and alerts here', () => {
  function seedRuntime(status: Status = 'idle') {
    collection.rows.clear();
    collection.rows.set(SESSION, {
      id: SESSION,
      status,
      agent: 'Claude Code',
      label: 'Fix login',
      runtime: 'gadget-runtime',
    });
  }

  it("observes a runtime session's terminal tabs and hands their verdict to main - never the row", async () => {
    seedRuntime('idle');
    const terminalStatus = vi.fn(async () => true);
    (window.api as unknown as { sessionView: unknown }).sessionView = { terminalStatus };
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, ['pty-plus-tab']);
    expect(activity.has('pty-plus-tab')).toBe(true);
    activity.get('pty-plus-tab')!('npm run build\r\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(terminalStatus).toHaveBeenCalledWith(SESSION, 'active');
    // The row is main's to write.
    expect(collection.rows.get(SESSION)?.status).toBe('idle');
    off();
    expect(collection.listeners.size).toBe(0);
  });

  it('a turn that ends while nobody watches leaves the unseen finished mark and alerts', async () => {
    seedRuntime('idle');
    watched.value = false;
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, []);
    collection.mainWrites(SESSION, 'active');
    collection.mainWrites(SESSION, 'idle');
    expect(collection.rows.get(SESSION)?.status).toBe('finished');
    expect(signalStatusChange).toHaveBeenCalledWith(SESSION, 'active', 'finished');
    off();
  });

  it('a watched turn just goes idle, quietly', async () => {
    seedRuntime('idle');
    watched.value = true;
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, []);
    collection.mainWrites(SESSION, 'active');
    collection.mainWrites(SESSION, 'idle');
    expect(collection.rows.get(SESSION)?.status).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
    off();
  });

  it('a permission request alerts as needs-input', async () => {
    seedRuntime('active');
    watched.value = false;
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, []);
    collection.mainWrites(SESSION, 'needs-input');
    expect(signalStatusChange).toHaveBeenCalledWith(SESSION, 'active', 'needs-input');
    off();
  });

  it('terminal-derived writes never touch a runtime session row - main combines them', async () => {
    seedRuntime('active');
    const terminalStatus = vi.fn(async () => true);
    (window.api as unknown as { sessionView: unknown }).sessionView = { terminalStatus };
    const { recheckSessionStatus } = await loadModule();
    recheckSessionStatus(SESSION, [], ['pty-gone']);
    expect(collection.rows.get(SESSION)?.status).toBe('active');
    expect(terminalStatus).toHaveBeenCalledWith(SESSION, 'idle');
  });
});

describe('observeSessionStatus - a row a stray verdict settled mid-turn', () => {
  type AgentStatus = { id: string; status: 'running' | 'needs-input' | 'idle' };
  const CONV = `conversation:${SESSION}`;
  const TAB2 = 'tab-2';

  /** Main answers for the ids it is asked about only, like the real bridge. */
  function mainSees(statuses: AgentStatus[]): void {
    const ids = statuses.map((s) => s.id);
    window.api!.terminal!.markerDriven = vi.fn(async (asked: string[]) =>
      asked.filter((id) => ids.includes(id)),
    );
    window.api!.terminal!.agentStatus = vi.fn(async (asked: string[]) =>
      statuses.filter((s) => asked.includes(s.id)),
    );
  }

  it('is active again when the session is observed afresh while its agent works', async () => {
    // The bug (2026-10-29): Claude ran in a second tab. The session was
    // evicted, the host watched its conversation shell only, that shell sent
    // no marker and the fallback quiet timer settled the row idle mid-turn.
    // Opening the session lit the tab from main's reading but left the row
    // idle - a long Bash sends no marker - so a green tab dot sat under a
    // gray "Finished" row.
    mainSees([{ id: TAB2, status: 'running' }]);
    const { observeSessionStatus } = await loadModule();
    const offSurface = observeSessionStatus(SESSION, [CONV, TAB2]);
    await vi.advanceTimersByTimeAsync(0);
    emit(TAB2, marker('running'));
    emit(TAB2, marker('tool-start'));
    expect(statusOf()).toBe('active');

    // The stray verdict: an observer of the conversation shell alone.
    offSurface();
    activity.clear();
    const offStray = observeSessionStatus(SESSION, [CONV]);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(statusOf()).toBe('idle');
    offStray();
    signalStatusChange.mockClear();

    // Observed afresh with every tab, mid-tool: no marker comes.
    observeSessionStatus(SESSION, [CONV, TAB2]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('active');
    // A correction, not an event: no alert.
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('restores a wait main read off the stream into a row that missed it', async () => {
    seedSession('idle');
    mainSees([{ id: TAB2, status: 'needs-input' }]);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, [CONV, TAB2]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('needs-input');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it("keeps the renderer's own stop over main's reading", async () => {
    // Main never learns of an Esc (no hook reports it): its tracker still
    // says running, the renderer saw the turn stopped. Its evidence wins.
    mainSees([{ id: TAB2, status: 'running' }]);
    const { observeSessionStatus } = await loadModule();
    const off = observeSessionStatus(SESSION, [TAB2]);
    await vi.advanceTimersByTimeAsync(0);
    emit(TAB2, marker('running'));
    const { noteTerminalUserInput } = await import('@renderer/lib/terminal/activity-gate');
    noteTerminalUserInput(TAB2, ESC);
    expect(statusOf()).toBe('idle');
    off();
    observeSessionStatus(SESSION, [TAB2]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('idle');
  });

  it("never revives a row from a plain shell tab's output", async () => {
    // Only main's agent tabs count: a `pnpm test` tab beside an idle Claude
    // is busy, not the session.
    mainSees([{ id: TAB2, status: 'idle' }]);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['plain', TAB2]);
    emit('plain', 'PASS src/a.test.ts\r\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf()).toBe('idle');
  });
});

describe('observeSessionStatus - an adopt replay is history', () => {
  /** What an adopt sends: the ring, holding the last turn's markers. */
  const OLD_TURN = `screen ${marker('ready')}${marker('running')}${marker('tool-start')}${marker('tool-done')}${marker('finished')} prompt`;
  const replay = (ptyId: string, data: string): void =>
    (activity.get(ptyId) as (d: string, info?: { replay: true }) => void)(data, { replay: true });

  it('never replays an old turn into a finished alert', async () => {
    // The report (2026-11-02): "Finished - waiting for your reply" for a
    // session nobody had prompted. A replay read as live output replayed the
    // ring's `running` … `finished` and, with the session off screen, landed
    // on the unseen mark with its alert.
    watched.value = false;
    markerDrivenIds = ['p'];
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p']);
    await vi.advanceTimersByTimeAsync(0);
    replay('p', OLD_TURN);
    expect(statusOf()).toBe('idle');
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('never reads a plain shell replay as work', async () => {
    // Fallback mode: the replayed screen would read as output, then the quiet
    // window would settle it 'finished' with the same alert.
    watched.value = false;
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['plain']);
    await vi.advanceTimersByTimeAsync(0);
    replay('plain', 'PASS src/a.test.ts\r\n$ ');
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(statusOf()).toBe('idle');
    expect(signalStatusChange).not.toHaveBeenCalled();
  });

  it('asks main what the agent does now - a turn that ended while a host was away', async () => {
    seedSession('active');
    markerDrivenIds = ['p'];
    let reading: { id: string; status: 'running' | 'needs-input' | 'idle' }[] = [
      { id: 'p', status: 'running' },
    ];
    window.api!.terminal!.agentStatus = vi.fn(async () => reading);
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p']);
    await vi.advanceTimersByTimeAsync(0);
    emit('p', marker('running'));
    expect(statusOf()).toBe('active');

    // Back from away: the `finished` sits in the replay, main has read it.
    emit('p', marker('finished'));
    seedSession('active');
    reading = [{ id: 'p', status: 'idle' }];
    replay('p', OLD_TURN);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.api!.terminal!.agentStatus).toHaveBeenCalledTimes(2);
    expect(statusOf()).toBe('idle');
  });

  it('still reads the live output that follows a replay', async () => {
    watched.value = false;
    markerDrivenIds = ['p'];
    const { observeSessionStatus } = await loadModule();
    observeSessionStatus(SESSION, ['p']);
    await vi.advanceTimersByTimeAsync(0);
    replay('p', `${OLD_TURN}${ESC}]6790;runn`);
    emit('p', marker('running'));
    expect(statusOf()).toBe('active');
    emit('p', marker('finished'));
    expect(statusOf()).toBe('finished');
    expect(signalStatusChange).toHaveBeenCalledWith(SESSION, 'active', 'finished');
  });
});
