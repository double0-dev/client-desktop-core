import { describe, expect, it, vi } from 'vitest';
import { createTerminalBackend, type BackendEvent, type TerminalBackend } from './terminal-backend';

/**
 * A backend whose events are pushed by the test and whose `ready()` settles
 * when the test says so - enough to drive the daemon-or-fallback wrapper.
 */
function fakeBackend(): TerminalBackend & {
  emit: (ev: BackendEvent) => void;
  settle: (ok: boolean) => void;
} {
  const listeners = new Set<(ev: BackendEvent) => void>();
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The wrapper attaches its own handlers; this keeps an unobserved rejection
  // from failing the run before it does.
  ready.catch(() => undefined);
  const none = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    ready: () => ready,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (ev) => {
      for (const l of listeners) l(ev);
    },
    settle: (ok) => (ok ? resolve() : reject(new Error('no daemon'))),
    spawn: none,
    list: none,
    adopt: none,
    input: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => undefined,
    setTone: () => undefined,
    noteLine: () => undefined,
    size: none,
    foregroundBusy: none,
    markerDriven: none,
    agentStatus: none,
    inputList: none,
    killAll: none,
    shutdown: none,
  };
}

const discovered: BackendEvent = {
  type: 'discovered',
  terminals: [
    { id: 'conversation:1', cols: 80, rows: 24, markerDriven: true, agentStatus: 'idle' },
  ],
};

describe('createTerminalBackend', () => {
  it('delivers the terminals a daemon reports while it is still booting', async () => {
    // The daemon announces the terminals that outlived the last run as it
    // connects - BEFORE ready() settles. Dropping that event made every tab
    // spawn a duplicate shell instead of re-adopting its live one.
    const daemon = fakeBackend();
    const backend = createTerminalBackend({
      daemon,
      fallback: fakeBackend(),
      log: () => undefined,
    });
    const seen = vi.fn<(ev: BackendEvent) => void>();
    backend.onEvent(seen);

    daemon.emit(discovered);
    expect(seen).toHaveBeenCalledWith(discovered);

    daemon.settle(true);
    await backend.ready();
    daemon.emit({ type: 'title', id: 'conversation:1', title: 'Fix login' });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('switches to the fallback when the daemon never comes up', async () => {
    const daemon = fakeBackend();
    const fallback = fakeBackend();
    const backend = createTerminalBackend({ daemon, fallback, log: () => undefined });
    const seen = vi.fn<(ev: BackendEvent) => void>();
    backend.onEvent(seen);

    daemon.settle(false);
    await backend.ready();
    // A late event from the abandoned daemon is not ours any more.
    daemon.emit(discovered);
    expect(seen).not.toHaveBeenCalled();

    fallback.emit({ type: 'title', id: 'local:1', title: 'zsh' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('passes a resize kind on to the chosen backend, and no kind as before (M4)', async () => {
    const daemon = fakeBackend();
    const resize = vi.fn();
    daemon.resize = resize;
    const backend = createTerminalBackend({
      daemon,
      fallback: fakeBackend(),
      log: () => undefined,
    });
    daemon.settle(true);
    await backend.ready();
    backend.resize('t1', 100, 30, 'passive');
    backend.resize('t1', 90, 20);
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
    expect(resize.mock.calls).toEqual([
      ['t1', 100, 30, 'passive'],
      ['t1', 90, 20],
    ]);
  });
});
