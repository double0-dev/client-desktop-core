import { describe, expect, it } from 'vitest';
import {
  adapterFor,
  augmentAgentCommand,
  planLaunch,
  type LaunchResources,
  type ResolvedClaudeSession,
} from './launch-plan';
import { PTY_TERM } from './terminal-env';

/**
 * Main's half of a spawn (launch-plan.ts): which launch path a start command
 * takes and the line it becomes, over fake host resources. The real files and
 * the real resume decision are launch-materialize.test.ts; the launch lines a
 * live terminal gets end to end are terminal.test.ts.
 *
 * The resources record every call: a piece the launch path does not need must
 * never be asked for - each one writes or reads on the host (a status line capture
 * resets the tab's file), so a stray call is a behaviour change.
 */

const TAB = '5b0c3a1e-7f2d-4c8e-9a61-2d4f8e0b7c13';
const CWD = '/home/emmaw/acme/production-pipeline';

type Overrides = Partial<Omit<LaunchResources, 'shell'>> & { shell?: string };

function fakeResources(over: Overrides = {}): { res: LaunchResources; calls: string[] } {
  const calls: string[] = [];
  const track =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      calls.push(name);
      return fn(...a);
    };
  const session: ResolvedClaudeSession = {
    sessionId: TAB,
    exists: false,
    recordPath: `/data/claude-sessions/${TAB}`,
  };
  const res: LaunchResources = {
    shell: over.shell ?? '/bin/zsh',
    hasGitBash: track('hasGitBash', over.hasGitBash ?? (() => true)),
    claudeSettings: track('claudeSettings', over.claudeSettings ?? (() => '/agent/hooks.json')),
    claudeWindowsSettings: track(
      'claudeWindowsSettings',
      over.claudeWindowsSettings ?? (() => 'C:\\agent\\win.json'),
    ),
    shimDir: track('shimDir', over.shimDir ?? (() => '/agent/double0-claude-shim')),
    codexHooks: track('codexHooks', over.codexHooks ?? (() => '/agent/codex-hooks.conf')),
    opencodePlugin: track('opencodePlugin', over.opencodePlugin ?? (() => '/agent/oc/status.js')),
    claudeSession: track('claudeSession', over.claudeSession ?? (() => session)),
    opencodeSession: track(
      'opencodeSession',
      over.opencodeSession ??
        (() => ({ sessionId: null, recordPath: `/data/opencode-sessions/${TAB}` })),
    ),
    codexRecord: track('codexRecord', over.codexRecord ?? (() => `/data/codex-sessions/${TAB}`)),
    usageCapture: track(
      'usageCapture',
      over.usageCapture ?? ((l) => `/data/captures/${encodeURIComponent(l.ptyId)}.usage`),
    ),
    windowsMarkerDir: track('windowsMarkerDir', over.windowsMarkerDir ?? (() => 'C:/m/tab')),
    windowsSessionRecord: track(
      'windowsSessionRecord',
      over.windowsSessionRecord ?? (() => `C:/data/claude-sessions/${TAB}`),
    ),
  };
  return { res, calls };
}

const launch = { ptyId: TAB, cwd: CWD };

describe('planLaunch', () => {
  it('trims the start command and picks the launch path per platform', () => {
    const ctx = { platform: 'darwin' as const, appVersion: '0.6.4', agentTools: true };
    expect(planLaunch({ id: TAB, initialCommand: '  claude --resume x ' }, ctx)).toMatchObject({
      command: 'claude --resume x',
      adapter: 'claude',
      markerDriven: true,
    });
    // Anything that is not a plain leading `claude` goes through the shims.
    expect(planLaunch({ id: TAB, initialCommand: 'claude-personal' }, ctx)).toMatchObject({
      adapter: 'wrapper',
      markerDriven: false,
    });
    // A blank start command is a bare shell.
    expect(planLaunch({ id: TAB, initialCommand: '   ' }, ctx)).toMatchObject({
      command: null,
      adapter: null,
    });
    expect(adapterFor('claude', 'win32')).toBe('windows');
    // Windows runs every other command verbatim - no shims there.
    expect(adapterFor('codex', 'win32')).toBeNull();
    expect(adapterFor('codex', 'linux')).toBe('wrapper');
  });

  it("carries the app's env overlay, the grid with its defaults and the integration switch", () => {
    const plan = planLaunch(
      { id: TAB, cwd: '~/acme', cols: 0, rows: 40, shellIntegration: undefined },
      { platform: 'linux', appVersion: '0.6.4', agentTools: false },
    );
    expect(plan.overlayEnv).toEqual({
      TERM: PTY_TERM,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'double0',
      TERM_PROGRAM_VERSION: '0.6.4',
      CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
    });
    // The cwd is the host's to validate: passed on as given.
    expect(plan).toMatchObject({ cwd: '~/acme', cols: 80, rows: 40, agentTools: false });
    // Only an explicit off turns the integration off.
    expect(plan.shellIntegration).toBe(true);
    expect(
      planLaunch(
        { id: TAB, shellIntegration: false },
        { platform: 'linux', appVersion: '1', agentTools: true },
      ).shellIntegration,
    ).toBe(false);
  });
});

describe('augmentAgentCommand - the plain claude adapter', () => {
  it("hooks a plain claude and pins it to the tab's new conversation", () => {
    const { res, calls } = fakeResources();
    const out = augmentAgentCommand('claude', launch, res, 'darwin');
    expect(out).toEqual({
      command:
        `DOUBLE0_TTY="$(tty)" DOUBLE0_USAGE_FILE='/data/captures/${TAB}.usage'` +
        ` DOUBLE0_SESSION_FILE='/data/claude-sessions/${TAB}'` +
        ` claude --session-id ${TAB} --settings '/agent/hooks.json'`,
      markerDriven: true,
    });
    // Today's order: the settings decide whether the capture file is asked for.
    expect(calls).toEqual(['claudeSettings', 'claudeSession', 'usageCapture']);
  });

  it('resumes a conversation that has a transcript, and keeps a pin the user typed', () => {
    const { res } = fakeResources({
      claudeSession: () => ({ sessionId: TAB, exists: true, recordPath: '/r' }),
    });
    expect(augmentAgentCommand('claude', launch, res, 'linux').command).toContain(
      `claude --resume ${TAB} --settings`,
    );
    expect(augmentAgentCommand('claude -c', launch, res, 'linux').command).toMatch(
      /claude --settings '\/agent\/hooks.json' -c$/,
    );
  });

  it('launches a pty with no stable id unpinned, recording nothing', () => {
    const { res } = fakeResources({ claudeSession: () => null });
    const out = augmentAgentCommand('claude', { ptyId: `setup:${TAB}`, cwd: CWD }, res, 'darwin');
    expect(out.command).not.toContain('DOUBLE0_SESSION_FILE');
    expect(out.command).toMatch(/ claude --settings '\/agent\/hooks.json'$/);
  });

  it('runs claude untouched, on the fallback heuristics, when the hook files cannot be written', () => {
    const { res, calls } = fakeResources({ claudeSettings: () => null, claudeSession: () => null });
    expect(augmentAgentCommand('claude', launch, res, 'darwin')).toEqual({
      command: 'claude',
      markerDriven: false,
    });
    // No settings, no status line capture: nothing would ever read it.
    expect(calls).not.toContain('usageCapture');
  });

  it('single-quotes paths that hold spaces and quotes', () => {
    const { res } = fakeResources({
      usageCapture: () => "/Users/emmaw/Application Support/it's.usage",
    });
    expect(augmentAgentCommand('claude', launch, res, 'darwin').command).toContain(
      `DOUBLE0_USAGE_FILE='/Users/emmaw/Application Support/it'\\''s.usage'`,
    );
  });
});

describe('wrapperLaunch - every other start command', () => {
  it('exports every agent injection and puts the shims first on PATH', () => {
    const { res, calls } = fakeResources();
    const out = augmentAgentCommand('claude-personal', launch, res, 'linux');
    expect(out.markerDriven).toBe(false);
    expect(out.command).toContain(`PATH='/agent/double0-claude-shim':"$PATH"`);
    expect(out.command).toContain(`DOUBLE0_CLAUDE_HOOKS='/agent/hooks.json'`);
    expect(out.command).toContain(`DOUBLE0_CLAUDE_SESSION='${TAB}'`);
    expect(out.command).toContain(`DOUBLE0_CODEX_HOOKS='/agent/codex-hooks.conf'`);
    expect(out.command).toContain('file:///agent/oc/status.js');
    expect(out.command).toMatch(/; claude-personal\nunset /);
    expect(calls).toEqual([
      'claudeSettings',
      'shimDir',
      'claudeSession',
      'usageCapture',
      'codexHooks',
      'opencodePlugin',
      'opencodeSession',
      'codexRecord',
    ]);
  });

  it('runs the command verbatim under a shell that cannot read the POSIX line', () => {
    const { res, calls } = fakeResources({ shell: '/usr/bin/fish' });
    expect(augmentAgentCommand('codex', launch, res, 'darwin')).toEqual({
      command: 'codex',
      markerDriven: false,
    });
    // Nothing written for a launch that cannot use it.
    expect(calls).toEqual([]);
  });

  it('runs it verbatim when the shims could not be written', () => {
    const { res, calls } = fakeResources({ shimDir: () => null });
    expect(augmentAgentCommand('opencode', launch, res, 'darwin').command).toBe('opencode');
    expect(calls).toEqual(['claudeSettings', 'shimDir']);
  });
});

describe('windowsAgentLaunch', () => {
  it('hands a plain claude the hooks, the capture file, the marker folder and the record in its env', () => {
    const { res, calls } = fakeResources();
    expect(augmentAgentCommand('claude', launch, res, 'win32')).toEqual({
      command: 'claude --settings "C:/agent/win.json"',
      markerDriven: false,
      env: {
        DOUBLE0_USAGE_FILE: `/data/captures/${TAB}.usage`,
        DOUBLE0_MARKER_DIR: 'C:/m/tab',
        DOUBLE0_SESSION_FILE: `C:/data/claude-sessions/${TAB}`,
      },
    });
    expect(calls).toEqual([
      'hasGitBash',
      'claudeWindowsSettings',
      'windowsMarkerDir',
      'usageCapture',
      'windowsSessionRecord',
    ]);
  });

  it('keeps the hooks and the marker folder without a status line capture', () => {
    // The core build has no status line: agent status must not depend on it.
    const { res } = fakeResources({ usageCapture: () => null });
    expect(augmentAgentCommand('claude', launch, res, 'win32')).toEqual({
      command: 'claude --settings "C:/agent/win.json"',
      markerDriven: false,
      env: {
        DOUBLE0_MARKER_DIR: 'C:/m/tab',
        DOUBLE0_SESSION_FILE: `C:/data/claude-sessions/${TAB}`,
      },
    });
  });

  it('runs every other command, and claude without a Git Bash, verbatim', () => {
    const plain = fakeResources();
    expect(augmentAgentCommand('codex', launch, plain.res, 'win32')).toEqual({
      command: 'codex',
      markerDriven: false,
    });
    expect(plain.calls).toEqual([]);
    const noBash = fakeResources({ hasGitBash: () => false });
    expect(augmentAgentCommand('claude', launch, noBash.res, 'win32').command).toBe('claude');
    expect(noBash.calls).toEqual(['hasGitBash']);
  });

  it('falls back when the marker folder cannot be made, and goes on without a record', () => {
    const noMarkers = fakeResources({ windowsMarkerDir: () => null });
    expect(augmentAgentCommand('claude', launch, noMarkers.res, 'win32')).toEqual({
      command: 'claude',
      markerDriven: false,
    });
    const noRecord = fakeResources({ windowsSessionRecord: () => null });
    const out = augmentAgentCommand('claude', launch, noRecord.res, 'win32');
    expect(out.env).not.toHaveProperty('DOUBLE0_SESSION_FILE');
    expect(out.env).toHaveProperty('DOUBLE0_MARKER_DIR', 'C:/m/tab');
  });
});
