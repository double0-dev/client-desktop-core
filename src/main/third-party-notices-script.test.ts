import { describe, expect, it } from 'vitest';
import {
  STANDARD_TEXT_FILE,
  buildNotices,
  canonicalApache,
  copyrightOf,
  licenseOf,
  noticeFilesIn,
  packageDirOf,
  type NoticesFs,
} from '../../scripts/third-party-notices.mjs';

/**
 * The open-source notices the build writes into every package
 * (scripts/third-party-notices.mjs, a private plan › E): MIT,
 * BSD, Apache and MPL ask a binary to carry each package's licence text, and
 * most of the app's packages exist only inside its bundles - so the list is
 * read off the modules the bundler rendered, and a package that ships no
 * licence file still gets its standard text.
 */

/** An in-memory package tree: `{ '/n/react': { 'package.json': '…', LICENSE: '…' } }`. */
function fakeFs(tree: Record<string, Record<string, string>>): NoticesFs {
  const split = (p: string): [string, string] => {
    const i = p.lastIndexOf('/');
    return [p.slice(0, i), p.slice(i + 1)];
  };
  return {
    readFile: (p) => {
      const [dir, name] = split(p);
      const text = tree[dir]?.[name];
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
    list: (d) => {
      if (!tree[d]) throw new Error(`ENOENT ${d}`);
      return Object.keys(tree[d]);
    },
    isFile: (p) => {
      const [dir, name] = split(p);
      return tree[dir]?.[name] !== undefined;
    },
  };
}

const pkg = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe('packageDirOf', () => {
  it('names the real package of a pnpm store path, scoped or not', () => {
    expect(packageDirOf('/r/node_modules/.pnpm/react@19.1.0/node_modules/react/cjs/react.js')).toBe(
      '/r/node_modules/.pnpm/react@19.1.0/node_modules/react',
    );
    expect(
      packageDirOf('/r/node_modules/.pnpm/@xterm+xterm@6/node_modules/@xterm/xterm/lib/xterm.mjs'),
    ).toBe('/r/node_modules/.pnpm/@xterm+xterm@6/node_modules/@xterm/xterm');
  });

  it('takes the innermost package of a nested node_modules and drops a query', () => {
    expect(packageDirOf('/r/node_modules/a/node_modules/b/index.js?worker')).toBe(
      '/r/node_modules/a/node_modules/b',
    );
  });

  it('reads Windows paths', () => {
    expect(packageDirOf('C:\\r\\node_modules\\zod\\index.js')).toBe('C:/r/node_modules/zod');
  });

  it('ignores the app’s own modules and virtual ones', () => {
    expect(packageDirOf('/r/src/renderer/src/main.tsx')).toBeNull();
    expect(packageDirOf('\0commonjsHelpers.js')).toBeNull();
    expect(packageDirOf('/r/node_modules/@scope')).toBeNull();
    expect(packageDirOf(null)).toBeNull();
  });
});

describe('noticeFilesIn', () => {
  it('finds licence, notice and third-party-notice files in their usual spellings', () => {
    const names = [
      'LICENSE',
      'LICENCE.md',
      'license-mit',
      'COPYING',
      'NOTICE.txt',
      'ThirdPartyNotices.txt',
      'package.json',
      'README.md',
      'licensed.js',
    ];
    expect(noticeFilesIn('/p', () => names)).toEqual([
      'COPYING',
      'LICENCE.md',
      'LICENSE',
      'license-mit',
      'NOTICE.txt',
      'ThirdPartyNotices.txt',
    ]);
  });

  it('answers nothing for a folder it cannot read', () => {
    expect(
      noticeFilesIn('/gone', () => {
        throw new Error('ENOENT');
      }),
    ).toEqual([]);
  });
});

describe('licenseOf', () => {
  it('reads the string, object and old array forms', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT');
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licenseOf({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0');
    expect(licenseOf({})).toBeNull();
  });
});

describe('copyrightOf', () => {
  it('names the author without email or url, else the package’s authors', () => {
    expect(
      copyrightOf({ name: 'x', author: 'Emma Wilson <emmaw@example.com> (https://example.com)' }),
    ).toEqual(['Copyright (c) Emma Wilson']);
    expect(copyrightOf({ name: 'x', author: { name: 'James Carter' } })).toEqual([
      'Copyright (c) James Carter',
    ]);
    expect(copyrightOf({ name: 'x' })).toEqual(['Copyright (c) the x authors']);
  });

  it('credits VS Code as well as CodinGame for the Monaco packages built from its source', () => {
    expect(
      copyrightOf({ name: '@codingame/monaco-vscode-api', author: { name: 'CodinGame' } }),
    ).toEqual([
      'Copyright (c) CodinGame',
      'Copyright (c) Microsoft Corporation (Visual Studio Code)',
    ]);
  });
});

describe('buildNotices', () => {
  it('lists each package once by name and version, sorted, with its licence texts', () => {
    const fs = fakeFs({
      '/n/zod': {
        'package.json': pkg({ name: 'zod', version: '4.0.0', license: 'MIT' }),
        LICENSE: 'MIT zod',
      },
      '/n/react': {
        'package.json': pkg({ name: 'react', version: '19.1.0', license: 'MIT' }),
        LICENSE: 'MIT react',
      },
      // The same package reached twice (bundled and in node_modules).
      '/store/react': {
        'package.json': pkg({ name: 'react', version: '19.1.0', license: 'MIT' }),
        LICENSE: 'MIT react',
      },
    });
    const doc = buildNotices(['/n/zod', '/n/react', '/store/react'], fs);
    expect(doc.version).toBe(1);
    expect(doc.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'react@19.1.0',
      'zod@4.0.0',
    ]);
    expect(doc.packages.map((p) => doc.texts[p.files[0].text])).toEqual(['MIT react', 'MIT zod']);
  });

  it('stores a text shared by several packages once', () => {
    const same = 'Apache License Version 2.0 …';
    const fs = fakeFs({
      '/n/a': { 'package.json': pkg({ name: 'a', version: '1.0.0' }), LICENSE: same },
      '/n/b': { 'package.json': pkg({ name: 'b', version: '1.0.0' }), LICENSE: same },
    });
    const doc = buildNotices(['/n/a', '/n/b'], fs);
    expect(doc.texts).toEqual([same]);
    expect(doc.packages.map((p) => p.files[0].text)).toEqual([0, 0]);
  });

  it('keeps two versions of one package as two entries', () => {
    const fs = fakeFs({
      '/n/a1': { 'package.json': pkg({ name: 'a', version: '1.0.0' }), LICENSE: 'one' },
      '/n/a2': { 'package.json': pkg({ name: 'a', version: '2.0.0' }), LICENSE: 'two' },
    });
    expect(buildNotices(['/n/a2', '/n/a1'], fs).packages.map((p) => p.version)).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
  });

  it('gives an MIT package that ships no licence file the standard text with its author', () => {
    // The @codingame/monaco-vscode-* packages, drizzle-orm and @xterm/headless
    // ship none; the licence still asks for its notice in the binary.
    const fs = fakeFs({
      '/n/bare': {
        'package.json': pkg({
          name: 'bare',
          version: '1.0.0',
          license: 'MIT',
          author: 'Emma Wilson',
        }),
      },
    });
    const [entry] = buildNotices(['/n/bare'], fs).packages;
    expect(entry.files.map((f) => f.name)).toEqual([STANDARD_TEXT_FILE]);
    const doc = buildNotices(['/n/bare'], fs);
    expect(doc.texts[0]).toMatch(
      /^MIT License\n\nCopyright \(c\) Emma Wilson\n\nPermission is hereby granted/,
    );
  });

  it('gives an Apache package with no file the full licence another package shipped', () => {
    const apache = 'Apache License\nVersion 2.0, January 2004\n…\nEND OF TERMS AND CONDITIONS\n';
    const fs = fakeFs({
      '/n/with': {
        'package.json': pkg({ name: 'with', version: '1.0.0', license: 'Apache-2.0' }),
        LICENSE: apache,
      },
      '/n/drizzle': {
        'package.json': pkg({
          name: 'drizzle',
          version: '1.0.0',
          license: 'Apache-2.0',
          author: 'Drizzle Team',
        }),
      },
    });
    const doc = buildNotices(['/n/with', '/n/drizzle'], fs);
    const drizzle = doc.packages.find((p) => p.name === 'drizzle');
    expect(drizzle?.files[0].name).toBe(STANDARD_TEXT_FILE);
    expect(doc.texts[drizzle?.files[0].text ?? -1]).toBe(`Copyright (c) Drizzle Team\n\n${apache}`);
  });

  it('leaves a package with no file and no writable licence text-less, for the guard to report', () => {
    const fs = fakeFs({
      '/n/odd': {
        'package.json': pkg({ name: 'odd', version: '1.0.0', license: 'SEE LICENSE IN x' }),
      },
    });
    expect(buildNotices(['/n/odd'], fs).packages[0].files).toEqual([]);
  });

  it('skips a folder with no readable package.json', () => {
    expect(buildNotices(['/n/none'], fakeFs({})).packages).toEqual([]);
  });
});

describe('canonicalApache', () => {
  it('picks the full Apache 2.0 text, never a short notice that names it', () => {
    const full = '   Apache License\n   Version 2.0, January 2004\n…\nEND OF TERMS AND CONDITIONS';
    expect(canonicalApache(['Licensed under the Apache License, Version 2.0', full])).toBe(full);
    expect(canonicalApache(['MIT'])).toBeNull();
  });
});
