import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  launchNoticeDue,
  loadSessionDaemonState,
  parseSessionDaemonState,
  windowCloseKillsTerminals,
  writeSessionDaemonState,
} from './session-daemon-state';

const FRESH = { keepRunning: true, launchNoticeShown: false };

describe('windowCloseKillsTerminals', () => {
  it('spares the shells when a quit keeps sessions running', () => {
    expect(
      windowCloseKillsTerminals({ quitting: true, keepRunning: true, stopRequested: false }),
    ).toBe(false);
  });

  it('kills them on a quit that stops sessions', () => {
    expect(
      windowCloseKillsTerminals({ quitting: true, keepRunning: false, stopRequested: false }),
    ).toBe(true);
    expect(
      windowCloseKillsTerminals({ quitting: true, keepRunning: true, stopRequested: true }),
    ).toBe(true);
  });

  it('kills them when a window closes outside a quit', () => {
    expect(
      windowCloseKillsTerminals({ quitting: false, keepRunning: true, stopRequested: false }),
    ).toBe(true);
  });
});

describe('launchNoticeDue', () => {
  it('is due once: terminals outlived the last run and the notice was never shown', () => {
    expect(launchNoticeDue(FRESH, 3)).toBe(true);
    expect(launchNoticeDue(FRESH, 0)).toBe(false);
    expect(launchNoticeDue({ ...FRESH, launchNoticeShown: true }, 3)).toBe(false);
  });
});

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'double0-session-daemon-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseSessionDaemonState', () => {
  it('defaults to keeping sessions and asks for a rewrite when the file is missing or odd', () => {
    expect(parseSessionDaemonState(null)).toEqual({ state: FRESH, rewrite: true });
    expect(parseSessionDaemonState('not json')).toEqual({ state: FRESH, rewrite: true });
    expect(parseSessionDaemonState('{"keepRunning":"yes"}')).toEqual({
      state: FRESH,
      rewrite: true,
    });
  });

  it('keeps an explicit choice', () => {
    expect(parseSessionDaemonState('{"keepRunning":false}')).toEqual({
      state: { keepRunning: false, launchNoticeShown: false },
      rewrite: false,
    });
  });

  it('reads a file from before the notice existed as "not shown yet" without rewriting it', () => {
    // The flag is written the day it flips; an older file is left alone.
    expect(parseSessionDaemonState('{"keepRunning":true}')).toEqual({
      state: FRESH,
      rewrite: false,
    });
  });

  it('keeps the shown flag, and only a true one', () => {
    expect(
      parseSessionDaemonState('{"keepRunning":true,"launchNoticeShown":true}').state
        .launchNoticeShown,
    ).toBe(true);
    expect(
      parseSessionDaemonState('{"keepRunning":true,"launchNoticeShown":"yes"}').state
        .launchNoticeShown,
    ).toBe(false);
  });
});

describe('loadSessionDaemonState', () => {
  it('creates the file with the defaults on first read and reads a saved choice back', () => {
    const path = join(scratch(), 'nested', 'session-daemon.json');
    expect(loadSessionDaemonState(path)).toEqual(FRESH);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FRESH);
    writeSessionDaemonState(path, { keepRunning: false, launchNoticeShown: true });
    expect(loadSessionDaemonState(path)).toEqual({ keepRunning: false, launchNoticeShown: true });
  });

  it('replaces a corrupt file rather than failing the launch', () => {
    const path = join(scratch(), 'session-daemon.json');
    writeFileSync(path, '{{{', 'utf8');
    expect(loadSessionDaemonState(path)).toEqual(FRESH);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FRESH);
  });
});
