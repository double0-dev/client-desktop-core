import { describe, expect, it } from 'vitest';
import { liveBandClass, projectLiveBand, sessionLiveBand } from '@renderer/lib/session/live-band';

describe('sessionLiveBand', () => {
  // Must agree with isLiveSessionStatus: the rows whose dot breathes are
  // exactly the rows that get a band.
  it('washes a working session green', () => {
    expect(sessionLiveBand('active')).toBe('running');
  });

  it('washes a session blocked on the user amber', () => {
    expect(sessionLiveBand('needs-input')).toBe('needs-input');
  });

  it.each(['idle', 'done', 'archived', ''])('leaves %j unwashed', (status) => {
    expect(sessionLiveBand(status)).toBeNull();
  });
});

describe('projectLiveBand', () => {
  it('has no band without sessions', () => {
    expect(projectLiveBand(undefined)).toBeNull();
    expect(
      projectLiveBand({ count: 2, active: false, needsInput: false, finished: false }),
    ).toBeNull();
  });

  it('follows the roll-up', () => {
    expect(projectLiveBand({ count: 1, active: true, needsInput: false, finished: false })).toBe(
      'running',
    );
    expect(projectLiveBand({ count: 1, active: false, needsInput: true, finished: false })).toBe(
      'needs-input',
    );
  });

  it('lets needs-input win over running, like the project dot does', () => {
    expect(projectLiveBand({ count: 2, active: true, needsInput: true, finished: false })).toBe(
      'needs-input',
    );
  });
});

describe('liveBandClass', () => {
  it('adds nothing when there is no band', () => {
    expect(liveBandClass(null)).toBeUndefined();
    expect(liveBandClass(undefined)).toBeUndefined();
  });

  it('pairs the base class with the colour class', () => {
    expect(liveBandClass('running')).toBe('live-band live-band-running');
    expect(liveBandClass('needs-input')).toBe('live-band live-band-needs-input');
  });
});

describe('the finished-unseen mark', () => {
  it('washes nothing - the static info dot is the whole signal', () => {
    expect(sessionLiveBand('finished')).toBeNull();
    expect(
      projectLiveBand({ count: 1, active: false, needsInput: false, finished: true }),
    ).toBeNull();
  });
});

describe('the finished tab wash', () => {
  it('paints the static info wash for a finished tab', () => {
    expect(liveBandClass('finished')).toBe('live-band live-band-finished');
  });
});
