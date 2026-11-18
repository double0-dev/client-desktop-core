import { describe, expect, it } from 'vitest';
import {
  dialogKeyInput,
  dialogKeys,
  parseCliMode,
  parseScreenDialog,
  planDialogKey,
  promptBox,
} from './claude-screen';

// Footers as CLI 2.1.289 draws them under the prompt.
const screen = (footer: string) => ['⏺ Done.', '', '────', '❯ ', '────', footer];

describe('parseCliMode', () => {
  it("reads the mode Claude's footer names", () => {
    expect(parseCliMode(screen(' ⏸ manual mode on · ← for agents'))).toBe('default');
    expect(parseCliMode(screen(' ⏵⏵ accept edits on (shift+tab to cycle)'))).toBe('acceptEdits');
    expect(parseCliMode(screen(' ⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(parseCliMode(screen(' ⏵⏵ bypass permissions on'))).toBe('bypassPermissions');
  });

  it('a Claude prompt without an indicator is the default mode; no prompt is unknown', () => {
    expect(parseCliMode(screen(' ? for shortcuts'))).toBe('default');
    expect(parseCliMode(['user@host ~ %', ''])).toBeNull();
  });

  it('reads the footer, not an older mention in the conversation above', () => {
    const lines = [
      'I turned plan mode on earlier',
      ...Array(14).fill(''),
      ...screen(' ⏵⏵ accept edits on'),
    ];
    expect(parseCliMode(lines)).toBe('acceptEdits');
  });
});

describe('planDialogKey', () => {
  // The dialog as CLI 2.1.289 draws it.
  const dialog = [
    'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    '❯ 1. Yes, auto-accept edits',
    '  2. Yes, manually approve edits',
    '  3. Tell Claude what to change',
    '     shift+tab to approve with this feedback',
  ];

  it("presses the option's number, Esc to keep planning", () => {
    expect(planDialogKey(dialog, 'plan-accept-edits')).toBe('1');
    expect(planDialogKey(dialog, 'plan-ask')).toBe('2');
    expect(planDialogKey(dialog, 'plan-keep')).toBe('\u001b');
  });

  it('finds the numbers wherever the CLI puts the options', () => {
    const other = [
      '❯ 1. Yes, and switch to default (ask each time)',
      '  2. Yes, auto-accept edits',
    ];
    expect(planDialogKey(other, 'plan-accept-edits')).toBe('2');
    expect(planDialogKey(other, 'plan-ask')).toBe('1');
  });

  it('presses nothing when the dialog is not on screen', () => {
    expect(planDialogKey(['❯ ', ' ⏸ plan mode on'], 'plan-accept-edits')).toBeNull();
    expect(planDialogKey(['❯ ', ' ⏸ plan mode on'], 'plan-keep')).toBeNull();
  });
});

describe('reading a screen with a dialog open', () => {
  it('reads no mode while a dialog hides the footer - its option row is no prompt', () => {
    expect(parseCliMode(['Do you want to make this edit?', '❯ 1. Yes', '  2. No'])).toBeNull();
  });

  it("takes the plan dialog's own options, never a numbered line of the plan", () => {
    const screen = [
      'Plan:',
      '1. Switch to default mode for the tests',
      '2. Yes, auto-accept edits in the fixtures',
      '',
      'Would you like to proceed?',
      '❯ 1. Yes, auto-accept edits',
      '  2. Yes, manually approve edits',
      '  3. Tell Claude what to change',
    ];
    expect(planDialogKey(screen, 'plan-accept-edits')).toBe('1');
    expect(planDialogKey(screen, 'plan-ask')).toBe('2');
  });
});

describe('an inline TUI', () => {
  it('reads the footer above the blank rows an inline Claude leaves below it', () => {
    const screen = [
      '❯ Try "edit <filepath>"',
      '────',
      ' ⏸ manual mode on · ← for agents',
      ...Array(30).fill(''),
    ];
    expect(parseCliMode(screen)).toBe('default');
    const dialog = [
      '❯ 1. Yes, auto-accept edits',
      '  2. Yes, manually approve edits',
      ...Array(30).fill(''),
    ];
    expect(planDialogKey(dialog, 'plan-ask')).toBe('2');
  });
});

describe('parseScreenDialog', () => {
  // The new-MCP-servers dialog as CLI 2.1.x draws it at startup (no hook fires).
  const mcp = [
    '',
    '────────────────────────────────────────────────────────────',
    ' 3 new MCP servers found in this project',
    ' Select any you wish to enable.',
    '',
    ' MCP servers may execute code or access system resources.',
    '',
    ' ❯ [✔] acme-linear',
    '   [✔] notion',
    '   [✔] clickhouse',
    '      Enable selected',
    ' Space to select · Esc to reject all',
    '',
    '',
  ];

  it("reads a startup dialog's title and rows off the screen", () => {
    expect(parseScreenDialog(mcp)).toEqual({
      title: '3 new MCP servers found in this project',
      lines: [
        'Select any you wish to enable.',
        '',
        'MCP servers may execute code or access system resources.',
        '',
        '❯ [✔] acme-linear',
        '  [✔] notion',
        '  [✔] clickhouse',
        '     Enable selected',
        'Space to select · Esc to reject all',
      ],
    });
  });

  it('reads a numbered dialog in a box (the folder trust)', () => {
    const trust = [
      '╭──────────────────────────────────────╮',
      '│ Do you trust the files in this folder? │',
      '│                                        │',
      '│ ❯ 1. Yes, proceed                      │',
      '│   2. No, exit                          │',
      '╰──────────────────────────────────────╯',
      '  Enter to confirm · Esc to exit',
    ];
    // The box's bottom edge is no rule of ours: it stays out of the rows.
    const d = parseScreenDialog(trust);
    expect(d?.title).toBe('Do you trust the files in this folder?');
    expect(d?.lines).toContain('❯ 1. Yes, proceed');
  });

  it('is null over the prompt box, even with a numbered draft or an old hint above', () => {
    expect(
      parseScreenDialog(['⏺ Done.', '', '────', '❯ 1. fix the build', '────', ' ? for shortcuts']),
    ).toBeNull();
    // The hint must be the dialog's bottom row, not text in the conversation.
    expect(
      parseScreenDialog([
        'Press Enter to confirm · Esc to cancel',
        '❯ 1. x',
        '',
        '────',
        '❯ ',
        '────',
        ' ? for shortcuts',
      ]),
    ).toBeNull();
    expect(parseScreenDialog(['user@host ~ %', ''])).toBeNull();
  });
});

describe("parseScreenDialog({ any: true }) - the slash commands' pickers (CLI 2.1.319)", () => {
  const rule = '▔'.repeat(60);
  const MODEL = [
    'Earlier output of the session',
    rule,
    '   Select model',
    '   Switch between Claude models. Your pick becomes the default for new sessions.',
    '',
    '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
    '   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '     3.  Sonnet 5.5             Most efficient for simpler tasks',
    '     4.  Haiku 5.5              Fastest for quick answers',
    '',
    '   ● High effort ←/→ to adjust',
    '',
    '   Enter to set as default · s to use this session only · Esc to cancel',
    '',
  ];

  it('reads the model picker: title from under its rule, numbered choices, the keys its hint names', () => {
    const d = parseScreenDialog(MODEL, { any: true })!;
    expect(d.title).toBe('Select model');
    // Under a slash command's `▔` rule: no hook reports it, a view shows it at once.
    expect(d.picker).toBe(true);
    expect(d.choices).toEqual([
      {
        id: 'choice:1',
        label: 'Default (recommended) · Opus 5.5 · Best for everyday, complex tasks',
        selected: false,
      },
      { id: 'choice:2', label: 'Opus 5.5 · For complex work and everyday tasks', selected: true },
      { id: 'choice:3', label: 'Sonnet 5.5 · Most efficient for simpler tasks', selected: false },
      { id: 'choice:4', label: 'Haiku 5.5 · Fastest for quick answers', selected: false },
    ]);
    expect(d.keys?.map((k) => k.id)).toEqual(['up', 'down', 'enter', 'esc', 'char:s']);
    expect(d.keys?.find((k) => k.id === 'enter')?.label).toBe('Set as default (Enter)');
    expect(d.keys?.find((k) => k.id === 'char:s')?.label).toBe('Use this session only (s)');
  });

  it('reads a picker with no numbers and a hint wrapped onto two rows (/resume)', () => {
    const d = parseScreenDialog(
      [
        // The rule may carry the effort at its right end; the search box's
        // edges inside the picker are no rule of its own.
        `${rule} ● high · /effort ▔`,
        '   Resume a session',
        '   ╭──────────────────────────────────────',
        '   │ ⌕ Search…',
        '   ╰──────────────────────────────────────',
        '     Rename the release job',
        '     2 hours ago · main · 1.1MB',
        '',
        '     Ctrl+A to show all projects · Space to',
        '     preview · Esc to cancel',
      ],
      { any: true },
    )!;
    expect(d.title).toBe('Resume a session');
    expect(d.choices).toEqual([]);
    expect(d.keys?.map((k) => k.id)).toEqual(['up', 'down', 'enter', 'esc', 'ctrl+a', 'space']);
    expect(d.lines).not.toContain('     Ctrl+A to show all projects · Space to');
  });

  it('offers no digit choices where the list has no highlighted number (the rules list types digits as search)', () => {
    const d = parseScreenDialog(
      [
        rule,
        '   Permissions  Allow   Ask   Deny',
        '     1.  Add a new rule…',
        '     2.  Bash(npm test)',
        '   ←/→ to switch · ↓ to select · Esc to cancel',
      ],
      { any: true },
    )!;
    expect(d.choices).toEqual([]);
    expect(d.keys?.map((k) => k.id)).toEqual(['up', 'down', 'enter', 'esc', 'left', 'right']);
  });

  it('reads a dialog with no picker rule as possibly a permission one (shown after a settle)', () => {
    const d = parseScreenDialog(
      [
        '─'.repeat(40),
        ' Do you trust the files in this folder?',
        ' ❯ 1. Yes, proceed',
        '   2. No, exit',
        ' Enter to confirm · Esc to cancel',
      ],
      { any: true },
    )!;
    expect(d.title).toBe('Do you trust the files in this folder?');
    expect(d.picker).toBe(false);
  });

  it('never reads the prompt box as a picker', () => {
    expect(
      parseScreenDialog(
        [
          '─'.repeat(40),
          '❯ ',
          '─'.repeat(40),
          '  ⏵⏵ auto mode on (shift+tab to cycle) · install gh for PR status',
        ],
        { any: true },
      ),
    ).toBeNull();
  });

  it('turns only a key the dialog on screen takes into bytes', () => {
    const d = parseScreenDialog(MODEL, { any: true })!;
    expect(dialogKeyInput(d, 'choice:3')).toBe('3');
    expect(dialogKeyInput(d, 'choice:7')).toBeNull();
    expect(dialogKeyInput(d, 'char:s')).toBe('s');
    expect(dialogKeyInput(d, 'esc')).toBe('\u001b');
    expect(dialogKeyInput(d, 'down')).toBe('\u001b[B');
    // Not on this dialog's hint row.
    expect(dialogKeyInput(d, 'char:x')).toBeNull();
    expect(dialogKeyInput(d, 'space')).toBeNull();
    expect(dialogKeyInput({ ...d, keys: dialogKeys('Ctrl+R to rename') }, 'ctrl+r')).toBe('\u0012');
  });
});

describe('promptBox (Claude 2.1.319)', () => {
  const rule = '─'.repeat(60);
  const footer = ['  ⏵⏵ auto mode on (shift+tab to cycle)'];

  it('reads the queue placeholder as an empty box', () => {
    expect(
      promptBox(['· Working… (6s)', rule, '❯ Press up to edit queued messages', rule, ...footer]),
    ).toEqual({
      rows: ['Press up to edit queued messages'],
      empty: true,
      queueHint: true,
    });
  });

  it('reads the queued messages ↑ pulled into the box, then the box cleared', () => {
    expect(
      promptBox([rule, '❯ Rename the release job', '  Deploy to staging', rule, ...footer]),
    ).toEqual({
      rows: ['Rename the release job', 'Deploy to staging'],
      empty: false,
      queueHint: false,
    });
    expect(promptBox([rule, '❯ ', rule, ...footer])?.empty).toBe(true);
  });

  it('finds no box under a dialog', () => {
    expect(
      promptBox(['▔'.repeat(40), '   Select model', '   ❯ 1.  Opus 5.5', '   Esc to cancel']),
    ).toBeNull();
  });
});
