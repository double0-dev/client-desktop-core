import { describe, expect, it } from 'vitest';
import { FlowAccounting } from './flow-accounting';

// One slow laptop must never stall a terminal for the other
// (a private plan › 14, "A slow client").
describe('FlowAccounting', () => {
  it('sends everything to a client that never paused', () => {
    const f = new FlowAccounting(10);
    expect(f.chunk(1, 't1', 1_000)).toBe('send');
  });

  it('counts a paused client, notifies it once past the limit, then drops for it alone', () => {
    const f = new FlowAccounting(10);
    f.pause(1, 't1');
    expect(f.chunk(1, 't1', 6)).toBe('send');
    expect(f.chunk(1, 't1', 4)).toBe('send');
    expect(f.chunk(1, 't1', 1)).toBe('notify');
    expect(f.chunk(1, 't1', 1)).toBe('drop');
    // The other client is untouched.
    expect(f.chunk(2, 't1', 50)).toBe('send');
  });

  it('keeps a dropped client dropped across a resume until it re-adopts - a stream with a hole is worse than none', () => {
    const f = new FlowAccounting(1);
    f.pause(1, 't1');
    expect(f.chunk(1, 't1', 2)).toBe('notify');
    f.resume(1, 't1');
    expect(f.chunk(1, 't1', 1)).toBe('drop');
    f.adopted(1, 't1');
    expect(f.chunk(1, 't1', 1)).toBe('send');
  });

  it('forgets the count of a client that resumed in time', () => {
    const f = new FlowAccounting(10);
    f.pause(1, 't1');
    f.chunk(1, 't1', 8);
    f.resume(1, 't1');
    f.pause(1, 't1');
    expect(f.chunk(1, 't1', 8)).toBe('send');
  });

  it('stops the pty only while every attached client paused it', () => {
    const f = new FlowAccounting();
    f.pause(1, 't1');
    expect(f.allPaused('t1', [1])).toBe(true);
    expect(f.allPaused('t1', [1, 2])).toBe(false);
    f.pause(2, 't1');
    expect(f.allPaused('t1', [1, 2])).toBe(true);
    expect(f.allPaused('t1', [])).toBe(false);
  });

  it('drops what a detached client and an ended terminal owed', () => {
    const f = new FlowAccounting(1);
    f.pause(1, 't1');
    f.pause(1, 't2');
    f.connectionGone(1);
    expect(f.chunk(1, 't1', 5)).toBe('send');
    f.pause(2, 't3');
    f.forget('t3');
    expect(f.isPaused(2, 't3')).toBe(false);
  });
});
