// Runs one of the extension's build steps: `node scripts/extension-step.mjs
// <script> [args]`. The step is a file the public tree does not have (a check
// over what only the official build bundles), so in a tree without pro/ there
// is nothing to run and `pnpm build` still finishes. With pro/ present a
// missing script fails as usual.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/extension-step.mjs <script> [args]');
  process.exit(2);
}
if (!existsSync(new URL('../pro', import.meta.url))) {
  console.log(`no pro/ folder: ${script} skipped`);
  process.exit(0);
}
const run = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
process.exit(run.status ?? 1);
