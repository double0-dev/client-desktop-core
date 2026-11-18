import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDoubleShift } from './use-double-shift';
import { setAppLocked } from './app-lock';

function Host({ onTrigger }: { onTrigger: () => void }) {
  useDoubleShift(onTrigger);
  return null;
}

/** One Shift tap: down then up, as a keyboard sends it. */
const tap = (): void => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true }),
  );
  window.dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }),
  );
};

afterEach(() => setAppLocked(false));

describe('useDoubleShift', () => {
  it('fires on two quick Shift taps', () => {
    const onTrigger = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    tap();
    tap();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('stands down while something covers the whole window', () => {
    // The palette would open under the cover, take focus and run actions unseen.
    const onTrigger = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    setAppLocked(true);
    tap();
    tap();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
