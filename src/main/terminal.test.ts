import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import {
  CLAUDE_SHIM_DIR_NAME,
  CLAUDE_SHIM_SCRIPT,
  CODEX_SHIM_SCRIPT,
  OPENCODE_SHIM_SCRIPT,
} from './claude-shim';
import { STATUS_HOOK_SCRIPT } from './claude-status-hooks';
import { CODEX_HOOKS_FILE_NAME, codexHooksFile } from './codex-status-hooks';
import {
  OPENCODE_PLUGIN_DIR_NAME,
  OPENCODE_PLUGIN_FILE_NAME,
  OPENCODE_STATUS_PLUGIN,
} from './opencode-status-plugin';
import { agentFilesRoot } from './private-tmp';
import {
  SHELL_INTEGRATION_DIR_NAME,
  ZSH_INTEGRATION_FOLDER,
  zshIntegrationFiles,
} from './shell-integration';
import {
  AFTER_PROMPT_QUIET_MS,
  LAUNCH_ENV,
  LAUNCH_LINE,
  MAX_WAIT_MS,
  UNMARKED_QUIET_MS,
  launchScript,
} from './startup-typer';

/**
 * The terminal IPC around the status-marker protocol, driven through the REAL
 * ipcMain handlers (see git.test.ts for the pattern): how a start command is
 * launched (a plain `claude` through the adapter, anything else through the
 * `claude` PATH shim, a bare shell untouched) and what `terminal:markerDriven`
 * tells a renderer that observes a pty afresh.
 *
 * node-pty is replaced by a recorder - the launch line is the thing under test
 * here; the shim itself runs under a real shell in claude-shim.test.ts.
 *
 * TMPDIR is moved to a scratch folder BEFORE the first spawn: terminal.ts
 * writes the hook script, its settings file and the shim into the OS temp
 * folder, which is the same one the user's running app launched its agents
 * against - a test writing there would swap the live sessions' hook script.
 */

type FakePty = {
  file: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  process: string;
  emit: (data: string) => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  /** The shell exits (node-pty's onExit). */
  exit: (exitCode: number) => void;
  /** Everything main typed into the pty (the colour-scheme push). */
  written: string[];
  write: (data: string) => void;
  resize: () => void;
  /** The signals main sent the shell (`undefined` = node-pty's default SIGHUP). */
  killed: Array<string | undefined>;
  kill: (signal?: string) => void;
  pause: () => void;
  resume: () => void;
};

const { onHandlers, invokeHandlers, spawned } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  invokeHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  spawned: [] as FakePty[],
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: () => join(process.env.TMPDIR ?? '', 'userData'),
  },
  ipcMain: {
    on: (channel: string, fn: (event: unknown, payload: unknown) => void) => {
      onHandlers.set(channel, fn);
    },
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      invokeHandlers.set(channel, fn);
    },
  },
}));
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: (
    file: string,
    args: string[],
    opts: { cols: number; rows: number; env: Record<string, string> },
  ) => {
    let dataCb: (data: string) => void = () => {};
    const exitCbs: Array<(e: { exitCode: number }) => void> = [];
    const pty: FakePty = {
      file,
      args,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
      process: 'zsh',
      emit: (data) => dataCb(data),
      onData: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCbs.push(cb);
      },
      exit: (exitCode) => {
        for (const cb of exitCbs) cb({ exitCode });
      },
      written: [],
      write: (data) => {
        pty.written.push(data);
      },
      resize: () => {},
      killed: [],
      kill: (signal) => {
        pty.killed.push(signal);
      },
      pause: () => {},
      resume: () => {},
    };
    spawned.push(pty);
    return pty;
  },
}));

const realTmp = tmpdir();
const scratch = mkdtempSync(join(realTmp, 'double0-terminal-test-'));
// Where terminal.ts writes the hook files, shims and plugin: TMPDIR itself,
// or a private `double0-<uid>` folder inside it on Linux (private-tmp.ts).
const agentDir = agentFilesRoot(process.platform, scratch)!;
/** A local shell's arguments: a login shell on macOS (launch-materialize.ts › loginShellArgs). */
const LOGIN_ARGS = process.platform === 'darwin' ? ['-l'] : [];
const saved = {
  TMPDIR: process.env.TMPDIR,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  SHELL: process.env.SHELL,
};

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const sender = { id: 1, mainFrame, isDestroyed: () => false, send: vi.fn() };
const trusted = { senderFrame: mainFrame, sender };
const untrusted = {
  senderFrame: { url: 'https://evil.example.com/' },
  sender: { ...sender, mainFrame: { url: 'https://evil.example.com/' } },
};

const TAB = '5b0c3a1e-7f2d-4c8e-9a61-2d4f8e0b7c13';
const OTHER_TAB = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const marker = (verb: string): string => `\x1b]6790;${verb}\x07`;

/**
 * The Claude settings file a spawn was pointed at - named by its contents
 * (launch-materialize.ts › contentFileName), so read off the spawn itself.
 */
const hooksOf = (pty: { env: Record<string, string> }): string => {
  const path = pty.env.DOUBLE0_CLAUDE_HOOKS;
  expect(path).toMatch(/double0-claude-status-hooks-[0-9a-f]{12}\.json$/);
  return path;
};

describe.skipIf(process.platform === 'win32')('terminal launch + marker mode', () => {
  let disposeIpc: () => Promise<void>;
  let requestReplayForOwner: (id: string, wcId: number) => void;

  beforeAll(async () => {
    process.env.TMPDIR = scratch;
    // The transcript check reads the Claude config dir - keep it off the
    // user's real ~/.claude.
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude-config');
    // The launch shell is $SHELL - pinned so the runner's own shell can't
    // change what these tests see.
    process.env.SHELL = '/bin/zsh';
    const terminal = await import('./terminal');
    requestReplayForOwner = terminal.requestReplayForOwner;
    disposeIpc = terminal.registerTerminalIpc();
  });
  afterEach(() => {
    vi.useRealTimers();
    void disposeIpc?.();
    // The fake shells never die on a kill: report every exit, so no test leaves
    // a shell the next one's quit would wait on.
    for (const pty of spawned) pty.exit(0);
    spawned.length = 0;
    sender.send.mockClear();
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Create a terminal the way a tab does, and hand back the pty it spawned. */
  const create = async (
    id: string,
    initialCommand?: string,
    extra: Record<string, unknown> = {},
  ): Promise<FakePty> => {
    const before = spawned.length;
    onHandlers.get('terminal:create')!(trusted, { id, cwd: scratch, initialCommand, ...extra });
    // createOrAdopt awaits the cwd check before it spawns.
    await vi.waitFor(() => expect(spawned.length).toBe(before + 1));
    return spawned[before];
  };
  const integrationDir = join(agentDir, SHELL_INTEGRATION_DIR_NAME, ZSH_INTEGRATION_FOLDER);
  const markerDriven = async (payload: unknown, event: unknown = trusted): Promise<unknown> =>
    await invokeHandlers.get('terminal:markerDriven')!(event, payload);
  /**
   * An adopt's replay is a round trip to the backend (a daemon, in the app):
   * wait for it before reading what the window was sent.
   */
  const adopted = (): Promise<void> => new Promise((r) => setImmediate(r));
  /**
   * The start command a POSIX shell sources from the tab's launch script -
   * the shell itself starts plain (a login shell on macOS), the script's path
   * in its env.
   */
  const launchLine = (pty: FakePty): string => {
    expect(pty.args).toEqual(LOGIN_ARGS);
    const script = readFileSync(pty.env[LAUNCH_ENV], 'utf8');
    const preamble = launchScript('');
    expect(script.startsWith(preamble.slice(0, -2))).toBe(true);
    return script.slice(preamble.length - 1, -1);
  };

  describe('launching a start command', () => {
    it("runs an aliased claude through the shim, hooked and pinned to the tab's conversation", async () => {
      // The user's `claude-personal` alias: the adapter only reads a leading
      // `claude`, so before the shim this launched with no hooks at all and the
      // tab's status came from the output/quiet guesswork.
      const pty = await create(TAB, 'claude-personal');
      const line = launchLine(pty);
      const shimDir = join(agentDir, CLAUDE_SHIM_DIR_NAME);
      expect(line).toContain(`PATH='${shimDir}':"$PATH"`);
      expect(hooksOf(pty).startsWith(`${agentDir}/`)).toBe(true);
      expect(line).toContain(`DOUBLE0_CLAUDE_HOOKS='${hooksOf(pty)}'`);
      expect(line).toContain(`DOUBLE0_CLAUDE_SESSION='${TAB}'`);
      // A wrapper may reach `codex` instead: its record goes to its own folder.
      expect(line).toContain(
        `DOUBLE0_CODEX_SESSION_FILE='${join(scratch, 'userData', 'codex-sessions', TAB)}'`,
      );
      expect(line).toContain('DOUBLE0_TTY="$(tty)"');
      // The command runs as typed, then the pins are dropped before the user
      // gets the tab's shell back.
      expect(
        line.endsWith(
          `; claude-personal\nunset DOUBLE0_CLAUDE_SESSION DOUBLE0_SESSION_FILE DOUBLE0_CODEX_SESSION_FILE DOUBLE0_OPENCODE_SESSION_FILE`,
        ),
      ).toBe(true);
      // The shim the PATH entry names exists and is runnable.
      const shim = join(shimDir, 'claude');
      expect(readFileSync(shim, 'utf8')).toBe(CLAUDE_SHIM_SCRIPT);
      expect(statSync(shim).mode & 0o111).not.toBe(0);
    });

    it('writes the agent files again when the temp folder was swept under the app', async () => {
      // The files live in the temp folder and were written once per run: an
      // app open for days launched every new session against a settings file
      // the OS had removed ("Settings file not found").
      const settings = hooksOf(await create(TAB, 'claude'));
      const hook = join(agentDir, 'double0-status-hook.sh');
      const shim = join(agentDir, CLAUDE_SHIM_DIR_NAME, 'claude');
      const zshrc = join(integrationDir, '.zshrc');
      for (const file of [settings, hook, shim, zshrc]) rmSync(file);
      await create('conversation:swept', 'claude-personal');
      for (const file of [settings, hook, shim, zshrc]) expect(existsSync(file)).toBe(true);
      // A file the settings only point at brings them back too.
      rmSync(hook);
      await create('conversation:swept-again', 'claude');
      expect(existsSync(hook)).toBe(true);
    });

    it('still hands a plain `claude` to the adapter, not the shim', async () => {
      const pty = await create(TAB, 'claude');
      const line = launchLine(pty);
      expect(line).toContain(`claude --session-id ${TAB} `);
      expect(line).toContain(`--settings '${hooksOf(pty)}'`);
      expect(line).not.toContain(CLAUDE_SHIM_DIR_NAME);
    });

    it("injects no status line and names no capture without an extension's", async () => {
      // The core build: the user's own Claude status line stays theirs.
      const pty = await create(TAB, 'claude');
      expect(launchLine(pty)).not.toContain('DOUBLE0_USAGE_FILE');
      const settings = JSON.parse(readFileSync(hooksOf(pty), 'utf8')) as Record<string, unknown>;
      expect(settings).not.toHaveProperty('statusLine');
    });

    describe("an extension's status line capture", () => {
      const GADGET_LINE_SCRIPT = '#!/bin/sh\n# gadget status line\n';
      const captureFile = (id: string): string =>
        join(scratch, 'gadget-captures', `${encodeURIComponent(id)}.capture`);
      const forgotten: string[] = [];
      let setStatusLine: (typeof import('./terminal'))['setTerminalStatusLine'];
      beforeAll(async () => {
        setStatusLine = (await import('./terminal')).setTerminalStatusLine;
        setStatusLine({
          script: GADGET_LINE_SCRIPT,
          entry: (path) => ({ type: 'command', command: `'${path}'` }),
          capture: (ptyId) => captureFile(ptyId),
          forget: (ptyId) => forgotten.push(ptyId),
        });
      });
      afterAll(() => setStatusLine(null));

      it("names the tab's capture file for the adapter launch, and injects the status line", async () => {
        const pty = await create(TAB, 'claude');
        expect(launchLine(pty)).toContain(`DOUBLE0_USAGE_FILE='${captureFile(TAB)}'`);
        // The settings file runs the extension's script, which exists.
        const settings = JSON.parse(readFileSync(hooksOf(pty), 'utf8')) as {
          statusLine: { type: string; command: string };
        };
        const script = /^'(.+)'$/.exec(settings.statusLine.command)?.[1] ?? '';
        expect(script).toMatch(/double0-status-line-[0-9a-f]{12}\.sh$/);
        expect(dirname(script)).toBe(agentDir);
        expect(settings.statusLine).toEqual({ type: 'command', command: `'${script}'` });
        expect(readFileSync(script, 'utf8')).toBe(GADGET_LINE_SCRIPT);
        expect(statSync(script).mode & 0o111).not.toBe(0);
      });

      it('names it for a wrapper launch too, and keeps it after the command', async () => {
        // The wrapper may pick the account at runtime; only the agent it
        // reaches can say which, through this file.
        const line = launchLine(await create(TAB, 'claude-personal'));
        expect(line).toContain(`DOUBLE0_USAGE_FILE='${captureFile(TAB)}'`);
        expect(line).not.toMatch(/unset [^;]*DOUBLE0_USAGE_FILE/);
      });

      it('runs a codex start command with the codex shim first on PATH', async () => {
        const line = launchLine(await create(TAB, 'codex'));
        const shimDir = join(agentDir, CLAUDE_SHIM_DIR_NAME);
        expect(line).toContain(`PATH='${shimDir}':"$PATH"`);
        expect(line).toContain(`DOUBLE0_USAGE_FILE='${captureFile(TAB)}'`);
        expect(readFileSync(join(shimDir, 'codex'), 'utf8')).toBe(CODEX_SHIM_SCRIPT);
        expect(statSync(join(shimDir, 'codex')).mode & 0o111).not.toBe(0);
      });
      it("drops the tab's capture when the tab closes", async () => {
        await create(OTHER_TAB, 'claude');
        forgotten.length = 0;
        onHandlers.get('terminal:dispose')!(trusted, { id: OTHER_TAB });
        expect(forgotten).toContain(OTHER_TAB);
      });

      it("drops the tab's capture when its shell exits", async () => {
        // No tab close: the shell ended on its own (`exit`, a crash).
        const pty = await create(OTHER_TAB, 'claude');
        forgotten.length = 0;
        pty.exit(0);
        expect(forgotten).toEqual([OTHER_TAB]);
      });

      describe('the other agents', () => {
        it('hands a codex start command its hook overrides, through the shim', async () => {
          // The shim injects them as `-c` flags on the real binary; the file
          // lists one override per event, pointing at the shared hook script.
          const line = launchLine(await create(TAB, 'codex'));
          const hooks = join(agentDir, CODEX_HOOKS_FILE_NAME);
          expect(line).toContain(`DOUBLE0_CODEX_HOOKS='${hooks}'`);
          const script = join(agentDir, 'double0-status-hook.sh');
          expect(readFileSync(hooks, 'utf8')).toBe(codexHooksFile(script));
          expect(readFileSync(script, 'utf8')).toBe(STATUS_HOOK_SCRIPT);
          expect(statSync(script).mode & 0o111).not.toBe(0);
          // Not marker-driven until the stream proves it: Codex runs the hooks
          // only once the user has trusted them.
          expect(await markerDriven({ ids: [TAB] })).toEqual([]);
        });

        it('loads the status plugin into an opencode start command, and writes its shim', async () => {
          const line = launchLine(await create(TAB, 'opencode'));
          const plugin = join(agentDir, OPENCODE_PLUGIN_DIR_NAME, OPENCODE_PLUGIN_FILE_NAME);
          expect(line).toContain(
            `[ -n "\${OPENCODE_CONFIG_CONTENT:-}" ] || export OPENCODE_CONFIG_CONTENT='{"plugin":["file://${plugin}"]}'; opencode\n`,
          );
          expect(readFileSync(plugin, 'utf8')).toBe(OPENCODE_STATUS_PLUGIN);
          // The plugin keeps the tab's live session in its record file...
          const record = join(scratch, 'userData', 'opencode-sessions', TAB);
          expect(line).toContain(`DOUBLE0_OPENCODE_SESSION_FILE='${record}'`);
          expect(line).not.toContain('DOUBLE0_OPENCODE_SESSION=');
          // ...and the shim continues it next time.
          const shim = join(agentDir, CLAUDE_SHIM_DIR_NAME, 'opencode');
          expect(readFileSync(shim, 'utf8')).toBe(OPENCODE_SHIM_SCRIPT);
          expect(statSync(shim).mode & 0o111).not.toBe(0);
          expect(await markerDriven({ ids: [TAB] })).toEqual([]);
        });

        it("continues the tab's recorded OpenCode session, and forgets it when the tab closes", async () => {
          const record = join(scratch, 'userData', 'opencode-sessions', OTHER_TAB);
          writeFileSync(record, 'ses_efd99bf2cffe5s5wMVZhGkYukW', 'utf8');
          const line = launchLine(await create(OTHER_TAB, 'opencode'));
          expect(line).toContain(`DOUBLE0_OPENCODE_SESSION='ses_efd99bf2cffe5s5wMVZhGkYukW'`);
          expect(line).toMatch(/unset [^;]*DOUBLE0_OPENCODE_SESSION DOUBLE0_OPENCODE_SESSION_FILE/);
          onHandlers.get('terminal:dispose')!(trusted, { id: OTHER_TAB });
          expect(existsSync(record)).toBe(false);
        });

        it('leaves a malformed record out of the launch', async () => {
          const record = join(scratch, 'userData', 'opencode-sessions', OTHER_TAB);
          writeFileSync(record, "ses_x' or 1=1", 'utf8');
          expect(launchLine(await create(OTHER_TAB, 'opencode'))).not.toContain(
            'DOUBLE0_OPENCODE_SESSION=',
          );
        });
      });
    });

    it('leaves a bare shell alone - no start command, no shim, nothing typed', async () => {
      vi.useFakeTimers();
      const pty = await create(TAB);
      expect(pty.args).toEqual(LOGIN_ARGS);
      expect(pty.env[LAUNCH_ENV]).toBeUndefined();
      pty.emit('\x1b]6791;ps\x07% ');
      vi.advanceTimersByTime(MAX_WAIT_MS);
      expect(pty.written).toEqual([]);
    });

    it("types the launch line at the shell's first prompt, like the user would", async () => {
      // An rc that wraps or replaces the shell (Kiro's terminal wrapper) ran
      // the old `-i -c` line where the user's alias did not exist
      // (`command not found: claude-personal`); typed at the prompt it runs
      // wherever the user's own typing would.
      const pty = await create(TAB, 'claude-personal');
      vi.useFakeTimers();
      pty.emit('\x1b]6791;ps\x07% ');
      vi.advanceTimersByTime(AFTER_PROMPT_QUIET_MS);
      expect(pty.written).toEqual([`${LAUNCH_LINE}\r`]);
    });

    it('drops a launch script the shell never ran when the shell ends', async () => {
      const pty = await create(OTHER_TAB, 'claude-personal');
      const script = pty.env[LAUNCH_ENV];
      expect(existsSync(script)).toBe(true);
      expect(statSync(script).mode & 0o777).toBe(0o600);
      pty.exit(0);
      expect(existsSync(script)).toBe(false);
    });

    it('types the command itself when the launch shell is not POSIX', async () => {
      // fish has no `unset`, csh no `export`: the wrapped line would not parse,
      // and a worktree setup command that ran before would not run at all. No
      // integration marks its prompt, so the typing waits for a quiet start.
      process.env.SHELL = '/opt/homebrew/bin/fish';
      try {
        const pty = await create(TAB, 'claude-personal');
        vi.useFakeTimers();
        expect(pty.args).toEqual(LOGIN_ARGS);
        expect(pty.env[LAUNCH_ENV]).toBeUndefined();
        pty.emit('Welcome to fish\r\n> ');
        vi.advanceTimersByTime(UNMARKED_QUIET_MS);
        expect(pty.written).toEqual(['claude-personal\r']);
      } finally {
        process.env.SHELL = '/bin/zsh';
      }
    });
  });

  describe('terminal:markerDriven', () => {
    it('reports a shim-launched terminal only once its stream shows a status marker', async () => {
      const pty = await create(TAB, 'claude-personal');
      // Main cannot know at spawn whether the wrapper will reach `claude`.
      expect(await markerDriven({ ids: [TAB] })).toEqual([]);
      // An idle Claude Code repaints the whole screen every 30-60 s; output is
      // never proof of the protocol - that is what fed the running/finished loop.
      pty.emit(`\x1b[H\x1b[2J${'x'.repeat(3000)}\x07`);
      expect(await markerDriven({ ids: [TAB] })).toEqual([]);
      // SessionStart(startup) → ready: the hooks are live.
      pty.emit(marker('ready'));
      expect(await markerDriven({ ids: [TAB] })).toEqual([TAB]);
    });

    it('retires marker mode on ended and re-arms it on the /clear that follows', async () => {
      const pty = await create(TAB, 'claude-personal');
      pty.emit(marker('ready'));
      // SessionEnd: the agent is gone, a shell prompt remains - a renderer that
      // reloads now must use the fallback rules.
      pty.emit(marker('ended'));
      expect(await markerDriven({ ids: [TAB] })).toEqual([]);
      // `/clear` fires SessionEnd then SessionStart(clear) → finished.
      pty.emit(marker('finished'));
      expect(await markerDriven({ ids: [TAB] })).toEqual([TAB]);
    });

    it('reports an adapter launch from the start, until its agent ends', async () => {
      // A parked agent sends nothing, so a renderer observing it afresh (a
      // reload, a tear-off) must not wait for a first marker.
      const pty = await create(TAB, 'claude');
      expect(await markerDriven({ ids: [TAB] })).toEqual([TAB]);
      // The launch flag used to win forever: a reload after the agent exited
      // then ignored the plain shell's output as if a hooked agent sat there.
      pty.emit(marker('ended'));
      expect(await markerDriven({ ids: [TAB] })).toEqual([]);
    });

    it('answers only for known, marker-driven ids and ignores foreign or malformed asks', async () => {
      await create(TAB, 'claude');
      await create(OTHER_TAB);
      expect(await markerDriven({ ids: [TAB, OTHER_TAB, 'nope', 42, null] })).toEqual([TAB]);
      expect(await markerDriven({ ids: [TAB] }, untrusted)).toEqual([]);
      expect(await markerDriven({ ids: TAB })).toEqual([]);
      expect(await markerDriven(null)).toEqual([]);
    });
  });

  describe('terminal:agentStatus', () => {
    const agentStatus = async (payload: unknown, event: unknown = trusted): Promise<unknown> =>
      await invokeHandlers.get('terminal:agentStatus')!(event, payload);
    const tool = (verb: string, agent?: string): string =>
      `\x1b]6790;${verb};${Buffer.from(`Bash\nls\n${agent ? `${agent}\n` : ''}`).toString('base64')}\x07`;

    it('keeps a turn running while the agent is parked on a background subagent', async () => {
      // The bug: the renderer keeps each tab's state in memory, fed by the
      // markers it sees. After a reload mid-turn it had none, and an agent
      // whose Stop the hook held back (a background subagent still working)
      // sends nothing more - the tab sat unwashed with no dot while it worked.
      const pty = await create(TAB, 'claude-personal');
      pty.emit(marker('ready'));
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'idle' }]);
      pty.emit(marker('running'));
      pty.emit(tool('tool-done'));
      // Stop with the subagent running: no marker at all, only repaints.
      pty.emit(`\x1b[H\x1b[2J${'x'.repeat(3000)}\x07`);
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'running' }]);
      // The hand-back re-invokes the agent; its own Stop finishes the turn.
      pty.emit(marker('finished'));
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'idle' }]);
    });

    it("holds a wait against a subagent's tools", async () => {
      const pty = await create(TAB, 'claude');
      pty.emit(marker('needs-input'));
      pty.emit(tool('tool-done', 'general-purpose'));
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'needs-input' }]);
      pty.emit(tool('tool-done'));
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'running' }]);
    });

    it('reports an adapter launch as idle before its first marker and drops it once it ends', async () => {
      const pty = await create(TAB, 'claude');
      expect(await agentStatus({ ids: [TAB] })).toEqual([{ id: TAB, status: 'idle' }]);
      pty.emit(marker('running'));
      pty.emit(marker('ended'));
      // A plain shell prompt remains - main holds no verdict for it.
      expect(await agentStatus({ ids: [TAB] })).toEqual([]);
    });

    it('answers only for known, marker-driven ids and ignores foreign or malformed asks', async () => {
      const pty = await create(TAB, 'claude');
      pty.emit(marker('running'));
      // A plain shell - even a busy one - has no marker verdict.
      const shell = await create(OTHER_TAB);
      shell.emit('building...\r\n');
      expect(await agentStatus({ ids: [TAB, OTHER_TAB, 'nope', 42, null] })).toEqual([
        { id: TAB, status: 'running' },
      ]);
      expect(await agentStatus({ ids: [TAB] }, untrusted)).toEqual([]);
      expect(await agentStatus({ ids: TAB })).toEqual([]);
      expect(await agentStatus(null)).toEqual([]);
    });
  });

  describe('colour-scheme notifications (DECSET 2031)', () => {
    const setTone = (payload: unknown, event: unknown = trusted): void =>
      onHandlers.get('terminal:setTone')!(event, payload);
    const PUSH_DARK = '\x1b[?997;1n';
    const PUSH_LIGHT = '\x1b[?997;2n';

    it('tells a program that asked for tone reports about a flip, and never a plain shell', async () => {
      // Claude Code under theme "auto" picks its palette once, from the OSC 11
      // answer, and re-detects only on this push - xterm never sends it, so an
      // app light/dark flip left it painting the old tone's palette (pale diffs
      // and a white user bar on a dark theme).
      const agent = await create(TAB, 'claude');
      agent.emit('\x1b[?2031h');
      const shell = await create(OTHER_TAB);
      setTone({ dark: false });
      expect(agent.written).toEqual([PUSH_LIGHT]);
      setTone({ dark: true });
      expect(agent.written).toEqual([PUSH_LIGHT, PUSH_DARK]);
      // At a shell prompt the push would land as stray keystrokes.
      expect(shell.written).toEqual([]);
    });

    it('stops pushing once the program turns tone reports off', async () => {
      const agent = await create(TAB, 'claude');
      agent.emit('\x1b[?2031h');
      agent.emit('\x1b[?2031l');
      setTone({ dark: false });
      expect(agent.written).toEqual([]);
    });

    it('ignores a tone report from an untrusted sender or without a boolean', async () => {
      const agent = await create(TAB, 'claude');
      agent.emit('\x1b[?2031h');
      setTone({ dark: false }, untrusted);
      setTone({ dark: 'light' });
      setTone(null);
      expect(agent.written).toEqual([]);
    });

    it('replays a pending colour query to the adopting xterm, then re-asks for the tone', async () => {
      // An eager conversation pty starts Claude Code before its tab listens, so
      // its startup OSC 11 + DA1 reach no xterm and it waits on its dark
      // fallback. It ignores the push while that query is open, so the replay
      // must carry the query for the fresh xterm to answer - stripping it left
      // CC dark on a light app for good.
      setTone({ dark: false });
      const agent = await create(TAB, 'claude');
      agent.emit('\x1b[?2031h\x1b]11;?\x07\x1b[c');
      requestReplayForOwner(TAB, sender.id);
      sender.send.mockClear();
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      const replay = sender.send.mock.calls.find(([channel]) => channel === 'terminal:data')?.[1];
      expect(replay.data).toContain('\x1b]11;?\x07\x1b[c');
      expect(agent.written).toEqual([PUSH_LIGHT]);
    });
  });

  describe('shell integration + the input log', () => {
    const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
    const mark = (verb: string, payload?: string): string =>
      `\x1b]6791;${verb}${payload === undefined ? '' : `;${payload}`}\x07`;
    const pushed = (): unknown[] =>
      sender.send.mock.calls
        .filter(([channel]) => channel === 'terminal:inputs')
        .flatMap(([, p]) => (p as { entries: unknown[] }).entries);
    const inputList = async (payload: unknown, event: unknown = trusted): Promise<unknown> =>
      await invokeHandlers.get('terminal:inputList')!(event, payload);
    const noteInput = (payload: unknown, event: unknown = trusted): void =>
      onHandlers.get('terminal:noteInput')!(event, payload);

    it('starts zsh on the integration files, and leaves it off when asked', async () => {
      const pty = await create(TAB);
      expect(pty.env.ZDOTDIR).toBe(integrationDir);
      for (const [name, body] of Object.entries(zshIntegrationFiles())) {
        expect(readFileSync(join(integrationDir, name), 'utf8')).toBe(body);
      }
      const off = await create(OTHER_TAB, 'pnpm dev', { shellIntegration: false });
      expect(off.env.ZDOTDIR).toBe(process.env.ZDOTDIR);
      expect(launchLine(off)).not.toContain('ZDOTDIR=');
      // No marks to wait for: the start command goes in once the start is quiet.
      vi.useFakeTimers();
      off.emit('% ');
      vi.advanceTimersByTime(UNMARKED_QUIET_MS);
      expect(off.written).toEqual([`${LAUNCH_LINE}\r`]);
    });

    it('gives no other shell the zsh files', async () => {
      process.env.SHELL = '/bin/bash';
      try {
        expect((await create(TAB)).env.ZDOTDIR).toBe(process.env.ZDOTDIR);
      } finally {
        process.env.SHELL = '/bin/zsh';
      }
    });

    it('turns marks into entries, pushes them and tags the stream where they were', async () => {
      const pty = await create(TAB);
      pty.emit(`${mark('ps')}% `);
      pty.emit(`pnpm test\r\n${mark('cmd', b64('pnpm test'))}`);
      pty.emit(`FAIL${mark('done', '1')}`);
      expect(pushed()).toMatchObject([
        { seq: 1, kind: 'command', text: 'pnpm test', exitCode: null },
        { seq: 1, exitCode: 1 },
      ]);
      // The renderer's xterm gets the tags right behind the marks.
      await vi.waitFor(() => {
        const data = sender.send.mock.calls
          .filter(([channel]) => channel === 'terminal:data')
          .map(([, p]) => (p as { data: string }).data)
          .join('');
        expect(data).toContain(`${mark('ps')}\x1b]6791;at;1\x07% `);
        expect(data).toContain(`${mark('cmd', b64('pnpm test'))}\x1b]6791;end;1\x07`);
      });
      expect(await inputList({ id: TAB })).toMatchObject([
        { seq: 1, text: 'pnpm test', exitCode: 1 },
      ]);
    });

    it('answers the list only to the window that drives the pty', async () => {
      const pty = await create(TAB);
      pty.emit(mark('cmd', b64('ls')));
      expect(await inputList({ id: TAB }, untrusted)).toEqual([]);
      const otherWindow = { ...trusted, sender: { ...sender, id: 2 } };
      expect(await inputList({ id: TAB }, otherWindow)).toEqual([]);
      expect(await inputList({ id: 42 })).toEqual([]);
      expect(await inputList(null)).toEqual([]);
      expect(await inputList({ id: 'no-such-pty' })).toEqual([]);
    });

    it('records a reported line under the foreground program, and puts its tag in the replay', async () => {
      const pty = await create(TAB);
      pty.process = 'python3';
      noteInput({ id: TAB, text: 'print(2 + 2)', ref: 3 });
      expect(pushed()).toMatchObject([
        { seq: 1, kind: 'line', program: 'python3', text: 'print(2 + 2)', ref: 3 },
      ]);
      requestReplayForOwner(TAB, sender.id);
      sender.send.mockClear();
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      const replay = sender.send.mock.calls.find(([channel]) => channel === 'terminal:data')?.[1];
      expect((replay as { data: string }).data).toContain('\x1b]6791;at;1\x07');
    });

    it('never splices a line tag into a sequence the program is still writing', async () => {
      const pty = await create(TAB);
      pty.emit('\x1b[3');
      noteInput({ id: TAB, text: 'SELECT 1;', ref: 1 });
      pty.emit('1mred');
      requestReplayForOwner(TAB, sender.id);
      sender.send.mockClear();
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      const replay = sender.send.mock.calls.find(([channel]) => channel === 'terminal:data')?.[1];
      expect((replay as { data: string }).data).toContain('\x1b[31mred');
      // Still an entry - it only has no replayable position.
      expect(await inputList({ id: TAB })).toMatchObject([{ text: 'SELECT 1;' }]);
    });

    it('drops a malformed, oversized, foreign or untrusted line report', async () => {
      await create(TAB);
      noteInput({ id: TAB, text: 'ls', ref: 1 }, untrusted);
      noteInput({ id: TAB, text: 'ls', ref: 1 }, { ...trusted, sender: { ...sender, id: 2 } });
      noteInput({ id: TAB, text: 42, ref: 1 });
      noteInput({ id: TAB, text: 'ls', ref: 1.5 });
      noteInput({ id: TAB, text: 'ls', ref: '1' });
      noteInput({ id: TAB, text: 'x'.repeat(5000), ref: 1 });
      noteInput({ id: 'no-such-pty', text: 'ls', ref: 1 });
      noteInput(null);
      expect(pushed()).toEqual([]);
      expect(await inputList({ id: TAB })).toEqual([]);
    });
  });

  describe('handing a whole window over (project windows)', () => {
    // A second window - the project window a project was opened in.
    const otherSender = { id: 2, mainFrame, isDestroyed: () => false, send: vi.fn() };
    const fromOther = { senderFrame: mainFrame, sender: otherSender };
    let reassignWindowShells: (from: number, to: number) => void;
    let setPendingTerminalOwner: (id: string, wcId: number) => void;
    let disposeTerminalsForWindow: (wcId: number) => void;
    let isTerminalOwnedBy: (id: string, wcId: number) => boolean;
    beforeAll(async () => {
      const terminal = await import('./terminal');
      reassignWindowShells = terminal.reassignWindowShells;
      setPendingTerminalOwner = terminal.setPendingTerminalOwner;
      disposeTerminalsForWindow = terminal.disposeTerminalsForWindow;
      isTerminalOwnedBy = terminal.isTerminalOwnedBy;
    });
    afterEach(() => otherSender.send.mockClear());
    const replayedTo = (s: { send: ReturnType<typeof vi.fn> }): boolean =>
      s.send.mock.calls.some(
        ([channel, payload]) =>
          channel === 'terminal:data' && (payload as { replaySize?: unknown }).replaySize != null,
      );

    it('routes every shell the closing window owns to the destination, which adopts it with a replay', async () => {
      const before = spawned.length;
      onHandlers.get('terminal:create')!(fromOther, { id: TAB, cwd: scratch });
      await vi.waitFor(() => expect(spawned.length).toBe(before + 1));
      const pty = spawned[before];
      expect(isTerminalOwnedBy(TAB, otherSender.id)).toBe(true);
      // The order main uses: route first, then the window's closed sweep.
      reassignWindowShells(otherSender.id, sender.id);
      disposeTerminalsForWindow(otherSender.id);
      expect(pty.killed).toEqual([]);
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      expect(isTerminalOwnedBy(TAB, sender.id)).toBe(true);
      expect(replayedTo(sender)).toBe(true);
    });

    it('turns a transfer the closing window never adopted into a replay mark for its owner', async () => {
      // A session the project window never opened: its shells stayed with the
      // main window, routed to the project window. Without the re-route the
      // closed sweep merely cleared the marker and the main window's next
      // create took the same-window path - no replay, a blank tab.
      const pty = await create(TAB);
      setPendingTerminalOwner(TAB, otherSender.id);
      reassignWindowShells(otherSender.id, sender.id);
      disposeTerminalsForWindow(otherSender.id);
      expect(pty.killed).toEqual([]);
      sender.send.mockClear();
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      expect(replayedTo(sender)).toBe(true);
    });

    it('leaves a shell mid-transfer to a third window alone', async () => {
      const before = spawned.length;
      onHandlers.get('terminal:create')!(fromOther, { id: TAB, cwd: scratch });
      await vi.waitFor(() => expect(spawned.length).toBe(before + 1));
      setPendingTerminalOwner(TAB, 3);
      reassignWindowShells(otherSender.id, sender.id);
      // Still routed to window 3: the main window may not adopt it.
      sender.send.mockClear();
      onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch });
      await adopted();
      expect(isTerminalOwnedBy(TAB, otherSender.id)).toBe(true);
      expect(replayedTo(sender)).toBe(false);
    });
  });

  describe('quitting', () => {
    // node-pty hands a shell's exit from its watcher thread to JS; one that lands
    // after Node's environment started tearing down can't call into JS, and the
    // addon's C++ Napi::Error aborts the whole app (crash report 149155736). So the quit
    // disposer only settles once every killed shell has reported its exit.
    it('settles only after every killed shell has exited', async () => {
      const a = await create(TAB);
      const b = await create(OTHER_TAB);
      let settled = false;
      const gone = disposeIpc().then(() => {
        settled = true;
      });
      expect(a.killed).toEqual([undefined]);
      expect(b.killed).toEqual([undefined]);
      a.exit(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      b.exit(0);
      await gone;
      expect(settled).toBe(true);
    });

    it('escalates to SIGKILL for a shell still running after the grace period', async () => {
      const pty = await create(TAB);
      vi.useFakeTimers();
      let settled = false;
      const gone = disposeIpc().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(700);
      expect(pty.killed).toEqual([undefined]);
      await vi.advanceTimersByTimeAsync(100);
      expect(pty.killed).toEqual([undefined, 'SIGKILL']);
      expect(settled).toBe(false);
      pty.exit(137);
      await gone;
      expect(settled).toBe(true);
    });

    it('settles at once when no shell is running', async () => {
      const pty = await create(TAB);
      pty.exit(0);
      await expect(disposeIpc()).resolves.toBeUndefined();
    });
  });
});

// Windows launches never type: cmd.exe / PowerShell run the start command from
// their own command line (startup-typer.ts › windowsLaunch), and a plain
// `claude` gets the status hooks (claude-status-hooks.ts › Windows).
// This wiring runs on Windows alone, so the suite does too.
describe.runIf(process.platform === 'win32')('terminal launch on Windows', () => {
  let disposeIpc: () => Promise<void>;
  // os.tmpdir() reads TEMP / TMP here, not TMPDIR: moved like TMPDIR above, so
  // no test writes into the temp folder the user's running app uses.
  const winSaved = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    COMSPEC: process.env.COMSPEC,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
    // A run from inside a double0 tab inherits that tab's launch variables,
    // which would read as this test's own.
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith('DOUBLE0_'))
        .map((k) => [k, process.env[k]]),
    ),
  };
  const gitBash = join(scratch, 'bash.exe');
  const CMD = 'C:\\Windows\\System32\\cmd.exe';
  const forward = (path: string): string => path.replace(/\\/g, '/');

  beforeAll(async () => {
    for (const k of Object.keys(winSaved)) if (k.startsWith('DOUBLE0_')) delete process.env[k];
    process.env.TEMP = scratch;
    process.env.TMP = scratch;
    process.env.TMPDIR = scratch;
    process.env.COMSPEC = CMD;
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude-config');
    // The status line runs under Git Bash; only its existence is checked.
    writeFileSync(gitBash, '');
    process.env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    const terminal = await import('./terminal');
    disposeIpc = terminal.registerTerminalIpc();
  });
  afterEach(() => {
    vi.useRealTimers();
    void disposeIpc?.();
    for (const pty of spawned) pty.exit(0);
    spawned.length = 0;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(winSaved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  });

  const create = async (initialCommand?: string): Promise<FakePty> => {
    const before = spawned.length;
    onHandlers.get('terminal:create')!(trusted, { id: TAB, cwd: scratch, initialCommand });
    await vi.waitFor(() => expect(spawned.length).toBe(before + 1));
    return spawned[before];
  };

  it('runs a start command from the cmd.exe command line and never types it', async () => {
    // Typed, the line's echo stayed on screen and no mark can end a hold there.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pty = await create('pnpm dev');
    expect(pty.file).toBe(CMD);
    expect(pty.args).toEqual(['/K', '%DOUBLE0_START_COMMAND%']);
    expect(pty.env.DOUBLE0_START_COMMAND).toBe('pnpm dev');
    // Not a POSIX shell: no launch script either.
    expect(pty.env[LAUNCH_ENV]).toBeUndefined();
    pty.emit('Microsoft Windows\r\n\r\nC:\\>');
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 1000);
    expect(pty.written).toEqual([]);
  });

  it('gives a plain claude the status hooks and their files', async () => {
    const pty = await create('claude --model opus');
    // Forward slashes, double-quoted: read as is by cmd.exe, PowerShell and Git Bash.
    const settings =
      /^claude --settings "([^"]+)" --model opus$/.exec(pty.env.DOUBLE0_START_COMMAND)?.[1] ?? '';
    expect(settings).toBe(forward(settings));
    expect(settings.startsWith(`${forward(agentDir)}/double0-claude-windows-settings-`)).toBe(true);
    // No extension status line here: no capture, the user's own line stays.
    expect(pty.env.DOUBLE0_USAGE_FILE).toBeUndefined();
    const written = JSON.parse(readFileSync(settings, 'utf8')) as {
      statusLine?: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(written.statusLine).toBeUndefined();
    // The hooks run the shared script, which Git Bash finds by a forward-slash path.
    const hook = forward(join(agentDir, 'double0-status-hook.sh'));
    expect(written.hooks.Stop[0].hooks[0].command).toBe(`'${hook}' finished`);
    expect(readFileSync(join(agentDir, 'double0-status-hook.sh'), 'utf8')).toBe(STATUS_HOOK_SCRIPT);
    // A ConPTY has no device to write markers to: they go to an empty folder
    // of the tab's own, which the host reads (marker-inbox.ts).
    const markers = join(agentDir, 'double0-markers', TAB);
    expect(pty.env.DOUBLE0_MARKER_DIR).toBe(forward(markers));
    expect(existsSync(markers)).toBe(true);
    // The tab's conversation is recorded for a following view - never pinned.
    expect(pty.env.DOUBLE0_SESSION_FILE).toBe(
      forward(join(scratch, 'userData', 'claude-sessions', TAB)),
    );
    expect(pty.env.DOUBLE0_START_COMMAND).not.toMatch(/--resume|--session-id/);
  });

  it('starts every shell with an empty marker folder', async () => {
    // A marker left by an earlier shell under the same id would replay into this one.
    const markers = join(agentDir, 'double0-markers', TAB);
    (await create('claude')).exit(0);
    // The exited shell's folder goes asynchronously: seed only after it went,
    // or that removal - not the new spawn - would clear the seed.
    await vi.waitFor(() => expect(existsSync(markers)).toBe(false));
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, '1-1.m'), '\x1b]6790;running\x07');
    await create('claude');
    expect(existsSync(join(markers, '1-1.m'))).toBe(false);
  });

  it('runs claude verbatim when there is no Git Bash to run the status line', async () => {
    // Claude Code would run the `sh` script under PowerShell, which cannot.
    process.env.CLAUDE_CODE_GIT_BASH_PATH = join(scratch, 'missing', 'bash.exe');
    try {
      const pty = await create('claude');
      expect(pty.env.DOUBLE0_START_COMMAND).toBe('claude');
      expect(pty.env.DOUBLE0_USAGE_FILE).toBeUndefined();
    } finally {
      process.env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    }
  });

  it('leaves a bare shell untouched', async () => {
    const pty = await create();
    expect(pty.args).toEqual([]);
    expect(pty.env.DOUBLE0_START_COMMAND).toBeUndefined();
  });
});
