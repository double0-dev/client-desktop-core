import { useEffect } from 'react';
import { isAppLocked } from './app-lock';
import { isCapturing } from '@renderer/lib/settings/keyboard-shortcuts';

/** Max gap between the two Shift taps to count as the gesture. */
const DOUBLE_TAP_MS = 350;

/**
 * Fire `onTrigger` when Shift is pressed twice in quick succession with nothing
 * between - the "Search Everywhere" gesture. Deliberately global
 * (works from the terminal/editor too); only stands down while a Settings row is
 * capturing a new binding. A held Shift's auto-repeat, Shift as part of a combo
 * (another modifier held), and any key pressed between the taps all cancel it -
 * so typing capital letters never triggers it.
 */
export function useDoubleShift(onTrigger: () => void): void {
  useEffect(() => {
    let lastShift = 0;
    let armed = false; // a clean first Shift tap is waiting for its pair

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Shift') {
        armed = false; // a non-Shift key between taps cancels the gesture
        lastShift = 0;
        return;
      }
      // Auto-repeat from a held Shift, or Shift pressed alongside another
      // modifier, is a combo - not the gesture.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
        armed = false;
        lastShift = 0;
        return;
      }
      if (armed && e.timeStamp - lastShift <= DOUBLE_TAP_MS) {
        armed = false;
        lastShift = 0;
        // Not while a cover owns the window (lib/app-lock.ts): the palette
        // would open under it, take focus and run actions unseen.
        if (!isCapturing() && !isAppLocked()) onTrigger();
        return;
      }
      armed = true;
      lastShift = e.timeStamp;
    };

    // Capture phase so it sees the press even when the terminal/editor is focused.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onTrigger]);
}
