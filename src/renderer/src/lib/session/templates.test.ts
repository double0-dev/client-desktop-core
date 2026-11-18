import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  agentStartupCommand,
  builtinAgentForCommand,
  getSessionTemplateSettings,
  sessionAgentLabel,
  importSessionTemplateSettings,
  agentIconKind,
  isClaudeCodeAgent,
  isTemplateDeletable,
  parseUserTemplates,
} from '@renderer/lib/session/templates';

describe('session templates - built-ins', () => {
  it('ships Terminal (plain shell), Claude Code, Codex and OpenCode', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual([
      'Terminal',
      'Claude Code',
      'Codex',
      'OpenCode',
    ]);
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'terminal')?.startCommand).toBe('');
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'claude-code')?.startCommand).toBe('claude');
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'codex')?.startCommand).toBe('codex');
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'opencode')?.startCommand).toBe('opencode');
  });

  it('has a default that exists among the built-ins', () => {
    expect(BUILTIN_TEMPLATES.some((t) => t.id === DEFAULT_TEMPLATE_ID)).toBe(true);
  });

  it('makes every template deletable except the base Terminal', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(isTemplateDeletable(t)).toBe(t.id !== 'terminal');
    }
    expect(
      isTemplateDeletable({ id: 'x', name: 'My Rig', startCommand: 'claude', builtin: false }),
    ).toBe(true);
  });
});

describe('agent → startup command (fallback for pre-column sessions)', () => {
  it('derives `claude` only for a Claude Code agent label', () => {
    expect(agentStartupCommand('Claude Code')).toBe('claude');
    expect(isClaudeCodeAgent('claude')).toBe(true);
    expect(agentStartupCommand('Terminal')).toBeUndefined();
    expect(agentStartupCommand('Codex')).toBeUndefined();
    expect(agentStartupCommand('Custom')).toBeUndefined();
  });
});

describe('builtinAgentForCommand - which built-in agent a start command launches', () => {
  it('reads a wrapper named after the CLI as that agent, not as a custom command', () => {
    // An alias like `claude-personal` used to launch as "Custom": the tab lost
    // the Claude label and icon, and "+" terminals read "Custom 2".
    expect(builtinAgentForCommand('claude')).toBe('Claude Code');
    expect(builtinAgentForCommand('claude-personal')).toBe('Claude Code');
    expect(builtinAgentForCommand('  claude --resume  ')).toBe('Claude Code');
    expect(builtinAgentForCommand('~/bin/claude-work --model opus')).toBe('Claude Code');
    expect(builtinAgentForCommand('codex')).toBe('Codex');
    expect(builtinAgentForCommand('opencode')).toBe('OpenCode');
    expect(builtinAgentForCommand('opencode -m opencode/claude-haiku-4-5')).toBe('OpenCode');
  });

  it('looks past environment assignments, env prefixes and earlier commands', () => {
    // What a `claude-personal` alias expands to, typed as the start command.
    expect(builtinAgentForCommand('CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude')).toBe(
      'Claude Code',
    );
    expect(builtinAgentForCommand("A=1 B='two words' claude --resume")).toBe('Claude Code');
    expect(builtinAgentForCommand('env -u CLAUDE_CONFIG_DIR claude')).toBe('Claude Code');
    expect(builtinAgentForCommand('env -i PATH=/bin claude')).toBe('Claude Code');
    expect(builtinAgentForCommand('exec claude')).toBe('Claude Code');
    expect(builtinAgentForCommand('cd app && claude')).toBe('Claude Code');
    expect(builtinAgentForCommand('source .env; codex')).toBe('Codex');
  });

  it('matches the program name only, never an argument', () => {
    expect(builtinAgentForCommand('npx my-claude')).toBeUndefined();
    expect(builtinAgentForCommand('echo claude')).toBeUndefined();
  });

  it('leaves a plain shell and other commands unmatched', () => {
    expect(builtinAgentForCommand('')).toBeUndefined();
    expect(builtinAgentForCommand('   ')).toBeUndefined();
    expect(builtinAgentForCommand('npm run dev')).toBeUndefined();
  });
});

describe('sessionAgentLabel - the label a session shows', () => {
  it('reads a stored "Custom" whose command launches a built-in agent as that agent', () => {
    // Sessions created before the command was recognised keep "Custom" in
    // their row; their tabs must still read Claude Code.
    expect(sessionAgentLabel({ agent: 'Custom', startCommand: 'CLAUDE_CONFIG_DIR=x claude' })).toBe(
      'Claude Code',
    );
    expect(sessionAgentLabel({ agent: 'Custom', startCommand: 'npm run dev' })).toBe('Custom');
  });

  it("keeps any other stored label, and a runtime session's", () => {
    expect(sessionAgentLabel({ agent: 'My Rig', startCommand: 'claude' })).toBe('My Rig');
    expect(sessionAgentLabel({ agent: 'Custom', startCommand: 'claude', runtime: 'acp' })).toBe(
      'Custom',
    );
  });
});

describe('parseUserTemplates - sanitizing untrusted localStorage', () => {
  it('keeps valid entries and marks them non-builtin', () => {
    const out = parseUserTemplates([
      { id: 'a', name: 'My Rig', startCommand: 'claude --resume' },
      { id: 'b', name: 'Bare', startCommand: '' },
    ]);
    expect(out).toEqual([
      { id: 'a', name: 'My Rig', startCommand: 'claude --resume', builtin: false },
      { id: 'b', name: 'Bare', startCommand: '', builtin: false },
    ]);
  });

  it('drops entries with no usable name, trims names, and defaults a missing command', () => {
    const out = parseUserTemplates([
      { id: 'a', name: '   Spaced  ' }, // startCommand missing → ''
      { id: 'b', name: '   ' }, // blank name → dropped
      { id: 'c', startCommand: 'x' }, // no name → dropped
      { name: 'No Id', startCommand: 'y' }, // missing id → generated
      42, // non-object → dropped
      null,
    ]);
    expect(out.map((t) => ({ name: t.name, startCommand: t.startCommand }))).toEqual([
      { name: 'Spaced', startCommand: '' },
      { name: 'No Id', startCommand: 'y' },
    ]);
    expect(out.every((t) => typeof t.id === 'string' && t.id.length > 0)).toBe(true);
  });

  it('returns [] for non-array / garbage input', () => {
    expect(parseUserTemplates(null)).toEqual([]);
    expect(parseUserTemplates('nope')).toEqual([]);
    expect(parseUserTemplates({ name: 'x' })).toEqual([]);
  });
});

describe('settings-transfer surface', () => {
  it('round-trips user templates and hidden built-ins', () => {
    importSessionTemplateSettings({
      user: [{ id: 'a', name: 'My Rig', startCommand: 'claude --resume' }],
      hiddenBuiltins: ['codex'],
    });
    expect(getSessionTemplateSettings()).toEqual({
      user: [{ id: 'a', name: 'My Rig', startCommand: 'claude --resume' }],
      hiddenBuiltins: ['codex'],
    });
  });

  it('sanitizes imports: blank names dropped, the base Terminal never hidden', () => {
    importSessionTemplateSettings({
      user: [
        { id: 'a', name: '   ', startCommand: 'x' },
        { id: 'b', name: 'Kept', startCommand: '' },
      ],
      hiddenBuiltins: ['terminal', 'claude-code'],
    });
    const out = getSessionTemplateSettings();
    expect(out.user.map((t) => t.name)).toEqual(['Kept']);
    expect(out.hiddenBuiltins).toEqual(['claude-code']);
  });
});

describe('runtime sessions', () => {
  it('a runtime session runs nothing in its terminals; a terminal session runs its command', async () => {
    const { runsInView, sessionTerminalCommand } = await import('./templates');
    const viewed = { runtime: 'gadget-view', startCommand: 'gadget serve', agent: 'Gadget' };
    expect(runsInView(viewed)).toBe(true);
    expect(sessionTerminalCommand(viewed)).toBeUndefined();
    expect(
      sessionTerminalCommand({ runtime: null, startCommand: 'claude', agent: 'Claude Code' }),
    ).toBe('claude');
    // Pre-column sessions derive the command from the label, as before.
    expect(sessionTerminalCommand({ agent: 'Claude Code' })).toBe('claude');
  });
});

describe('agentIconKind - which agent glyph a tab or session label gets', () => {
  it('names Claude Code, Codex and OpenCode tabs, numbered "+" tabs included', () => {
    // Codex and OpenCode tabs showed the plain terminal icon while a Claude one had its glyph.
    expect(agentIconKind('Claude Code')).toBe('claude');
    expect(agentIconKind('Claude Code 2')).toBe('claude');
    expect(agentIconKind('Codex')).toBe('codex');
    expect(agentIconKind('Codex 2')).toBe('codex');
    expect(agentIconKind('OpenCode')).toBe('opencode');
    expect(agentIconKind('OpenCode 3')).toBe('opencode');
  });

  it('leaves a plain shell and a custom label on the terminal icon', () => {
    expect(agentIconKind('Terminal')).toBeNull();
    expect(agentIconKind('Terminal 2')).toBeNull();
    expect(agentIconKind('Custom')).toBeNull();
  });
});
