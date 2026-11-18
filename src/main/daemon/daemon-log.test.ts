import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonLog } from './daemon-log';

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'd0log-'));
  scratch.push(d);
  return d;
};
const clock = (): Date => new Date('2026-10-04T12:00:00.000Z');

describe('createDaemonLog', () => {
  it('creates the folder and appends stamped lines; a null path logs nowhere', () => {
    const path = join(dir(), 'nested', 'daemon-b.log');
    const log = createDaemonLog(path, { now: clock });
    log('hello');
    log('again');
    expect(readFileSync(path, 'utf8')).toBe(
      `2026-10-04T12:00:00.000Z [${process.pid}] hello\n2026-10-04T12:00:00.000Z [${process.pid}] again\n`,
    );
    expect(() => createDaemonLog(null)('x')).not.toThrow();
  });

  it('rotates to .1 once the file would pass the cap, replacing the previous rotation', () => {
    // A daemon that lives for months, or loops on a failing client, must not
    // grow its log without bound.
    const path = join(dir(), 'daemon-b.log');
    const log = createDaemonLog(path, { maxBytes: 200, now: clock });
    const line = (n: number): string => `line ${n} ${'x'.repeat(40)}`;
    log(line(1));
    log(line(2));
    expect(existsSync(`${path}.1`)).toBe(false);
    log(line(3));
    // Three stamped lines run past 200 bytes: the first two were rotated out.
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('line 3');
    expect(readFileSync(path, 'utf8')).not.toContain('line 1');
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('line 1');
    log(line(4));
    log(line(5));
    // The next rotation replaces .1 - never a growing chain of files.
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('line 3');
    expect(readFileSync(`${path}.1`, 'utf8')).not.toContain('line 1');
    expect(statSync(path).size).toBeLessThan(200);
  });

  it('picks up the size of an existing file, so a restart does not reset the cap', () => {
    const path = join(dir(), 'daemon-b.log');
    const first = createDaemonLog(path, { maxBytes: 150, now: clock });
    first('a'.repeat(60));
    const second = createDaemonLog(path, { maxBytes: 150, now: clock });
    second('b'.repeat(60));
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('aaaa');
    expect(readFileSync(path, 'utf8')).toContain('bbbb');
  });

  it('keeps the cap when two daemons of one build write the same file', () => {
    // A replacement daemon can run beside the old one of its build; each
    // counted its own bytes and a rotation by one was invisible to the other
    // (review, 2026-10-06).
    const path = join(dir(), 'daemon-c.log');
    const a = createDaemonLog(path, { maxBytes: 200, now: clock });
    const b = createDaemonLog(path, { maxBytes: 200, now: clock });
    for (let i = 0; i < 20; i++) (i % 2 ? a : b)(`line ${i} ${'x'.repeat(30)}`);
    expect(statSync(path).size).toBeLessThanOrEqual(200);
  });
});
