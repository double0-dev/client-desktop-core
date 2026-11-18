import { describe, expect, it } from 'vitest';
import type { Tab } from '@renderer/lib/workspace/layout';
import { agentCliName, followsAgentCli } from './cli-view';

const shell = (extra: Partial<Tab> = {}): Tab => ({
  id: 't1',
  kind: 'terminal',
  title: 'zsh',
  ptyId: '3f0c5a52-8f1e-4a57-9d36-2b8f1a6c7e10',
  ...extra,
});

describe('followsAgentCli', () => {
  it('offers the view over a Claude or a Codex tab', () => {
    expect(followsAgentCli(shell({ title: 'Claude Code' }))).toBe(true);
    expect(followsAgentCli(shell({ startupCommand: 'claude --resume' }))).toBe(true);
    expect(followsAgentCli(shell({ title: 'Codex' }))).toBe(true);
    expect(followsAgentCli(shell({ startupCommand: 'CODEX_HOME=~/.codex-work codex' }))).toBe(true);
  });

  it('keeps it off a plain shell, unless the tab already shows in the view', () => {
    expect(followsAgentCli(shell())).toBe(false);
    expect(followsAgentCli(shell({ startupCommand: 'npm run dev' }))).toBe(false);
    expect(followsAgentCli(shell({ view: 'gadget' }))).toBe(true);
  });

  it('needs a shell behind the tab', () => {
    expect(followsAgentCli(shell({ title: 'Codex', ptyId: undefined }))).toBe(false);
  });
});

describe('agentCliName', () => {
  it('names the CLI for the view button', () => {
    expect(agentCliName(shell({ title: 'Codex' }))).toBe('Codex');
    expect(agentCliName(shell({ startupCommand: 'claude' }))).toBe('Claude');
    expect(agentCliName(shell({ view: 'gadget' }))).toBe('agent');
  });
});
