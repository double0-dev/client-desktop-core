import { describe, expect, it } from 'vitest';
import { envPath, setEnvPath } from './env-path';

describe('env PATH on Windows', () => {
  // A copy of Windows' process.env names it `Path`. Setting `PATH` beside it
  // gave every terminal two PATHs, and the shell took the one holding only
  // the tool folder: node, git and every other tool were not found.
  it('sets the PATH the env already has, never a second one', () => {
    const env: Record<string, string> = {
      Path: 'C:\\Windows;C:\\Program Files\\nodejs',
      TERM: 'x',
    };
    setEnvPath(env, `C:\\tools;${envPath(env, 'win32')}`, 'win32');
    expect(env).toEqual({ Path: 'C:\\tools;C:\\Windows;C:\\Program Files\\nodejs', TERM: 'x' });
  });

  it('folds every spelling into one', () => {
    const env: Record<string, string> = { Path: 'a', PATH: 'b', path: 'c' };
    expect(envPath(env, 'win32')).toBe('a');
    setEnvPath(env, 'd', 'win32');
    expect(env).toEqual({ Path: 'd' });
  });

  it('adds PATH when there is none', () => {
    expect(envPath({}, 'win32')).toBeUndefined();
    expect(setEnvPath({}, 'x', 'win32')).toEqual({ PATH: 'x' });
  });
});

describe('env PATH elsewhere', () => {
  // Names are case-sensitive on macOS and Linux: a `Path` there is some other
  // variable and must stay as it is.
  it('reads and writes PATH only', () => {
    const env: Record<string, string> = { PATH: '/usr/bin', Path: 'unrelated' };
    expect(envPath(env, 'darwin')).toBe('/usr/bin');
    setEnvPath(env, '/tools:/usr/bin', 'linux');
    expect(env).toEqual({ PATH: '/tools:/usr/bin', Path: 'unrelated' });
    expect(envPath({ Path: 'x' }, 'linux')).toBeUndefined();
  });
});
