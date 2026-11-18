import { describe, expect, it, vi } from 'vitest';
import { NO_REMOTE_HOSTS, localOnly, readyAfter } from './remote-hosts';
import type { TerminalBackend } from './terminal-backend';
import { NO_RUNTIME_SESSIONS } from './runtime-sessions';

/**
 * What main reads of the remote hosts and the runtime sessions when Pro registers
 * neither (a private plan › M6, M7): no host is known,
 * every host question answers "away" (never this machine's files), nothing
 * is busy, and the local backend is still held until the remote project
 * roots are read.
 */

describe('NO_REMOTE_HOSTS', () => {
  it('knows no host and answers every host call as away - never as this machine', async () => {
    expect(NO_REMOTE_HOSTS.status('build-box')).toBeNull();
    expect(NO_REMOTE_HOSTS.statuses()).toEqual([]);
    expect(NO_REMOTE_HOSTS.label('build-box')).toBeNull();
    expect(NO_REMOTE_HOSTS.supports('build-box', 'gadgets')).toBe(false);
    expect(NO_REMOTE_HOSTS.hostOfTerminal('conversation:x')).toBeNull();
    expect(NO_REMOTE_HOSTS.extensionChannel('build-box')).toBeNull();
    expect(NO_REMOTE_HOSTS.cast('build-box', 'lspSend', {}, 'lsp')).toBe(false);
    // A remote project's folder resolves to this runtime in the core build:
    // every file and process call fails EHOSTDOWN, none reads a local file.
    const rt = NO_REMOTE_HOSTS.runtime('build-box');
    await expect(rt.fs.readFile('/home/emmaw/acme/README.md')).rejects.toMatchObject({
      code: 'EHOSTDOWN',
    });
    await expect(rt.exec('git', ['status'], { cwd: '/home/emmaw/acme' })).rejects.toMatchObject({
      code: 'EHOSTDOWN',
    });
    await expect(NO_REMOTE_HOSTS.call('build-box', 'fsIndex', {})).rejects.toMatchObject({
      code: 'EHOSTDOWN',
    });
    await expect(NO_REMOTE_HOSTS.root('build-box')).rejects.toMatchObject({ code: 'EHOSTDOWN' });
    await expect(NO_REMOTE_HOSTS.forwards.hold('agent:x', 'build-box', 5173)).resolves.toBeNull();
    expect(NO_REMOTE_HOSTS.forwards.list()).toEqual([]);
    // Subscriptions are inert and can be undone.
    expect(() => NO_REMOTE_HOSTS.onOpEvent(() => undefined)()).not.toThrow();
  });

  it('localOnly hands back the backend it was given and no host', () => {
    const backend = { ready: () => Promise.resolve() } as unknown as TerminalBackend;
    const started = localOnly(backend);
    expect(started.backend).toBe(backend);
    expect(started.hosts).toBe(NO_REMOTE_HOSTS);
    expect(() => started.dispose()).not.toThrow();
  });
});

describe('readyAfter', () => {
  function fakeBackend() {
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const backend = {
      label: 'local',
      ready: () => ready,
      // A method that needs its own `this` (a class's state).
      describe(this: { label: string }) {
        return this.label;
      },
    };
    return { backend: backend as unknown as TerminalBackend, resolveReady };
  }

  it('is ready only once the backend AND the gate are', async () => {
    const { backend, resolveReady } = fakeBackend();
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const wrapped = readyAfter(backend, gate);
    let done = false;
    void wrapped.ready().then(() => (done = true));
    resolveReady();
    await new Promise((r) => setImmediate(r));
    // The roots are not read yet: a create now would mistake a remote folder.
    expect(done).toBe(false);
    openGate();
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it('treats a failed gate as read (the roots read failed - local only)', async () => {
    const { backend, resolveReady } = fakeBackend();
    resolveReady();
    await expect(readyAfter(backend, Promise.reject(new Error('db'))).ready()).resolves.toBe(
      undefined,
    );
  });

  it('passes every other member through, bound to the backend', () => {
    const { backend } = fakeBackend();
    const wrapped = readyAfter(backend, Promise.resolve()) as unknown as {
      label: string;
      describe: () => string;
    };
    expect(wrapped.label).toBe('local');
    const describe = wrapped.describe;
    expect(describe()).toBe('local');
  });
});

describe('NO_RUNTIME_SESSIONS', () => {
  it('has nothing busy, runs nothing in this process and stops nothing', async () => {
    expect(NO_RUNTIME_SESSIONS.busy()).toEqual({ working: 0, waiting: 0 });
    expect(NO_RUNTIME_SESSIONS.inProcess()).toBe(false);
    await expect(NO_RUNTIME_SESSIONS.stopAllOn(null)).resolves.toBeUndefined();
    await expect(NO_RUNTIME_SESSIONS.afterSessionSweep()).resolves.toBeUndefined();
    await expect(NO_RUNTIME_SESSIONS.sessionHost('5b0c3a1e')).resolves.toBeNull();
  });
});
