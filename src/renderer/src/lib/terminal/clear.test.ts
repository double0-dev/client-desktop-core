import { describe, expect, it, vi } from 'vitest';
import { clearTerminal } from '@renderer/lib/terminal/clear';

function fakeTerm(type: 'normal' | 'alternate') {
  return { buffer: { active: { type } }, clear: vi.fn() } as unknown as Parameters<
    typeof clearTerminal
  >[0] & { clear: ReturnType<typeof vi.fn> };
}

describe('clearTerminal', () => {
  it('clears a plain shell', () => {
    const term = fakeTerm('normal');
    expect(clearTerminal(term)).toBe(true);
    expect(term.clear).toHaveBeenCalledTimes(1);
  });

  it('leaves a full-screen program alone - it would only repaint over a blank frame', () => {
    const term = fakeTerm('alternate');
    expect(clearTerminal(term)).toBe(false);
    expect(term.clear).not.toHaveBeenCalled();
  });
});
