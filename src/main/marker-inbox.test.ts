import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkerInbox, markerFileOrder, validMarkers } from './marker-inbox';

describe('markerFileOrder', () => {
  it('orders published files by their stamp, then pid, numerically', () => {
    expect(
      markerFileOrder([
        '1793218547596914500-1415.m',
        '1793218547367704500-320.m',
        // Not published yet, or not ours.
        '1793218547367704400-9.tmp',
        'notes.txt',
        '1793218547367704500-12.m',
        // A shorter stamp (a `date` without %N) is still a number.
        '999-1.m',
      ]),
    ).toEqual([
      '999-1.m',
      '1793218547367704500-12.m',
      '1793218547367704500-320.m',
      '1793218547596914500-1415.m',
    ]);
  });
});

describe('validMarkers', () => {
  it('passes the markers the hook script writes', () => {
    for (const text of [
      '\x1b]6790;ready\x07',
      '\x1b]6790;running\x07\x1b]6791;prompt;eyJwcm9tcHQiOiJoaSJ9\x07',
      '\x1b]6790;tool-start;UmVhZApzcmMvYS50cwo=\x07',
      '\x1b]6790;needs-input\x07',
    ]) {
      expect(validMarkers(text)).toBe(text);
    }
  });

  // Whatever is in the folder is written to the user's screen.
  it('refuses anything else', () => {
    for (const text of [
      '',
      'plain text',
      '\x1b]0;a title\x07',
      '\x1b]6790;running\x07rm -rf ~\r',
      '\x1b]6790;running',
      '\x1b]6790;run ning\x07',
      '\x1b[2J\x1b]6790;running\x07',
    ]) {
      expect(validMarkers(text)).toBeNull();
    }
  });
});

describe('MarkerInbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'double0-inbox-')), 'markers');
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('drains the published markers in order and removes them', async () => {
    const inbox = new MarkerInbox(dir);
    // A folder swept away (temp cleanup) is made again for the next hook.
    expect(await inbox.drain()).toBe('');
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, '2-1.m'), '\x1b]6790;finished\x07');
    writeFileSync(join(dir, '1-1.m'), '\x1b]6790;running\x07');
    writeFileSync(join(dir, '3-1.m'), 'not a marker');
    writeFileSync(join(dir, '4-1.tmp'), '\x1b]6790;ended\x07');
    expect(await inbox.drain()).toBe('\x1b]6790;running\x07\x1b]6790;finished\x07');
    expect(readdirSync(dir)).toEqual(['4-1.tmp']);
    expect(await inbox.drain()).toBe('');
    await inbox.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it('empties the folder for a new shell', () => {
    const inbox = new MarkerInbox(dir);
    inbox.reset();
    writeFileSync(join(dir, '1-1.m'), '\x1b]6790;running\x07');
    writeFileSync(join(dir, '2-1.tmp'), '\x1b]6790;fin');
    inbox.reset();
    expect(readdirSync(dir)).toEqual([]);
  });

  // A file whose delete failed (a scanner holding it) was read again on the
  // next drain: every marker in it twice - a second prompt in the Inputs list.
  it('reads a file once: a claimed leftover is removed, never read', async () => {
    const inbox = new MarkerInbox(dir);
    inbox.reset();
    writeFileSync(join(dir, '1-1.m.taken'), '\x1b]6790;running\x07');
    writeFileSync(join(dir, '2-1.m'), '\x1b]6790;finished\x07');
    expect(await inbox.drain()).toBe('\x1b]6790;finished\x07');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not make the folder again once the terminal is gone', async () => {
    const inbox = new MarkerInbox(dir);
    await inbox.dispose();
    expect(await inbox.drain()).toBe('');
    expect(existsSync(dir)).toBe(false);
  });
});
