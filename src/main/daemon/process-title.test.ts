import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TITLE, daemonProcessTitle } from './process-title';

describe('daemonProcessTitle', () => {
  it('never names the daemon through process.title on macOS', () => {
    // Node's darwin title setter checks the process in with LaunchServices
    // under the app's own bundle: the headless daemon turned up in the Dock
    // and the app switcher at every spawn (2026-10-15).
    expect(daemonProcessTitle('darwin')).toBeNull();
  });

  it('keeps the ps-friendly name on the other platforms', () => {
    expect(daemonProcessTitle('linux')).toBe(DAEMON_PROCESS_TITLE);
    expect(daemonProcessTitle('win32')).toBe(DAEMON_PROCESS_TITLE);
    expect(DAEMON_PROCESS_TITLE).toBe('double0-session-daemon');
  });
});
