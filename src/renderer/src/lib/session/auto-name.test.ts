import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

// Hoisted: `vi.mock` factories run before module-level consts are initialised.
const { get, update } = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: { get, update } }));

import { cleanTitle, observeAutoNaming, sessionIdOfConversationPty } from './auto-name';

describe('sessionIdOfConversationPty', () => {
  it('extracts the session id from a conversation shell id', () => {
    expect(sessionIdOfConversationPty('conversation:abc-123')).toBe('abc-123');
  });

  it('rejects every other shell - setup, commands, extra tabs', () => {
    expect(sessionIdOfConversationPty('setup:abc-123')).toBeNull();
    expect(sessionIdOfConversationPty('commands:abc-123:dev')).toBeNull();
    expect(sessionIdOfConversationPty('term-9')).toBeNull();
    expect(sessionIdOfConversationPty('conversation:')).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('strips the agent activity glyph and collapses whitespace', () => {
    // Claude Code titles its terminal `✳ <task summary>` while working.
    expect(cleanTitle('✳ Fixing  auth   tokens')).toBe('Fixing auth tokens');
  });

  it('drops control characters a broken title might carry', () => {
    expect(cleanTitle('deploy\x07 watcher\x1b')).toBe('deploy watcher');
  });

  it('caps at the label column length (64)', () => {
    const cleaned = cleanTitle('x'.repeat(200));
    expect(cleaned).toHaveLength(64);
  });

  it('returns null when nothing usable remains', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('✳ ✻ …')).toBeNull();
  });
});

describe('observeAutoNaming', () => {
  let emit: ((id: string, title: string) => void) | null = null;

  beforeEach(() => {
    // Module-level spies survive restoreMocks.
    get.mockReset();
    update.mockReset();
    emit = null;
    stubApi({
      terminal: {
        onTitleChange: vi.fn((cb: (id: string, title: string) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        }),
      },
    });
  });

  it('renames an auto-named session to its conversation title', () => {
    get.mockReturnValue({ id: 's1', label: 'Claude Code', autoNamed: true, status: 'active' });
    observeAutoNaming();
    emit?.('conversation:s1', '✳ Fixing auth tokens');

    expect(update).toHaveBeenCalledWith('s1', expect.any(Function));
    const draft = { label: 'Claude Code' };
    (update.mock.calls[0][1] as (d: typeof draft) => void)(draft);
    expect(draft.label).toBe('Fixing auth tokens');
  });

  it('keeps following later titles while the session stays auto-named', () => {
    get.mockReturnValue({
      id: 's1',
      label: 'Fixing auth tokens',
      autoNamed: true,
      status: 'active',
    });
    observeAutoNaming();
    emit?.('conversation:s1', 'Writing tests');

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('never touches a user-named session', () => {
    // autoNamed=false is the pin a manual rename sets (saveSessionEdits).
    get.mockReturnValue({ id: 's1', label: 'my-name', autoNamed: false, status: 'active' });
    observeAutoNaming();
    emit?.('conversation:s1', 'Some new title');

    expect(update).not.toHaveBeenCalled();
  });

  it('ignores titles from non-conversation shells and unknown sessions', () => {
    get.mockReturnValue(undefined);
    observeAutoNaming();
    emit?.('setup:s1', 'npm install');
    emit?.('conversation:ghost', 'anything');

    expect(update).not.toHaveBeenCalled();
  });

  it('skips no-op titles: unusable, or already the label', () => {
    get.mockReturnValue({
      id: 's1',
      label: 'Fixing auth tokens',
      autoNamed: true,
      status: 'active',
    });
    observeAutoNaming();
    emit?.('conversation:s1', '✳ ');
    emit?.('conversation:s1', '✳ Fixing auth tokens');

    expect(update).not.toHaveBeenCalled();
  });

  it('leaves archived sessions alone', () => {
    get.mockReturnValue({ id: 's1', label: 'old', autoNamed: true, status: 'archived' });
    observeAutoNaming();
    emit?.('conversation:s1', 'New title');

    expect(update).not.toHaveBeenCalled();
  });

  it('unsubscribing stops the observer', () => {
    get.mockReturnValue({ id: 's1', label: 'x', autoNamed: true, status: 'active' });
    const off = observeAutoNaming();
    off();
    expect(emit).toBeNull();
  });
});
