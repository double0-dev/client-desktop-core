#!/usr/bin/env node
// postinstall entry for scripts/dev-app-icon.sh. pnpm runs lifecycle scripts
// through cmd.exe on Windows, which cannot execute a `.sh` - so the shell
// script is spawned from node, and only where it has anything to do: macOS,
// outside CI (a build runner never launches the dev bundle, and codesign under
// a locked login keychain could block on a prompt).
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin' || process.env.CI) process.exit(0);
const result = spawnSync('sh', ['scripts/dev-app-icon.sh'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
