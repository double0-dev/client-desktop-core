import { describe, expect, it } from 'vitest';

import {
  LANGUAGE_REGISTRY,
  installHintFor,
  npmTarballs,
  orderInstalledVersions,
  pathBinOf,
  registryEntryForExtension,
  tarballUrl,
  type NpmServerSpec,
} from './language-registry';

describe('language registry', () => {
  it('maps every extension to exactly one language', () => {
    const seen = new Map<string, string>();
    for (const entry of LANGUAGE_REGISTRY) {
      for (const ext of entry.extensions) {
        expect(seen.get(ext), `.${ext} claimed twice`).toBeUndefined();
        seen.set(ext, entry.id);
      }
    }
  });

  it('launches the Dart analysis server from the SDK on PATH', () => {
    // `dart` alone starts the CLI's usage screen, not a server - the
    // subcommand and the LSP protocol flag are what make it speak LSP.
    expect(registryEntryForExtension('dart')?.server).toEqual({
      installType: 'detect-only',
      bin: 'dart',
      args: ['language-server', '--protocol=lsp'],
      installHint: expect.any(String),
      linuxInstallHint: expect.any(String),
    });
  });

  it('installs Intelephense for PHP as a single bundle speaking LSP over stdio', () => {
    // Intelephense's npm dependencies are inlined into lib/intelephense.js, so
    // no locked deps; without `--stdio` it exits on "Connection input stream
    // is not set" instead of serving.
    for (const ext of ['php', 'phtml']) {
      expect(registryEntryForExtension(ext)?.id).toBe('php');
    }
    const spec = registryEntryForExtension('php')!.server as NpmServerSpec;
    expect(spec).toMatchObject({
      installType: 'npm',
      package: 'intelephense',
      entryBin: 'intelephense',
      args: ['--stdio'],
      lockedDeps: [],
    });
    expect(pathBinOf(spec)).toBe('intelephense');
  });
});

describe('npm tarballs and installs', () => {
  it('lists the package first, then every locked dep, at registry URLs', () => {
    const spec = LANGUAGE_REGISTRY.find((e) => e.id === 'yaml')!.server as NpmServerSpec;
    const list = npmTarballs(spec);
    expect(list).toHaveLength(1 + spec.lockedDeps.length);
    expect(list[0]).toMatchObject({ name: 'yaml-language-server', dep: false });
    expect(list[0].url).toBe(
      `https://registry.npmjs.org/yaml-language-server/-/yaml-language-server-${spec.version}.tgz`,
    );
    // A scoped package keeps its scope in the path, not in the file name.
    expect(tarballUrl('@vscode/l10n', '0.0.18')).toBe(
      'https://registry.npmjs.org/@vscode/l10n/-/l10n-0.0.18.tgz',
    );
    expect(list.slice(1).every((t) => t.dep)).toBe(true);
  });

  it('tries the pinned version first, else the newest, never a staging folder', () => {
    expect(orderInstalledVersions(['1.0.0', '1.2.0', '1.1.0'], '1.1.0')).toEqual([
      '1.1.0',
      '1.0.0',
      '1.2.0',
    ]);
    expect(orderInstalledVersions(['1.0.0', '1.2.0', '1.3.0.partial'], '1.3.0')).toEqual([
      '1.2.0',
      '1.0.0',
    ]);
  });

  it('names a Linux install for a host on Linux, the default elsewhere', () => {
    const clangd = registryEntryForExtension('cpp')!.server;
    expect(installHintFor(clangd, 'linux')).toMatch(/apt/);
    expect(installHintFor(clangd, 'darwin')).toMatch(/xcode-select/);
    expect(installHintFor(clangd, null)).toMatch(/xcode-select/);
    // gopls installs the same way everywhere: no Linux variant, the hint stands.
    expect(installHintFor(registryEntryForExtension('go')!.server, 'linux')).toMatch(/go install/);
    expect(pathBinOf(registryEntryForExtension('py')!.server)).toBe('pyright-langserver');
  });
});
