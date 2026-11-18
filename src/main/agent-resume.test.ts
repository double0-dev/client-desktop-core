import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_SESSION_RECORD_ENV,
  SESSION_RECORD_ENV,
  claudeConfigDir,
  forgetOpencodeSession,
  opencodeSessionRecordsDir,
  recordedOpencodeSessionId,
  resolveOpencodeSession,
  claudeProjectSlug,
  claudeSessionIdForPty,
  claudeSessionRecordPath,
  claudeSessionRecordsDir,
  claudeTranscriptExists,
  claudeTranscriptPath,
  forgetClaudeSession,
  pinsOwnSession,
  recordedClaudeSessionId,
  resolveClaudeSession,
  shellQuote,
  withClaudeSession,
} from './agent-resume';

// Two tabs of the same session, as the persisted layout stores them: the primary
// conversation PTY and a "+" terminal that also auto-runs `claude`.
const SESSION = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

describe('claudeSessionIdForPty', () => {
  it('reads the session uuid off the primary conversation PTY', () => {
    expect(claudeSessionIdForPty(`conversation:${SESSION}`)).toBe(SESSION);
  });

  it("uses a terminal tab's own uuid - that is what makes each tab its own conversation", () => {
    expect(claudeSessionIdForPty(TAB)).toBe(TAB);
  });

  it('refuses PTYs with no restart-stable uuid, so they launch unpinned', () => {
    // The worktree setup shell runs a setup command, never an agent conversation.
    expect(claudeSessionIdForPty(`setup:${SESSION}`)).toBeNull();
    expect(claudeSessionIdForPty('conversation:not-a-uuid')).toBeNull();
    expect(claudeSessionIdForPty('legacy-pty-7')).toBeNull();
  });

  it('normalises case - Claude writes its transcript under the lowercase id', () => {
    expect(claudeSessionIdForPty(SESSION.toUpperCase())).toBe(SESSION);
  });
});

describe('claudeProjectSlug', () => {
  it("flattens the cwd the way Claude's own projects folder does", () => {
    expect(claudeProjectSlug('/Users/emmaw/Code/double0/client-desktop')).toBe(
      '-Users-emmaw-Code-double0-client-desktop',
    );
  });

  it('flattens dots too, so a worktree path matches its real folder', () => {
    // Verified against a live ~/.claude/projects entry for this very worktree.
    expect(claudeProjectSlug('/Users/emmaw/Code/double0/client-desktop/.worktree/acme')).toBe(
      '-Users-emmaw-Code-double0-client-desktop--worktree-acme',
    );
  });
});

describe('claudeConfigDir', () => {
  it('honours CLAUDE_CONFIG_DIR over the default', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude' }, '/Users/emma')).toBe(
      '/opt/claude',
    );
  });

  it('falls back to ~/.claude when unset or blank', () => {
    expect(claudeConfigDir({}, '/Users/emma')).toBe(join('/Users/emma', '.claude'));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, '/Users/emma')).toBe(
      join('/Users/emma', '.claude'),
    );
  });
});

describe('claudeTranscriptExists', () => {
  const CWD = '/Users/emmaw/Code/acme/production-pipeline';
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'double0-resume-'));
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  const writeTranscript = (folder: string, id: string): void => {
    const dir = join(configDir, 'projects', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n', 'utf8');
  };

  it('finds the transcript under the cwd folder - the restored-tab case', () => {
    writeTranscript(claudeProjectSlug(CWD), TAB);
    expect(claudeTranscriptExists(configDir, CWD, TAB)).toBe(true);
  });

  it('reports nothing for an id never launched - the new-tab case', () => {
    writeTranscript(claudeProjectSlug(CWD), TAB);
    expect(claudeTranscriptExists(configDir, CWD, SESSION)).toBe(false);
  });

  it('reports nothing when Claude has never run at all', () => {
    // No projects folder - must degrade to "create", not throw.
    expect(claudeTranscriptExists(configDir, CWD, TAB)).toBe(false);
  });

  it('still finds a transcript filed under an unexpected folder name', () => {
    // Guards the one assumption we cannot pin down: Claude's folder naming. If it
    // ever changes, resume must keep working rather than try to re-create an id
    // that already exists (which errors out in the user's terminal).
    writeTranscript('some-other-scheme-for-the-same-cwd', TAB);
    expect(claudeTranscriptExists(configDir, CWD, TAB)).toBe(true);
  });

  it('builds the path from the config dir, cwd and id', () => {
    expect(claudeTranscriptPath('/home/emma/.claude', CWD, TAB)).toBe(
      join('/home/emma/.claude', 'projects', claudeProjectSlug(CWD), `${TAB}.jsonl`),
    );
  });
});

describe('pinsOwnSession', () => {
  it('detects a conversation the user pinned themselves', () => {
    expect(pinsOwnSession('claude --resume abc')).toBe(true);
    expect(pinsOwnSession('claude -c')).toBe(true);
    expect(pinsOwnSession('claude --session-id=abc')).toBe(true);
    expect(pinsOwnSession('claude --fork-session --resume abc')).toBe(true);
  });

  it('leaves ordinary launches alone', () => {
    expect(pinsOwnSession('claude')).toBe(false);
    expect(pinsOwnSession('claude --model opus')).toBe(false);
    // The leading token is the binary, never a flag - `claude` itself is skipped.
    expect(pinsOwnSession('claude --dangerously-skip-permissions')).toBe(false);
  });
});

describe('withClaudeSession', () => {
  it('names a new conversation when there is no transcript', () => {
    expect(withClaudeSession('claude', TAB, false)).toBe(`claude --session-id ${TAB}`);
  });

  it('resumes the existing one when there is', () => {
    expect(withClaudeSession('claude', TAB, true)).toBe(`claude --resume ${TAB}`);
  });

  it('keeps the rest of the command, flags included', () => {
    expect(withClaudeSession("claude --settings '/tmp/s.json' --model opus", TAB, true)).toBe(
      `claude --resume ${TAB} --settings '/tmp/s.json' --model opus`,
    );
  });

  it('never overrides a conversation the user pinned themselves', () => {
    expect(withClaudeSession('claude --resume mine', TAB, false)).toBe('claude --resume mine');
    expect(withClaudeSession('claude -c', TAB, true)).toBe('claude -c');
  });

  it('does nothing for an id Claude would reject', () => {
    // --session-id demands a valid UUID; a bad one must not reach the CLI.
    expect(withClaudeSession('claude', 'setup-7', false)).toBe('claude');
  });
});

describe('session records - the conversation a tab is actually in', () => {
  const CWD = '/Users/emmaw/Code/acme/production-pipeline';
  // What `/clear` moved the tab to: a fresh id Claude minted, unrelated to TAB.
  const CLEARED = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  let root: string;
  let configDir: string;
  let recordsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-records-'));
    configDir = join(root, 'claude');
    recordsDir = claudeSessionRecordsDir(join(root, 'userData'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeTranscript = (id: string): void => {
    const dir = join(configDir, 'projects', claudeProjectSlug(CWD));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n', 'utf8');
  };
  const writeRecord = (tabId: string, content: string): void => {
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(claudeSessionRecordPath(recordsDir, tabId), content, 'utf8');
  };

  it('keeps the records under userData, one file per tab uuid', () => {
    // tmpdir is purged between reboots; the record has to outlive that.
    expect(claudeSessionRecordsDir('/Users/emma/Library/Application Support/double0')).toBe(
      join('/Users/emma/Library/Application Support/double0', 'claude-sessions'),
    );
    expect(claudeSessionRecordPath('/r', TAB)).toBe(join('/r', TAB));
  });

  it('reads the recorded id, tolerating the whitespace a shell write may add', () => {
    writeRecord(TAB, `${CLEARED.toUpperCase()}\n`);
    expect(recordedClaudeSessionId(claudeSessionRecordPath(recordsDir, TAB))).toBe(CLEARED);
  });

  it('ignores a missing or malformed record', () => {
    expect(recordedClaudeSessionId(claudeSessionRecordPath(recordsDir, TAB))).toBeNull();
    writeRecord(TAB, 'not a uuid');
    expect(recordedClaudeSessionId(claudeSessionRecordPath(recordsDir, TAB))).toBeNull();
  });

  describe('resolveClaudeSession', () => {
    it('runs a never-recorded tab under its own uuid - new tab, or pre-record install', () => {
      const plan = resolveClaudeSession(TAB, CWD, { configDir, recordsDir });
      expect(plan).toEqual({
        sessionId: TAB,
        exists: false,
        recordPath: claudeSessionRecordPath(recordsDir, TAB),
      });
      // Created up front so the hook's very first write cannot fail.
      expect(existsSync(recordsDir)).toBe(true);
    });

    it('resumes the RECORDED conversation after a /clear, not the one the tab was launched as', () => {
      // The bug this exists for: the tab was launched as TAB, the user /clear'ed
      // (Claude moved it to CLEARED, the hook recorded that), and a restart
      // brought back TAB - the older conversation.
      writeTranscript(TAB);
      writeTranscript(CLEARED);
      writeRecord(TAB, CLEARED);
      expect(resolveClaudeSession(TAB, CWD, { configDir, recordsDir })).toMatchObject({
        sessionId: CLEARED,
        exists: true,
      });
    });

    it('comes back to the empty conversation a /clear left, when it was never prompted', () => {
      // A /clear with no prompt after it has a session id but no transcript
      // yet - that is `--session-id <recorded>`, a fresh conversation under the
      // id Claude already announced, never the pre-clear one.
      writeTranscript(TAB);
      writeRecord(TAB, CLEARED);
      expect(resolveClaudeSession(TAB, CWD, { configDir, recordsDir })).toMatchObject({
        sessionId: CLEARED,
        exists: false,
      });
    });

    it('keys the primary conversation PTY by its session uuid', () => {
      writeRecord(SESSION, CLEARED);
      expect(
        resolveClaudeSession(`conversation:${SESSION}`, CWD, { configDir, recordsDir }),
      ).toMatchObject({
        sessionId: CLEARED,
        recordPath: claudeSessionRecordPath(recordsDir, SESSION),
      });
    });

    it('still pins nothing for a PTY without a stable uuid', () => {
      expect(resolveClaudeSession(`setup:${SESSION}`, CWD, { configDir, recordsDir })).toBeNull();
      expect(existsSync(recordsDir)).toBe(false);
    });
  });

  describe('forgetClaudeSession', () => {
    it('drops the record of a closed tab (and a deleted session, by its conversation PTY)', () => {
      writeRecord(TAB, CLEARED);
      writeRecord(SESSION, CLEARED);
      forgetClaudeSession(recordsDir, TAB);
      forgetClaudeSession(recordsDir, `conversation:${SESSION}`);
      expect(existsSync(claudeSessionRecordPath(recordsDir, TAB))).toBe(false);
      expect(existsSync(claudeSessionRecordPath(recordsDir, SESSION))).toBe(false);
    });

    it('is a no-op for an unpinnable PTY or an absent record', () => {
      expect(() => forgetClaudeSession(recordsDir, `setup:${SESSION}`)).not.toThrow();
      expect(() => forgetClaudeSession(recordsDir, TAB)).not.toThrow();
    });
  });

  it('quotes the record path for the launch shell - userData has spaces', () => {
    expect(shellQuote('/Users/emma/Library/Application Support/double0/claude-sessions/x')).toBe(
      "'/Users/emma/Library/Application Support/double0/claude-sessions/x'",
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(SESSION_RECORD_ENV).toBe('DOUBLE0_SESSION_FILE');
  });
});

describe('OpenCode session records - the conversation a tab continues', () => {
  const SESSION_ID = 'ses_efd99bf2cffe5s5wMVZhGkYukW';
  let root: string;
  let recordsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-oc-records-'));
    recordsDir = opencodeSessionRecordsDir(join(root, 'userData'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps its own folder under userData, apart from the Claude records', () => {
    // A tab that ran both must not hand one CLI the other's id.
    expect(opencodeSessionRecordsDir('/Users/emma/Library/Application Support/double0')).toBe(
      join('/Users/emma/Library/Application Support/double0', 'opencode-sessions'),
    );
    expect(OPENCODE_SESSION_RECORD_ENV).toBe('DOUBLE0_OPENCODE_SESSION_FILE');
  });

  it("reads a recorded id of OpenCode's shape and nothing else", () => {
    mkdirSync(recordsDir, { recursive: true });
    const record = claudeSessionRecordPath(recordsDir, TAB);
    writeFileSync(record, `${SESSION_ID}\n`, 'utf8');
    expect(recordedOpencodeSessionId(record)).toBe(SESSION_ID);
    // A Claude uuid, a query, garbage: no pin (the shim puts the id in SQL).
    for (const bad of [SESSION, "ses_x' or 1=1", 'ses_', '']) {
      writeFileSync(record, bad, 'utf8');
      expect(recordedOpencodeSessionId(record), bad).toBeNull();
    }
    expect(recordedOpencodeSessionId(join(root, 'missing'))).toBeNull();
  });

  it('plans a never-recorded tab as a fresh conversation, with a record file ready to write', () => {
    // OpenCode mints its own ids: there is nothing to name, only to continue.
    expect(resolveOpencodeSession(TAB, recordsDir)).toEqual({
      sessionId: null,
      recordPath: claudeSessionRecordPath(recordsDir, TAB),
    });
    expect(existsSync(recordsDir)).toBe(true);
  });

  it('continues the recorded session, under the conversation pty or a tab uuid', () => {
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(claudeSessionRecordPath(recordsDir, SESSION), SESSION_ID, 'utf8');
    expect(resolveOpencodeSession(`conversation:${SESSION}`, recordsDir)?.sessionId).toBe(
      SESSION_ID,
    );
    expect(resolveOpencodeSession(`setup:${SESSION}`, recordsDir)).toBeNull();
  });

  it('forgets a closed tab and nothing else', () => {
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(claudeSessionRecordPath(recordsDir, TAB), SESSION_ID, 'utf8');
    writeFileSync(claudeSessionRecordPath(recordsDir, SESSION), SESSION_ID, 'utf8');
    forgetOpencodeSession(recordsDir, TAB);
    expect(existsSync(claudeSessionRecordPath(recordsDir, TAB))).toBe(false);
    expect(existsSync(claudeSessionRecordPath(recordsDir, SESSION))).toBe(true);
    // No record, no uuid: quiet.
    forgetOpencodeSession(recordsDir, TAB);
    forgetOpencodeSession(recordsDir, 'setup:x');
  });
});
