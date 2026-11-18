import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '../pty-host';
import { DaemonClient, isOutcomeUnknown } from './daemon-client';
import { encodeFrame } from './protocol';

/**
 * The client's frame dispatch over a scripted raw server: what the server
 * writes in ONE chunk arrives in one `data` event, and the order the client
 * hands it out in is what terminal.ts relies on (daemon-server.test.ts covers
 * the real daemon end to end).
 */

const scratch: string[] = [];
const servers: Server[] = [];
const clients: DaemonClient[] = [];

const welcome = encodeFrame({
  t: 'welcome',
  ok: true,
  pid: 1,
  protocolVersion: 1,
  appVersion: '0.4.2',
  buildId: 'b',
  stale: false,
  terminals: [],
});
const reply = (req: number, result: unknown): string =>
  encodeFrame({ t: 'reply', req, ok: true, result });
const event = (id: string): string =>
  encodeFrame({ t: 'event', ev: { type: 'data', id, data: 'x' } });

/** A server that answers hello with `greeting` and every later chunk through `onFrame`. */
async function serve(
  greeting: string,
  onFrame: (socket: Socket, frame: { req?: number }) => void,
): Promise<string> {
  // Windows listens on a named pipe, as the daemon does there (daemon-paths.ts).
  let path = `\\\\.\\pipe\\d0c-${randomUUID()}`;
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'd0c-'));
    scratch.push(dir);
    path = join(dir, 's.sock');
  }
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let greeted = false;
    socket.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        if (!greeted) {
          greeted = true;
          socket.write(greeting);
          continue;
        }
        onFrame(socket, JSON.parse(line));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return path;
}

async function connect(path: string): Promise<DaemonClient> {
  const c = await DaemonClient.connect(path, { token: 't', appVersion: '0.4.2', buildId: 'b' });
  clients.push(c);
  return c;
}

const macrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('frames behind a reply', () => {
  it('reach the listeners only after whoever awaited the call has run, however deep the await', async () => {
    // The daemon answers `adopt` and the pty's next chunk lands in the SAME
    // socket read. main's adopt (terminal.ts) flips its "drop chunks, the
    // snapshot has them" flag in the continuation of that await - two async
    // layers deep - so an event dispatched synchronously behind the reply was
    // dropped although it came AFTER the snapshot: lost output on every
    // reattach under load (2026-10-04).
    const path = await serve(welcome, (socket, frame) => {
      socket.write(reply(frame.req!, { data: 'snapshot' }) + event('a') + event('b'));
    });
    const client = await connect(path);
    const seen: string[] = [];
    client.onEvent((ev) => seen.push(`event:${ev.id}`));
    const inner = async (): Promise<unknown> => await client.call('adopt', { id: 't' });
    const outer = async (): Promise<void> => {
      const snapshot = await inner();
      seen.push(`awaited:${(snapshot as { data: string }).data}`);
    };
    await outer();
    expect(seen).toEqual(['awaited:snapshot']);
    await macrotask();
    expect(seen).toEqual(['awaited:snapshot', 'event:a', 'event:b']);
  });

  it('keep their order across chunks while a turn is deferred', async () => {
    let n = 0;
    const path = await serve(welcome, (socket, frame) => {
      n += 1;
      if (n === 1) {
        // Both calls are answered in the second chunk; the first chunk only
        // carries an event the second reply must not overtake.
        socket.write(reply(frame.req!, 1) + event('a'));
        socket.write(event('b') + reply(frame.req! + 1, 2));
      }
    });
    const client = await connect(path);
    const seen: string[] = [];
    client.onEvent((ev) => seen.push(`event:${ev.id}`));
    const first = client.call('size', { id: 'x' }).then((r) => seen.push(`awaited:${r}`));
    const second = client.call('size', { id: 'y' }).then((r) => seen.push(`awaited:${r}`));
    await Promise.all([first, second]);
    await macrotask();
    expect(seen).toEqual(['awaited:1', 'event:a', 'event:b', 'awaited:2']);
  });

  it('refuses a call too large to send instead of getting dropped for it', async () => {
    const path = await serve(welcome, () => {});
    const client = await connect(path);
    await expect(client.call('spawn', { text: 'x'.repeat(9 * 1024 * 1024) })).rejects.toThrow(
      'too large',
    );
    expect(client.closed).toBe(false);
  });

  it('keeps a frame split across the welcome chunk and the next read', async () => {
    // A daemon streaming a terminal's output when we attach: the first read
    // can end mid-frame. A fresh decoder read the rest as garbage and closed
    // the connection (review, 2026-10-06).
    const split = event('split');
    const cut = Math.floor(split.length / 2);
    const path = await serve(welcome + split.slice(0, cut), (socket, frame) => {
      socket.write(split.slice(cut) + reply(frame.req ?? 0, 1));
    });
    const client = await connect(path);
    const seen: HostEvent[] = [];
    client.onEvent((ev) => seen.push(ev));
    expect(await client.call('size', { id: 'x' })).toBe(1);
    await macrotask();
    expect(client.closed).toBe(false);
    expect(seen).toEqual([{ type: 'data', id: 'split', data: 'x' }]);
  });

  it('delivers the events that rode in the welcome chunk to listeners attached after connect', async () => {
    // The daemon may send a terminal's output right behind its welcome; the
    // backend attaches its listener once `connect` has resolved.
    const path = await serve(welcome + event('early'), () => {});
    const client = await connect(path);
    const seen: HostEvent[] = [];
    client.onEvent((ev) => seen.push(ev));
    await macrotask();
    expect(seen).toEqual([{ type: 'data', id: 'early', data: 'x' }]);
  });
});

describe('a listener that throws', () => {
  it('costs only its own frame - every frame and reply behind it still arrives', async () => {
    // A screen copy threw on every chunk of one stuck terminal
    // (xterm's 50 MB write cap, crash report 157462270, v0.6.3). The throw left
    // drain() with the rest of the read still queued - every other
    // terminal's output and every reply waited behind the next chunk of the
    // stuck one, and the whole app's terminals froze.
    const path = await serve(welcome, (socket, frame) => {
      socket.write(event('stuck') + event('a') + event('stuck') + reply(frame.req!, 'ok'));
    });
    const client = await connect(path);
    // The error is rethrown on its own macrotask for the crash reporter;
    // catch it there instead of failing the run.
    const rethrown: unknown[] = [];
    const realSetImmediate = setImmediate;
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: () => void) =>
      realSetImmediate(() => {
        try {
          fn();
        } catch (err) {
          rethrown.push(err);
        }
      })) as unknown as typeof setImmediate);
    const seen: string[] = [];
    client.onEvent((ev) => {
      if (ev.id === 'stuck') throw new Error('write data discarded');
    });
    client.onEvent((ev) => seen.push(ev.id));
    expect(await client.call('size', { id: 'x' })).toBe('ok');
    expect(seen).toEqual(['stuck', 'a', 'stuck']);
    await macrotask();
    // Reported once, not once per chunk.
    expect(rethrown).toHaveLength(1);
    expect((rethrown[0] as Error).message).toBe('write data discarded');
  });
});

/**
 * A daemon on the far end of a plain stream pair - the shape of the remote
 * bridge (an ssh child's stdio, a private plan › 5):
 * no socket, no 'connect' event, and a far end that may just stop (EOF)
 * without closing the client's write side.
 */
function streamPair(
  greeting: string,
  onFrame: (write: (s: string) => void, frame: { req?: number; op?: string }) => void,
): { client: Duplex; toClient: PassThrough; frames: unknown[] } {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const frames: unknown[] = [];
  const write = (s: string): void => {
    toClient.write(s);
  };
  let greeted = false;
  let tail = '';
  toServer.setEncoding('utf8');
  toServer.on('data', (chunk: string) => {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const frame = JSON.parse(line) as { req?: number; op?: string };
      frames.push(frame);
      if (!greeted) {
        greeted = true;
        write(greeting);
        continue;
      }
      onFrame(write, frame);
    }
  });
  return { client: Duplex.from({ readable: toClient, writable: toServer }), toClient, frames };
}

const helloArgs = { token: 'bridge', appVersion: '0.6.4', buildId: 'b' };

describe('connectOver - a daemon behind a stream', () => {
  it('says hello at once, and keeps the reply-ends-the-turn rule', async () => {
    const pair = streamPair(welcome, (write, frame) => {
      write(reply(frame.req!, { data: 'snapshot' }) + event('a'));
    });
    const client = await DaemonClient.connectOver(pair.client, helloArgs, { label: 'build-box' });
    clients.push(client);
    expect(pair.frames[0]).toEqual({ t: 'hello', protocolVersion: 1, ...helloArgs });
    // A stream has no path; its label stands in where logs name one.
    expect(client.socketPath).toBe('build-box');
    const seen: string[] = [];
    client.onEvent((ev) => seen.push(`event:${ev.id}`));
    const outer = async (): Promise<void> => {
      const snapshot = await (async () => await client.call('adopt', { id: 't' }))();
      seen.push(`awaited:${(snapshot as { data: string }).data}`);
    };
    await outer();
    // The event in the reply's chunk waits for the next macrotask, as over a socket.
    expect(seen).toEqual(['awaited:snapshot']);
    await macrotask();
    expect(seen).toEqual(['awaited:snapshot', 'event:a']);
  });

  it('hands the multi-client notices to their own listeners, never as terminal events (M4)', async () => {
    const multi = welcome.replace('"terminals":[]', '"terminals":[],"connectionId":4');
    const pair = streamPair(multi, (write, frame) => {
      write(
        encodeFrame({
          t: 'event',
          ev: { type: 'terminal-size', id: 't', cols: 90, rows: 20, by: 2 },
        }) +
          encodeFrame({ t: 'event', ev: { type: 'peers', own: 1, other: 0 } }) +
          event('t') +
          reply(frame.req!, true),
      );
    });
    const client = await DaemonClient.connectOver(pair.client, helloArgs);
    clients.push(client);
    expect(client.connectionId).toBe(4);
    const views: string[] = [];
    const terminal: string[] = [];
    client.onViewEvent((ev) => views.push(ev.type));
    client.onEvent((ev) => terminal.push(ev.type));
    await client.call('list');
    await macrotask();
    expect(views).toEqual(['terminal-size', 'peers']);
    expect(terminal).toEqual(['data']);
  });

  it("reads the daemon's capabilities, and none from a daemon that predates the list", async () => {
    const withCaps = welcome.replace('"terminals":[]', '"terminals":[],"caps":["ping"]');
    const a = await DaemonClient.connectOver(streamPair(withCaps, () => {}).client, helloArgs);
    const b = await DaemonClient.connectOver(streamPair(welcome, () => {}).client, helloArgs);
    clients.push(a, b);
    expect(a.supports('ping')).toBe(true);
    expect(b.supports('ping')).toBe(false);
  });

  it('closes once the far end stops, failing the calls still in flight', async () => {
    // The bridge's stdout ending (ssh gave up) must read as a closed daemon -
    // a pending `spawn` left hanging would hold its tab forever.
    const pair = streamPair(welcome, () => {});
    const client = await DaemonClient.connectOver(pair.client, helloArgs);
    clients.push(client);
    const closed = vi.fn();
    client.onClose(closed);
    const pending = client.call('list');
    pair.toClient.end();
    // Sent and never answered: outcome unknown (spec 7.11) - a caller re-reads
    // state instead of repeating a mutation.
    const err = await pending.catch((e: unknown) => e);
    expect(String(err)).toContain('daemon connection closed');
    expect(isOutcomeUnknown(err)).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
  });

  it('rejects a refused hello and a far end that ends before any welcome', async () => {
    const refused = streamPair(encodeFrame({ t: 'welcome', ok: false, error: 'token' }), () => {});
    await expect(DaemonClient.connectOver(refused.client, helloArgs)).rejects.toThrow(
      'daemon refused: token',
    );
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const silent = DaemonClient.connectOver(
      Duplex.from({ readable: toClient, writable: toServer }),
      helloArgs,
    );
    toClient.end();
    await expect(silent).rejects.toThrow('daemon closed during handshake');
  });
});

describe('a call the daemon cannot answer', () => {
  it('is refused at once when the daemon did not list its capability', async () => {
    // An older build's daemon (still draining its terminals) drops an op it
    // does not know without a reply - a `ping` sent there would hang forever.
    const pair = streamPair(welcome, (write, frame) => write(reply(frame.req!, 'answered')));
    const client = await DaemonClient.connectOver(pair.client, helloArgs);
    clients.push(client);
    await expect(client.call('ping')).rejects.toThrow('daemon lacks capability ping');
    // Nothing went on the wire for it; ungated ops still go through.
    expect(pair.frames.some((f) => (f as { op?: string }).op === 'ping')).toBe(false);
    expect(await client.call('list')).toBe('answered');
  });
});
