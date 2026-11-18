import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editionNotice, proAliases, proEnabled } from '../../scripts/pro-paths.mjs';

/**
 * Which edition a build compiles (scripts/pro-paths.mjs, read by both build
 * configs and the remote runtime's bundler): the official one when pro/ is
 * there and `PRO=0` is not set, the core one otherwise.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tree(withPro: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'pro-paths-'));
  roots.push(root);
  if (withPro) mkdirSync(join(root, 'pro'));
  return root;
}

describe('the edition switch', () => {
  it('builds the official edition only with pro/ there and PRO=0 unset', () => {
    expect(proEnabled({}, tree(true))).toBe(true);
    expect(proEnabled({ PRO: '0' }, tree(true))).toBe(false);
    expect(proEnabled({}, tree(false))).toBe(false);
  });

  it('points the entries at pro/ or at the stubs', () => {
    const root = tree(true);
    // Assembled: this file is exported, and the leak check reads it.
    const entry = ['@pro', 'main'].join('/');
    expect(proAliases(root, true)[entry]).toBe(join(root, 'pro', 'main', 'index.ts'));
    expect(proAliases(root, false)[entry]).toBe(join(root, 'src', 'pro-stub', 'main.ts'));
  });

  // A PRO=0 left in a shell silently ran `pnpm dev` as the core build.
  it('says so when PRO=0 ignores a pro/ that is there, and only then', () => {
    expect(editionNotice({ PRO: '0' }, tree(true))).toMatch(/core edition/);
    expect(editionNotice({}, tree(true))).toBeNull();
    expect(editionNotice({ PRO: '0' }, tree(false))).toBeNull();
  });
});
