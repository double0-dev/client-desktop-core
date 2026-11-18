import { describe, expect, it } from 'vitest';
import type { InputEntry } from '@renderer/lib/terminal/inputs';
import {
  exitLabel,
  extraLinesLabel,
  filterInputs,
  formatInputTime,
  groupInputSections,
  inputFirstLine,
  inputsCountLabel,
} from '@renderer/lib/terminal/inputs-view';

let seq = 0;
function entry(fields: Partial<InputEntry> & Pick<InputEntry, 'kind' | 'text'>): InputEntry {
  return {
    seq: ++seq,
    program: fields.kind === 'prompt' ? 'claude' : fields.kind === 'command' ? 'shell' : 'python3',
    lines: fields.text.split('\n').length,
    truncated: false,
    at: 0,
    exitCode: null,
    gone: false,
    run: 0,
    ref: null,
    ...fields,
  };
}

describe('groupInputSections', () => {
  it('makes one section per program run, in the terminal order', () => {
    const sections = groupInputSections([
      entry({ kind: 'command', text: 'pnpm install' }),
      entry({ kind: 'command', text: 'claude' }),
      entry({ kind: 'prompt', text: 'why does pnpm test auth fail?' }),
      entry({ kind: 'prompt', text: 'apply the fix' }),
      entry({ kind: 'command', text: 'git status' }),
      entry({ kind: 'line', text: 'print(1)', program: 'python3' }),
      entry({ kind: 'line', text: 'SELECT 1;', program: 'psql' }),
    ]);
    expect(sections.map((s) => [s.label, s.count])).toEqual([
      ['Shell', '2 commands'],
      ['Claude Code', '2 prompts'],
      ['Shell', '1 command'],
      ['python3', '1 line'],
      ['psql', '1 line'],
    ]);
    // Keys stay put as entries are added after a section.
    expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length);
  });

  it('has nothing to group in an empty list', () => {
    expect(groupInputSections([])).toEqual([]);
  });

  it('labels a prompt section after the agent its prompts went to', () => {
    // Main files each prompt under the program its mark named (terminal-
    // inputs.ts); a Codex or OpenCode tab must not read "Claude Code".
    const sections = groupInputSections([
      entry({ kind: 'prompt', text: 'fix the build', program: 'codex' }),
      entry({ kind: 'prompt', text: 'add a test', program: 'opencode' }),
      entry({ kind: 'prompt', text: 'and docs', program: 'claude' }),
      entry({ kind: 'prompt', text: 'ok', program: 'somethingnew' }),
    ]);
    expect(sections.map((s) => [s.kind, s.label, s.count])).toEqual([
      ['agent', 'Codex', '1 prompt'],
      ['agent', 'OpenCode', '1 prompt'],
      ['agent', 'Claude Code', '1 prompt'],
      ['agent', 'somethingnew', '1 prompt'],
    ]);
  });
});

describe('filterInputs', () => {
  const list = [
    entry({ kind: 'command', text: 'pnpm test auth' }),
    entry({ kind: 'prompt', text: 'Fix the AUTH flake\nplease' }),
  ];

  it('matches anywhere in the text, ignoring case', () => {
    expect(filterInputs(list, 'auth').map((e) => e.kind)).toEqual(['command', 'prompt']);
    expect(filterInputs(list, ' please ').map((e) => e.kind)).toEqual(['prompt']);
  });

  it('keeps everything for an empty query', () => {
    expect(filterInputs(list, '  ')).toBe(list);
  });
});

describe('row labels', () => {
  it('shows the first non-empty line', () => {
    expect(inputFirstLine('\n\nlook at refreshToken\nand fix it')).toBe('look at refreshToken');
  });

  it('counts the lines after the first, flagging a cut input', () => {
    expect(extraLinesLabel(entry({ kind: 'prompt', text: 'one' }))).toBeNull();
    expect(extraLinesLabel(entry({ kind: 'prompt', text: 'a\nb\nc' }))).toBe('+2 lines');
    expect(extraLinesLabel(entry({ kind: 'prompt', text: 'a\nb', truncated: true }))).toBe(
      '+1 line…',
    );
    expect(extraLinesLabel(entry({ kind: 'prompt', text: 'a', truncated: true }))).toBe('+more');
  });

  it('calls out a failed command only', () => {
    expect(exitLabel(entry({ kind: 'command', text: 'pnpm test', exitCode: 1 }))).toBe('exit 1');
    expect(exitLabel(entry({ kind: 'command', text: 'ls', exitCode: 0 }))).toBeNull();
    expect(exitLabel(entry({ kind: 'command', text: 'sleep 9', exitCode: null }))).toBeNull();
  });

  it('shows the time today and the date before', () => {
    const now = new Date(2026, 8, 21, 16, 30).getTime();
    expect(formatInputTime(new Date(2026, 8, 21, 9, 5).getTime(), now)).toMatch(/09.05/);
    expect(formatInputTime(new Date(2026, 8, 20, 9, 5).getTime(), now)).not.toMatch(/09.05/);
  });

  it('labels the status bar item', () => {
    expect(inputsCountLabel(0)).toBe('0 inputs');
    expect(inputsCountLabel(1)).toBe('1 input');
    expect(inputsCountLabel(6)).toBe('6 inputs');
  });
});
