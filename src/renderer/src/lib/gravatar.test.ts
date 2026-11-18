import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAvatarUrlFailed, markAvatarUrlFailed } from '@renderer/lib/gravatar';

/**
 * The failure memory behind the graph's avatars: a URL that failed to load
 * renders initials immediately instead of being re-requested for every row.
 */

const URL_A = 'https://avatars.example/emmaw?s=44';
const URL_B = 'https://avatars.example/jamesc?s=44';

afterEach(() => {
  vi.useRealTimers();
});

describe('avatar failure memory', () => {
  it('remembers only the URL that failed', () => {
    markAvatarUrlFailed(URL_A);
    expect(isAvatarUrlFailed(URL_A)).toBe(true);
    expect(isAvatarUrlFailed(URL_B)).toBe(false);
  });

  it('forgets a failure after a while, so the picture can come back', () => {
    // A failed load is usually permanent (the author has no picture) but it is
    // equally a moment offline - remembering that for the whole session left
    // the graph on initials until the app was restarted.
    vi.useFakeTimers();
    markAvatarUrlFailed(URL_B);
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(isAvatarUrlFailed(URL_B)).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(isAvatarUrlFailed(URL_B)).toBe(false);
  });
});
