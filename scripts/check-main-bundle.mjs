#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain ESM
   build script, no type annotations; typed for consumers in main-env.d.mts */
// Fail unless the built main bundle has the production URLs inlined
// (a private plan › Desktop changes 1).
//
//   node scripts/check-main-bundle.mjs                       # expects the host of $VITE_API_URL
//   node scripts/check-main-bundle.mjs --expect api.example.test [--bundle out/main/index.js]
//
// Exit 1 with one line per problem: a `process.env.VITE_*` read that survived
// bundling, or an expected string that is missing.
import { readFileSync } from 'node:fs';
import { checkMainBundle, expectedApiHost } from './main-env.mjs';

function args() {
  const out = { bundle: 'out/main/index.js', expect: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle' && argv[i + 1]) out.bundle = argv[++i];
    else if (argv[i] === '--expect' && argv[i + 1]) out.expect.push(argv[++i]);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

const { bundle, expect } = args();
if (expect.length === 0) {
  const host = expectedApiHost(process.env);
  if (host) expect.push(host);
}
let source;
try {
  source = readFileSync(bundle, 'utf8');
} catch {
  console.error(`✖ ${bundle} not found - build first`);
  process.exit(1);
}
const problems = checkMainBundle(source, { expect });
if (problems.length > 0) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.log(`✔ ${bundle}: URLs inlined${expect.length ? ` (${expect.join(', ')})` : ''}`);
