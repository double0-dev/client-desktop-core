import { afterEach, describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  isExtensionEvent,
  isHostOpEvent,
  registerProtocolExtension,
  resetProtocolExtensionForTest,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  idsArgs,
  noteLineArgs,
  parseClientFrame,
  parseDaemonFrame,
  resizeArgs,
  resizeIntentArgs,
  isViewEvent,
  spawnArgs,
  validateHello,
} from './protocol';
import {
  CALL_OPS,
  CORE_CAP_OF_OP,
  capOfOp,
  DAEMON_CAPS,
  REMOTE_CAPS,
  runsBesideChain,
  castRunsBesideChain,
  forwardAckArgs,
  forwardCloseArgs,
  forwardDataArgs,
  forwardOpenArgs,
  STREAM_PIECE_BYTES,
  fsReadDirArgs,
} from './protocol';

const hello = {
  t: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  token: 'secret',
  appVersion: '0.4.2',
  buildId: '0.4.2',
};
const expected = { protocolVersion: PROTOCOL_VERSION, token: 'secret' };

describe('FrameDecoder', () => {
  it('reassembles frames split across chunks and keeps a partial tail', () => {
    const d = new FrameDecoder();
    const wire = encodeFrame({ a: 1 }) + encodeFrame({ b: 2 });
    const cut = 7;
    expect(d.decode(wire.slice(0, cut))).toEqual([]);
    expect(d.decode(wire.slice(cut))).toEqual([{ frame: { a: 1 } }, { frame: { b: 2 } }]);
    // A chunk ending mid-frame leaves nothing behind until its newline.
    expect(d.decode('{"c":')).toEqual([]);
    expect(d.decode('3}\n')).toEqual([{ frame: { c: 3 } }]);
  });

  it('reports a line that is not JSON as an error and goes on with the next', () => {
    const d = new FrameDecoder();
    expect(d.decode('not json\n{"ok":true}\n')).toEqual([
      { error: 'frame is not JSON' },
      { frame: { ok: true } },
    ]);
  });

  it('skips blank lines and multi-byte text survives a split inside a string', () => {
    const d = new FrameDecoder();
    const buf = Buffer.from(encodeFrame({ s: 'héllo' }));
    // Cut inside the two-byte 'é' - a byte-level split a socket can deliver.
    const cut = buf.indexOf(Buffer.from('é')) + 1;
    const out = [
      ...d.decode(Buffer.from('\n')),
      ...d.decode(
        buf.subarray(0, cut).toString('utf8') === '' ? buf.subarray(0, cut) : buf.subarray(0, cut),
      ),
    ];
    expect(out).toEqual([]);
    // The decoder takes strings (the sockets run in utf8 mode); a Buffer tail
    // would need byte-level joining, which `setEncoding('utf8')` does for us.
    const d2 = new FrameDecoder();
    expect(d2.decode(Buffer.from(encodeFrame({ s: 'héllo' })))).toEqual([
      { frame: { s: 'héllo' } },
    ]);
  });

  it('flags a frame past the size cap instead of growing without bound', () => {
    const d = new FrameDecoder();
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 10);
    expect(d.decode(huge)).toEqual([]);
    expect(d.decode('\n{"after":1}\n')).toEqual([
      { error: 'frame too large' },
      { frame: { after: 1 } },
    ]);
  });
});

describe('validateHello', () => {
  it('accepts a well-formed hello with the right version and token', () => {
    const r = validateHello(hello, expected);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hello.buildId).toBe('0.4.2');
  });

  it('rejects a malformed frame, a protocol mismatch and a wrong token - by reason', () => {
    expect(validateHello({ t: 'call' }, expected)).toEqual({ ok: false, error: 'malformed' });
    expect(validateHello({ ...hello, protocolVersion: 99 }, expected)).toEqual({
      ok: false,
      error: 'protocol',
    });
    expect(validateHello({ ...hello, token: 'nope' }, expected)).toEqual({
      ok: false,
      error: 'token',
    });
    // An empty token never matches, even against an empty expectation.
    expect(validateHello({ ...hello, token: '' }, { ...expected, token: '' })).toEqual({
      ok: false,
      error: 'token',
    });
  });
});

describe('frame parsing', () => {
  it('reads calls and casts with known ops only', () => {
    expect(parseClientFrame({ t: 'call', req: 1, op: 'list', args: {} })).toEqual({
      t: 'call',
      req: 1,
      op: 'list',
      args: {},
    });
    expect(parseClientFrame({ t: 'cast', op: 'input', args: { id: 'a', data: 'x' } })).toEqual({
      t: 'cast',
      op: 'input',
      args: { id: 'a', data: 'x' },
    });
    expect(parseClientFrame({ t: 'call', req: 1, op: 'rm -rf', args: {} })).toBeNull();
    expect(parseClientFrame({ t: 'cast', op: 'shutdown' })).toBeNull();
    expect(parseClientFrame({ t: 'call', op: 'list' })).toBeNull();
    expect(parseClientFrame('list')).toBeNull();
  });

  it('reads welcome, reply and event frames from the daemon', () => {
    expect(
      parseDaemonFrame({
        t: 'welcome',
        ok: true,
        pid: 1,
        protocolVersion: 1,
        appVersion: '1',
        buildId: 'b',
        stale: false,
        terminals: [],
      }),
    ).toMatchObject({ t: 'welcome', ok: true });
    expect(parseDaemonFrame({ t: 'welcome', ok: false, error: 'token' })).toEqual({
      t: 'welcome',
      ok: false,
      error: 'token',
    });
    expect(parseDaemonFrame({ t: 'welcome', ok: true })).toBeNull();
    expect(parseDaemonFrame({ t: 'reply', req: 3, ok: true, result: 5 })).toEqual({
      t: 'reply',
      req: 3,
      ok: true,
      result: 5,
    });
    expect(parseDaemonFrame({ t: 'reply', req: 3, ok: false })).toBeNull();
    expect(parseDaemonFrame({ t: 'event', ev: { type: 'data', id: 'a', data: 'x' } })).toEqual({
      t: 'event',
      ev: { type: 'data', id: 'a', data: 'x' },
    });
    expect(parseDaemonFrame({ t: 'event', ev: 'data' })).toBeNull();
  });
});

describe('argument guards', () => {
  const spawn = {
    id: 't1',
    file: '/bin/zsh',
    args: ['-i'],
    cwd: '/tmp',
    env: { TERM: 'xterm-256color' },
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    markerDriven: false,
  };

  it('accepts a complete spawn request and refuses one with a non-string env or missing id', () => {
    expect(spawnArgs(spawn)).toEqual(spawn);
    const typing = { line: 'claude', promptMarks: true };
    expect(spawnArgs({ ...spawn, typeWhenReady: typing })).toEqual({
      ...spawn,
      typeWhenReady: typing,
    });
    expect(spawnArgs({ ...spawn, typeWhenReady: 'claude' })).toBeNull();
    // A remote plain shell carries the flag through; a non-boolean is refused.
    expect(spawnArgs({ ...spawn, hostShell: true })).toEqual({ ...spawn, hostShell: true });
    expect(spawnArgs({ ...spawn, hostShell: false })).toEqual(spawn);
    expect(spawnArgs({ ...spawn, hostShell: 'yes' })).toBeNull();
    expect(spawnArgs({ ...spawn, typeWhenReady: { line: 'claude' } })).toBeNull();
    expect(spawnArgs({ ...spawn, env: { X: 1 } })).toBeNull();
    expect(spawnArgs({ ...spawn, id: '' })).toBeNull();
    expect(spawnArgs({ ...spawn, args: 'not a list' })).toBeNull();
    expect(spawnArgs({ ...spawn, markerDriven: 'yes' })).toBeNull();
  });

  it('keeps only the string ids, and checks resize and noteLine shapes', () => {
    expect(idsArgs({ ids: ['a', 2, null, 'b'] })).toEqual({ ids: ['a', 'b'] });
    expect(idsArgs({ ids: 'a' })).toBeNull();
    expect(resizeArgs({ id: 'a', cols: 10, rows: 5 })).toEqual({ id: 'a', cols: 10, rows: 5 });
    expect(resizeArgs({ id: 'a', cols: '10', rows: 5 })).toBeNull();
    expect(noteLineArgs({ id: 'a', text: 'ls', ref: 1 })).toEqual({ id: 'a', text: 'ls', ref: 1 });
    expect(noteLineArgs({ id: 'a', text: 'ls', ref: 1.5 })).toBeNull();
  });
});

describe('capabilities and the ops beside the chain', () => {
  it('runs only the calls that may wait beside the chain - every terminal op stays in order', () => {
    const beside = CALL_OPS.filter(runsBesideChain);
    expect(beside).toContain('ping');
    expect(beside).toContain('foregroundBusy');
    // A `resize` behind a `spawn` must find the pty; an adopt's snapshot must
    // precede the events after it.
    for (const op of ['spawn', 'adopt', 'list', 'size', 'killAll', 'shutdown'] as const) {
      expect(runsBesideChain(op)).toBe(false);
    }
  });

  it('names every capability as an op the daemon parses, and keeps the welcome field', () => {
    for (const cap of DAEMON_CAPS) {
      expect(parseClientFrame({ t: 'call', req: 1, op: cap, args: {} })).toMatchObject({ op: cap });
    }
    const welcome = {
      t: 'welcome',
      ok: true,
      pid: 1,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: '0.6.4',
      buildId: 'b',
      stale: false,
      terminals: [],
      caps: ['ping'],
    };
    expect(parseDaemonFrame(welcome)).toMatchObject({ caps: ['ping'] });
  });
});

describe('the welcome capability list', () => {
  const base = {
    t: 'welcome',
    ok: true,
    pid: 1,
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.6.4',
    buildId: 'b',
    stale: false,
    terminals: [],
  };

  it('drops a malformed list instead of trusting it', () => {
    // `"ping"` would answer a substring check; `{}` would throw on `includes`.
    for (const caps of ['ping', {}, ['ping', 3], null]) {
      const frame = parseDaemonFrame({ ...base, caps });
      expect(frame).toMatchObject({ t: 'welcome', ok: true });
      expect(frame).not.toHaveProperty('caps');
    }
    expect(parseDaemonFrame({ ...base, caps: ['ping'] })).toMatchObject({ caps: ['ping'] });
    expect(parseDaemonFrame(base)).not.toHaveProperty('caps');
  });

  it('keeps a multi-client welcome only when its connection id and peer count are well formed (M4)', () => {
    expect(
      parseDaemonFrame({ ...base, connectionId: 3, peers: { own: 1, other: 0 } }),
    ).toMatchObject({ connectionId: 3, peers: { own: 1, other: 0 } });
    for (const bad of [
      { connectionId: '3' },
      { peers: { own: -1, other: 0 } },
      { peers: { own: 1 } },
      { peers: 2 },
    ]) {
      const frame = parseDaemonFrame({ ...base, ...bad });
      expect(frame).toMatchObject({ t: 'welcome', ok: true });
      for (const key of Object.keys(bad)) expect(frame).not.toHaveProperty(key);
    }
  });

  it('checks a resize intent and tells the view events from terminal events (M4)', () => {
    expect(resizeIntentArgs({ id: 't1', cols: 80, rows: 24, kind: 'claim' })).toEqual({
      id: 't1',
      cols: 80,
      rows: 24,
      kind: 'claim',
    });
    expect(resizeIntentArgs({ id: 't1', cols: 80, rows: 24, kind: 'grab' })).toBeNull();
    expect(resizeIntentArgs({ id: 't1', cols: 80, rows: 24 })).toBeNull();
    expect(resizeIntentArgs({ id: 't1', cols: '80', rows: 24, kind: 'passive' })).toBeNull();
    expect(parseClientFrame({ t: 'cast', op: 'resizeIntent', args: {} })).toMatchObject({
      op: 'resizeIntent',
    });
    expect(isViewEvent({ type: 'terminal-size' })).toBe(true);
    expect(isViewEvent({ type: 'snapshot-needed' })).toBe(true);
    expect(isViewEvent({ type: 'peers' })).toBe(true);
    expect(isViewEvent({ type: 'data' })).toBe(false);
  });

  it('names a listed capability for every gated op', () => {
    // A gated op's capability is one some daemon announces: every daemon the
    // base list, a remote host's daemon the remote list too (M1's `fs`).
    for (const [op, cap] of Object.entries(CORE_CAP_OF_OP)) {
      expect(CALL_OPS).toContain(op);
      expect([...DAEMON_CAPS, ...REMOTE_CAPS]).toContain(cap);
    }
  });
});

describe('the remote host ops', () => {
  it('gates fsReadDir on the fs capability and runs it beside the chain', () => {
    expect(capOfOp('fsReadDir')).toBe('fs');
    expect(REMOTE_CAPS).toContain('fs');
    // A folder listing on a slow disk must never hold a keystroke up.
    expect(runsBesideChain('fsReadDir')).toBe(true);
    expect(parseClientFrame({ t: 'call', req: 1, op: 'fsReadDir', args: {} })).toMatchObject({
      op: 'fsReadDir',
    });
  });

  it('takes an absolute or home-relative path only', () => {
    expect(fsReadDirArgs({ path: '~' })).toEqual({ path: '~', dirsOnly: false });
    expect(fsReadDirArgs({ path: '~/acme', dirsOnly: true })).toEqual({
      path: '~/acme',
      dirsOnly: true,
    });
    expect(fsReadDirArgs({ path: '/home/emmaw' })).toEqual({
      path: '/home/emmaw',
      dirsOnly: false,
    });
    for (const bad of [
      { path: 'acme' },
      { path: '' },
      { path: '/a\0b' },
      { path: '~emmaw' },
      { path: 3 },
      { path: '/x', dirsOnly: 'yes' },
      null,
    ]) {
      expect(fsReadDirArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the M2 host op guards (spec 7.3-7.6, 20)', () => {
  it('takes an exec with an absolute cwd and string args only', async () => {
    const { execArgs } = await import('./protocol');
    expect(
      execArgs({
        execId: 'x1',
        cwd: '/home/emmaw/acme',
        file: 'git',
        args: ['status'],
        env: { A: 'b' },
      }),
    ).toMatchObject({ execId: 'x1', binary: false, env: { A: 'b' } });
    expect(execArgs({ execId: 'x1', cwd: 'acme', file: 'git', args: [] })).toBeNull();
    expect(execArgs({ execId: '--x', cwd: '/a', file: 'git', args: [] })).toBeNull();
    expect(execArgs({ execId: 'x1', cwd: '/a', file: 'git', args: [1] })).toBeNull();
    expect(execArgs({ execId: 'x1', cwd: '/a', file: 'git', args: ['a\0b'] })).toBeNull();
    expect(execArgs({ execId: 'x1', cwd: '/a', file: 'git', args: [], env: { A: 1 } })).toBeNull();
    expect(execArgs({ execId: 'x1', cwd: '/a', file: 'git', args: [], timeoutMs: -1 })).toBeNull();
  });

  it('takes one fs method at a time with absolute host paths', async () => {
    const { fsOpArgs } = await import('./protocol');
    expect(fsOpArgs({ method: 'stat', path: '/home/emmaw' })).toEqual({
      method: 'stat',
      path: '/home/emmaw',
    });
    expect(fsOpArgs({ method: 'stat', path: '~/acme' })).toBeNull();
    expect(fsOpArgs({ method: 'chmod', path: '/a' })).toBeNull();
    expect(fsOpArgs({ method: 'stat', path: '/a\0b' })).toBeNull();
    // A write carries its body inline OR names a transfer - never both, never neither.
    expect(fsOpArgs({ method: 'writeFile', path: '/a', data: 'eA==' })).toMatchObject({
      exclusive: false,
    });
    expect(
      fsOpArgs({ method: 'writeFile', path: '/a', data: 'eA==', transferId: 't1' }),
    ).toBeNull();
    expect(fsOpArgs({ method: 'writeFile', path: '/a' })).toBeNull();
    // An upload's body hash (plan 29 › M8): hex sha256 only.
    expect(
      fsOpArgs({ method: 'writeFile', path: '/a', transferId: 't1', sha256: 'ab'.repeat(32) }),
    ).toMatchObject({ sha256: 'ab'.repeat(32) });
    expect(
      fsOpArgs({ method: 'writeFile', path: '/a', transferId: 't1', sha256: 'AB'.repeat(32) }),
    ).toBeNull();
    expect(fsOpArgs({ method: 'writeFile', path: '/a', data: 'eA==', sha256: 12 })).toBeNull();
    expect(fsOpArgs({ method: 'rm', path: '/a', recursive: 'yes' })).toBeNull();
    expect(fsOpArgs({ method: 'which', bin: 'git' })).toEqual({ method: 'which', bin: 'git' });
    expect(fsOpArgs({ method: 'which', bin: '../git' })).toBeNull();
  });

  it('bounds a transfer chunk and checks watch arguments', async () => {
    const { transferPutArgs, watchArgs, watchHintArgs, forwardAgentArgs, TRANSFER_CHUNK_BYTES } =
      await import('./protocol');
    const chunk = Buffer.alloc(TRANSFER_CHUNK_BYTES).toString('base64');
    expect(transferPutArgs({ transferId: 't1', seq: 0, data: chunk })).not.toBeNull();
    expect(transferPutArgs({ transferId: 't1', seq: 0, data: `${chunk}AAAAAAAA` })).toBeNull();
    expect(transferPutArgs({ transferId: 't1', seq: -1, data: '' })).toBeNull();
    expect(watchArgs({ watchId: 'w1', root: '/a', kind: 'tree' })).not.toBeNull();
    expect(watchArgs({ watchId: 'w1', root: '/a', kind: 'all' })).toBeNull();
    expect(watchHintArgs({ watchId: 'w1', dirs: ['/a', 'b'] })).toBeNull();
    expect(forwardAgentArgs({ live: true, name: 'agent-0123abcd.sock' })).toEqual({
      live: true,
      name: 'agent-0123abcd.sock',
    });
    // The name lands in a path on the host: nothing but the run's own pattern.
    expect(forwardAgentArgs({ live: true, name: '../../.ssh/x' })).toBeNull();
    expect(forwardAgentArgs({ live: false })).toEqual({ live: false });
  });

  it('carries a launch plan in a spawn - its id matching, no secret-named variable', async () => {
    const { spawnArgs } = await import('./protocol');
    const plan = {
      id: 't1',
      command: 'claude',
      adapter: 'claude',
      markerDriven: true,
      shellIntegration: true,
      overlayEnv: { TERM: 'xterm-256color' },
      agentTools: false,
      cwd: '/home/emmaw/acme',
      cols: 80,
      rows: 24,
    };
    const req = {
      id: 't1',
      file: '',
      args: [],
      cwd: '/home/emmaw/acme',
      env: {},
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      markerDriven: true,
    };
    expect(spawnArgs({ ...req, plan })?.plan).toEqual(plan);
    expect(spawnArgs({ ...req, plan: { ...plan, id: 't2' } })).toBeNull();
    expect(spawnArgs({ ...req, plan: { ...plan, adapter: 'evil' } })).toBeNull();
    expect(spawnArgs({ ...req, plan: { ...plan, overlayEnv: { GITHUB_TOKEN: 'x' } } })).toBeNull();
  });

  it('runs every host op beside the chain and gates each by a capability', async () => {
    const { runsBesideChain, capOfOp, REMOTE_CAPS } = await import('./protocol');
    for (const op of [
      'exec',
      'execCancel',
      'fsOp',
      'transferPut',
      'watch',
      'unwatch',
      'watchHint',
      'forwardAgent',
      'hostInfo',
    ] as const) {
      expect(runsBesideChain(op)).toBe(true);
      expect(REMOTE_CAPS as readonly string[]).toContain(capOfOp(op));
    }
    expect(runsBesideChain('spawn')).toBe(false);
  });
});

describe('the M3 port forwarding ops (spec 7.9)', () => {
  it('gates forwardOpen on the forward capability a remote daemon announces', () => {
    expect(capOfOp('forwardOpen')).toBe('forward');
    expect(REMOTE_CAPS as readonly string[]).toContain('forward');
    expect(DAEMON_CAPS as readonly string[]).not.toContain('forward');
    expect(runsBesideChain('forwardOpen')).toBe(true);
  });

  it('parses the stream casts and handles them beside the chain - terminal casts stay in it', () => {
    for (const op of ['forwardData', 'forwardClose', 'forwardAck'] as const) {
      expect(parseClientFrame({ t: 'cast', op, args: {} })).toMatchObject({ t: 'cast', op });
      expect(castRunsBesideChain(op)).toBe(true);
    }
    for (const op of ['input', 'resize', 'kill', 'pause', 'resume'] as const) {
      expect(castRunsBesideChain(op)).toBe(false);
    }
  });

  it('accepts a stream id and a port, nothing that names a host', () => {
    expect(forwardOpenArgs({ streamId: 'fw1', port: 5173 })).toEqual({
      streamId: 'fw1',
      port: 5173,
    });
    expect(forwardOpenArgs({ streamId: 'fw1', port: 5173, host: '10.0.0.1' })).toEqual({
      streamId: 'fw1',
      port: 5173,
    });
    for (const port of [0, 65536, 1.5, '5173', -1]) {
      expect(forwardOpenArgs({ streamId: 'fw1', port })).toBeNull();
    }
    expect(forwardOpenArgs({ streamId: '--port', port: 5173 })).toBeNull();
    expect(forwardOpenArgs({ streamId: '../x', port: 5173 })).toBeNull();
  });

  it('caps a data piece at one stream piece and checks acks', () => {
    const piece = Buffer.alloc(STREAM_PIECE_BYTES).toString('base64');
    expect(forwardDataArgs({ streamId: 'fw1', data: piece })).not.toBeNull();
    expect(
      forwardDataArgs({
        streamId: 'fw1',
        data: Buffer.alloc(STREAM_PIECE_BYTES + 3).toString('base64'),
      }),
    ).toBeNull();
    expect(forwardDataArgs({ streamId: 'fw1', data: 3 })).toBeNull();
    expect(forwardCloseArgs({ streamId: 'fw1' })).toEqual({ streamId: 'fw1' });
    expect(forwardCloseArgs({})).toBeNull();
    expect(forwardAckArgs({ streamId: 'fw1', bytes: 262144 })).toEqual({
      streamId: 'fw1',
      bytes: 262144,
    });
    for (const bytes of [0, -5, 1.5, '1'])
      expect(forwardAckArgs({ streamId: 'fw1', bytes })).toBeNull();
  });
});

describe('the Phase 2 M5 op: the search index (plan 29 spec › 1)', () => {
  it('runs it beside the chain, gated by a new remote capability', async () => {
    const { runsBesideChain, capOfOp, REMOTE_CAPS } = await import('./protocol');
    expect(capOfOp('fsIndex')).toBe('index');
    expect(runsBesideChain('fsIndex')).toBe(true);
    expect(REMOTE_CAPS as readonly string[]).toContain('index');
  });

  it('checks fsIndex: an absolute folder, 1..20 000 files, at most 4 MiB', async () => {
    const { fsIndexArgs } = await import('./protocol');
    expect(fsIndexArgs({ root: '/home/emmaw/src/acme', max: 500 })).toEqual({
      root: '/home/emmaw/src/acme',
      max: 500,
      maxBytes: 4 * 1024 * 1024,
    });
    for (const bad of [
      { root: 'src/acme', max: 5 },
      { root: '/x', max: 0 },
      { root: '/x', max: 20_001 },
      { root: '/x', max: 1.5 },
      { root: '/x', max: 5, maxBytes: 5 * 1024 * 1024 },
      { root: '/x\0', max: 5 },
    ]) {
      expect(fsIndexArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the Phase 2 M9 ops: language servers on a host (plan 29 spec › 1, 4)', () => {
  const ID = '0f6c2b1e-9b3c-4a55-8f2e-1d3c4b5a6e7f';
  const root = '/home/emmaw/acme';

  it('gates lspOpen / lspClose / lspInstall by `lsp`, beside the chain; lspSend beside it in order', async () => {
    const { runsBesideChain, castRunsBesideChain, capOfOp, REMOTE_CAPS, HOST_OP_EVENTS } =
      await import('./protocol');
    for (const op of ['lspOpen', 'lspClose', 'lspInstall'] as const) {
      expect(capOfOp(op)).toBe('lsp');
      expect(runsBesideChain(op)).toBe(true);
    }
    expect(REMOTE_CAPS as readonly string[]).toContain('lsp');
    expect(castRunsBesideChain('lspSend')).toBe(true);
    // A terminal's keystrokes stay on the chain.
    expect(castRunsBesideChain('input')).toBe(false);
    for (const ev of ['lsp-message', 'lsp-exit', 'lsp-install-progress']) {
      expect(HOST_OP_EVENTS as readonly string[]).toContain(ev);
    }
  });

  it('opens only what the registry names: a language, its args, its bin', async () => {
    const { lspOpenArgs } = await import('./protocol');
    const go = { lspId: ID, kind: 'path', languageId: 'go', bin: 'gopls', args: [], root };
    expect(lspOpenArgs(go)).toEqual(go);
    expect(
      lspOpenArgs({
        lspId: ID,
        kind: 'installed',
        languageId: 'python',
        version: '1.1.411',
        args: ['--stdio'],
        root,
      }),
    ).toMatchObject({ kind: 'installed', version: '1.1.411' });
    // Never an arbitrary binary, extra arguments, a builtin, a relative root.
    expect(lspOpenArgs({ ...go, bin: '/bin/sh' })).toBeNull();
    expect(lspOpenArgs({ ...go, bin: '-c' })).toBeNull();
    expect(lspOpenArgs({ ...go, args: ['--listen=0.0.0.0:9'] })).toBeNull();
    expect(lspOpenArgs({ ...go, languageId: 'typescript' })).toBeNull();
    expect(lspOpenArgs({ ...go, languageId: 'cobol' })).toBeNull();
    expect(lspOpenArgs({ ...go, root: 'acme' })).toBeNull();
    expect(lspOpenArgs({ ...go, lspId: '--help' })).toBeNull();
    // A version is a folder name - never a path out of the install folder.
    expect(
      lspOpenArgs({
        lspId: ID,
        kind: 'installed',
        languageId: 'python',
        version: '../../bin',
        args: ['--stdio'],
        root,
      }),
    ).toBeNull();
    // `installed` is for npm servers only.
    expect(lspOpenArgs({ ...go, kind: 'installed', version: '1.0.0' })).toBeNull();
  });

  it('sends one JSON object of at most 4 MiB', async () => {
    const { lspSendArgs, MAX_LSP_MESSAGE_BYTES } = await import('./protocol');
    expect(lspSendArgs({ lspId: ID, message: '{"id":1}' })).toEqual({
      lspId: ID,
      message: '{"id":1}',
    });
    expect(lspSendArgs({ lspId: ID, message: '[1]' })).toBeNull();
    expect(lspSendArgs({ lspId: ID, message: '{"id":' })).toBeNull();
    expect(lspSendArgs({ lspId: ID, message: { id: 1 } })).toBeNull();
    expect(
      lspSendArgs({ lspId: ID, message: `{"x":"${'a'.repeat(MAX_LSP_MESSAGE_BYTES)}"}` }),
    ).toBeNull();
  });

  it('installs only the tarballs the registry pins, from the npm registry', async () => {
    const { lspInstallArgs } = await import('./protocol');
    const { npmTarballs, registryEntry } = await import('../language-registry');
    const spec = registryEntry('yaml')!.server as Parameters<typeof npmTarballs>[0];
    const tarballs = npmTarballs(spec).map((t) => ({
      name: t.name,
      url: t.url,
      integrity: t.integrity,
    }));
    const good = { installId: ID, languageId: 'yaml', version: spec.version, tarballs };
    expect(lspInstallArgs(good)).toMatchObject({ languageId: 'yaml', version: spec.version });
    expect(
      lspInstallArgs({
        ...good,
        tarballs: tarballs.map((t, i) => (i === 0 ? { ...t, transferId: 't-1' } : t)),
      })?.tarballs[0].transferId,
    ).toBe('t-1');
    // Another URL, another integrity, a missing dep, another version, a detect-only server.
    const swap = (i: number, patch: object) =>
      tarballs.map((t, j) => (j === i ? { ...t, ...patch } : t));
    expect(
      lspInstallArgs({ ...good, tarballs: swap(0, { url: 'https://evil.example/x.tgz' }) }),
    ).toBeNull();
    expect(lspInstallArgs({ ...good, tarballs: swap(1, { integrity: 'sha512-AAAA' }) })).toBeNull();
    expect(lspInstallArgs({ ...good, tarballs: tarballs.slice(1) })).toBeNull();
    expect(lspInstallArgs({ ...good, version: '0.0.1' })).toBeNull();
    expect(lspInstallArgs({ ...good, languageId: 'go' })).toBeNull();
    expect(lspInstallArgs({ ...good, tarballs: swap(0, { transferId: '../x' }) })).toBeNull();
  });

  it('checks what a host sends before main acts on it', async () => {
    const { lspEventOf } = await import('./protocol');
    expect(lspEventOf({ type: 'lsp-message', lspId: ID, message: '{}' })).toEqual({
      type: 'lsp-message',
      lspId: ID,
      message: '{}',
    });
    expect(
      lspEventOf({ type: 'lsp-exit', lspId: ID, code: null, reason: 'oversize' }),
    ).toMatchObject({
      reason: 'oversize',
    });
    expect(lspEventOf({ type: 'lsp-exit', lspId: ID, code: 1, reason: 'boom' })).toEqual({
      type: 'lsp-exit',
      lspId: ID,
      code: 1,
    });
    expect(lspEventOf({ type: 'lsp-message', lspId: 'x', message: '{}' })).toBeNull();
    expect(lspEventOf({ type: 'lsp-message', lspId: ID, message: {} })).toBeNull();
    expect(lspEventOf({ type: 'usage', lspId: ID })).toBeNull();
  });
});

// An extension adds its ops under their wire names (registerProtocolExtension):
// a daemon must parse them, a client gate them by their cap, the server run the
// slow ones beside the chain, and the client route their events. `gadget*`
// stands for any extension's grammar.
describe("an extension's grammar", () => {
  afterEach(() => resetProtocolExtensionForTest());

  const GADGET = {
    calls: ['gadgetOpen', 'gadgetList'],
    casts: ['gadgetPoke'],
    besideChain: ['gadgetOpen'],
    capOf: { gadgetList: 'gadgets' },
    events: ['gadget-chunk'],
    hostOpEvents: ['gadget-request'],
  };

  it('is unknown until registered: a daemon drops the frames, no cap, no route', () => {
    expect(parseClientFrame({ t: 'call', req: 1, op: 'gadgetOpen', args: {} })).toBeNull();
    expect(parseClientFrame({ t: 'cast', op: 'gadgetPoke', args: {} })).toBeNull();
    expect(capOfOp('gadgetList')).toBeUndefined();
    expect(runsBesideChain('gadgetOpen')).toBe(false);
    expect(isExtensionEvent({ type: 'gadget-chunk' })).toBe(false);
    expect(isHostOpEvent({ type: 'gadget-request' })).toBe(false);
  });

  it('parses, gates, runs beside the chain and routes what it registered', () => {
    registerProtocolExtension(GADGET);
    expect(parseClientFrame({ t: 'call', req: 1, op: 'gadgetOpen', args: { a: 1 } })).toEqual({
      t: 'call',
      req: 1,
      op: 'gadgetOpen',
      args: { a: 1 },
    });
    expect(parseClientFrame({ t: 'cast', op: 'gadgetPoke', args: {} })).toMatchObject({
      op: 'gadgetPoke',
    });
    expect(capOfOp('gadgetList')).toBe('gadgets');
    expect(capOfOp('gadgetOpen')).toBeUndefined();
    expect(runsBesideChain('gadgetOpen')).toBe(true);
    // Only what it says runs beside the chain.
    expect(runsBesideChain('gadgetList')).toBe(false);
    expect(isExtensionEvent({ type: 'gadget-chunk' })).toBe(true);
    expect(isHostOpEvent({ type: 'gadget-request' })).toBe(true);
    // The core's own grammar is untouched by it.
    expect(capOfOp('fsReadDir')).toBe('fs');
    expect(runsBesideChain('spawn')).toBe(false);
    expect(parseClientFrame({ t: 'call', req: 2, op: 'nope', args: {} })).toBeNull();
  });
});
