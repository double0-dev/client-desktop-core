import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePath, shellCommandPath, shellPath } from './shell-path';

describe('shellCommandPath', () => {
  it('quotes the forward-slashed path as one shell word', () => {
    expect(shellCommandPath('C:\\Users\\Emma Wilson\\Temp\\seq.sh', 'win32')).toBe(
      "'C:/Users/Emma Wilson/Temp/seq.sh'",
    );
    expect(shellCommandPath("/tmp/it's/seq.sh", 'linux')).toBe("'/tmp/it'\\''s/seq.sh'");
  });

  it('lets git run an editor whose folder has a space in it', () => {
    // Git runs GIT_EDITOR through `sh`; an unquoted path split at the space.
    const dir = mkdtempSync(join(tmpdir(), 'double0-shell path-'));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const editor = join(dir, 'msg.sh');
      writeFileSync(editor, '#!/bin/sh\necho reworded > "$1"\n', { mode: 0o700 });
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, GIT_EDITOR: shellCommandPath(editor) },
        });
      git('init', '-q');
      git(
        '-c',
        'user.name=Emma Wilson',
        '-c',
        'user.email=emmaw@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'first',
      );
      git(
        '-c',
        'user.name=Emma Wilson',
        '-c',
        'user.email=emmaw@example.com',
        'commit',
        '-q',
        '--amend',
        '--allow-empty',
      );
      expect(git('log', '-1', '--format=%s').trim()).toBe('reworded');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('nativePath', () => {
  it('turns the C:/… git reports on Windows into the C:\\… the app picked', () => {
    expect(nativePath('C:/Users/emmaw/acme/.worktree/fix-auth', 'win32')).toBe(
      'C:\\Users\\emmaw\\acme\\.worktree\\fix-auth',
    );
  });

  it('leaves a POSIX path alone', () => {
    expect(nativePath('/Users/emmaw/acme', 'darwin')).toBe('/Users/emmaw/acme');
    expect(nativePath('/home/emmaw/acme', 'linux')).toBe('/home/emmaw/acme');
  });
});

describe('shellPath', () => {
  it('forward-slashes a Windows path so Git Bash does not eat the backslashes', () => {
    expect(
      shellPath('C:\\Users\\emmaw\\AppData\\Local\\Temp\\double0-git\\ssh-hosting.sh', 'win32'),
    ).toBe('C:/Users/emmaw/AppData/Local/Temp/double0-git/ssh-hosting.sh');
  });

  it('leaves a POSIX path alone, where a backslash is a legal file name character', () => {
    expect(shellPath('/tmp/odd\\name/seq.sh', 'darwin')).toBe('/tmp/odd\\name/seq.sh');
    expect(shellPath('/tmp/odd\\name/seq.sh', 'linux')).toBe('/tmp/odd\\name/seq.sh');
  });
});
