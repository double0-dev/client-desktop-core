import { describe, expect, it, vi } from 'vitest';
import {
  requestEditorReveal,
  subscribeEditorReveal,
  takeEditorReveal,
} from '@renderer/lib/workspace/editor-reveal';

describe('editor reveal requests', () => {
  it('hands a position to the file it was asked for, once', () => {
    // Taken once: a later re-render of the same editor must not jump back.
    requestEditorReveal('/repo/a.ts', { line: 42, column: 7 });
    expect(takeEditorReveal('/repo/b.ts')).toBeUndefined();
    expect(takeEditorReveal('/repo/a.ts')).toEqual({ line: 42, column: 7 });
    expect(takeEditorReveal('/repo/a.ts')).toBeUndefined();
  });

  it('notifies already-open editors', () => {
    const listener = vi.fn();
    const off = subscribeEditorReveal(listener);
    requestEditorReveal('/repo/a.ts', { line: 3 });
    off();
    requestEditorReveal('/repo/a.ts', { line: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
    takeEditorReveal('/repo/a.ts');
  });

  it('lets a request no editor took expire', () => {
    // A failed open never takes it; a later, unrelated open of that file must
    // not jump to the old line (review, 2026-10-06).
    vi.useFakeTimers();
    requestEditorReveal('/repo/a.ts', { line: 9 });
    vi.advanceTimersByTime(11_000);
    expect(takeEditorReveal('/repo/a.ts')).toBeUndefined();
    vi.useRealTimers();
  });
});
