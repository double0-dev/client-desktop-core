import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keptFiles } from './kept-files';

describe('keptFiles', () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'double0-kept-files-test-'));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('writes once while the files stay on disk', () => {
    const file = join(scratch(), 'settings.json');
    let writes = 0;
    const get = keptFiles(() => {
      writes += 1;
      writeFileSync(file, '{}');
      return { path: file, files: [file] };
    });
    expect(get()).toBe(file);
    expect(get()).toBe(file);
    expect(writes).toBe(1);
  });

  // The bug: the temp folder was swept under a running app and every later
  // launch pointed the agent at a settings file that no longer existed.
  it('writes again when a file behind the path has gone', () => {
    const root = scratch();
    const settings = join(root, 'settings.json');
    const script = join(root, 'hook.sh');
    let writes = 0;
    const get = keptFiles(() => {
      writes += 1;
      writeFileSync(settings, '{}');
      writeFileSync(script, '#!/bin/sh');
      return { path: settings, files: [settings, script] };
    });
    get();
    // A file the path only depends on counts too.
    rmSync(script);
    expect(get()).toBe(settings);
    expect(writes).toBe(2);
    rmSync(settings);
    expect(get()).toBe(settings);
    expect(writes).toBe(3);
  });

  it('answers null for a failed write and tries again next time', () => {
    const file = join(scratch(), 'settings.json');
    let fail = true;
    const get = keptFiles(() => {
      if (fail) throw new Error('read-only');
      writeFileSync(file, '{}');
      return { path: file, files: [file] };
    });
    expect(get()).toBeNull();
    fail = false;
    expect(get()).toBe(file);
  });
});
