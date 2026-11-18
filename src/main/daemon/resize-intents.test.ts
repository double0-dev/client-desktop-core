import { describe, expect, it } from 'vitest';
import { CLAIM_HOLD_MS, ResizeArbiter } from './resize-intents';

// Two laptops on one host (a private plan › 14): the one
// the user interacts with sets the grid; the other follows.
describe('ResizeArbiter', () => {
  const at = (t: { now: number }) => () => t.now;

  it('applies every intent while nobody claimed', () => {
    const r = new ResizeArbiter();
    expect(r.intent('t1', 1, 'passive')).toBe(true);
    expect(r.intent('t1', 2, 'passive')).toBe(true);
    expect(r.claimant('t1')).toBeNull();
  });

  it("refuses another client's passive intent while a claim is fresh - a window shown again must not take the screen", () => {
    const t = { now: 0 };
    const r = new ResizeArbiter(at(t));
    expect(r.intent('t1', 1, 'claim')).toBe(true);
    t.now = CLAIM_HOLD_MS - 1;
    expect(r.intent('t1', 2, 'passive')).toBe(false);
    // The claimant's own passive refits still apply (its panel toggled).
    expect(r.intent('t1', 1, 'passive')).toBe(true);
    expect(r.claimant('t1')).toBe(1);
  });

  it('lets the last interacting client win: a claim always applies and moves the claim', () => {
    const r = new ResizeArbiter(() => 0);
    r.intent('t1', 1, 'claim');
    expect(r.intent('t1', 2, 'claim')).toBe(true);
    expect(r.claimant('t1')).toBe(2);
    expect(r.intent('t1', 1, 'passive')).toBe(false);
  });

  it('lets a passive intent through once the claim is older than the hold', () => {
    const t = { now: 0 };
    const r = new ResizeArbiter(at(t));
    r.intent('t1', 1, 'claim');
    t.now = CLAIM_HOLD_MS;
    expect(r.claimant('t1')).toBeNull();
    expect(r.intent('t1', 2, 'passive')).toBe(true);
  });

  it('keeps claims per terminal', () => {
    const r = new ResizeArbiter(() => 0);
    r.intent('t1', 1, 'claim');
    expect(r.intent('t2', 2, 'passive')).toBe(true);
  });

  it('drops the claims of a client that detached, and of a terminal that ended', () => {
    const r = new ResizeArbiter(() => 0);
    r.intent('t1', 1, 'claim');
    r.intent('t2', 1, 'claim');
    r.connectionGone(1);
    expect(r.intent('t1', 2, 'passive')).toBe(true);
    r.intent('t3', 2, 'claim');
    r.forget('t3');
    expect(r.intent('t3', 1, 'passive')).toBe(true);
  });
});
