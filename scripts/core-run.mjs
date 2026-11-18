#!/usr/bin/env node
// Runs a command as the core build (`PRO=0`, a private plan):
// `node scripts/core-run.mjs vitest run`. A `PRO=0 cmd` script prefix works
// in sh only - pnpm runs scripts through cmd.exe on Windows.
//
// The project's own `node_modules/.bin` goes first on PATH, as pnpm does for
// a script: a workflow step runs this with plain `node`, where a CI runner's
// PATH has no `electron-vite` - the build step exited 1 with no message.
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/core-run.mjs <command> [args...]');
  process.exit(2);
}
const env = { ...process.env, PRO: '0' };
// Windows names it `Path`; a second `PATH` key on the copy would be a second variable.
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = [join(process.cwd(), 'node_modules', '.bin'), env[pathKey]]
  .filter(Boolean)
  .join(delimiter);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});
if (result.error) {
  console.error(`core-run: could not start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
