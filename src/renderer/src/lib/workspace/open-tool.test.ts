import { describe, expect, it, vi } from 'vitest';
import { onOpenToolRequest, requestOpenTool } from './open-tool';

describe('open-tool requests', () => {
  it('reaches every subscriber until it unsubscribes', () => {
    const seen = vi.fn();
    const off = onOpenToolRequest(seen);
    requestOpenTool('tasks');
    expect(seen).toHaveBeenCalledWith('tasks');
    off();
    requestOpenTool('gadget');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
