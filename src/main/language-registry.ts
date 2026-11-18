/**
 * The language-server registry: which languages the editor can get smarter
 * about, and how each server is obtained. Pure data + lookups (no electron
 * imports) so it unit-tests cleanly.
 *
 * npm entries are pinned to EXACT versions with npm-lockfile integrity hashes,
 * including the full transitive prod-dependency tree (`lockedDeps`, flat -
 * verified conflict-free at curation time). The installer downloads those
 * tarballs straight from registry.npmjs.org and lays deps out in a flat
 * node_modules; no npm and no user Node needed (servers run under
 * ELECTRON_RUN_AS_NODE). To bump a server: `npm install --package-lock-only
 * <pkg>@<ver>` in a scratch dir and regenerate the lists from the lockfile
 * (skip dev/optional entries).
 */

export type LockedDep = { name: string; version: string; integrity: string };

export type ServerSpec =
  /** Ships with Monaco (worker-based) - nothing to install. */
  | { installType: 'builtin' }
  /** Installable from the npm registry; also honored if found on PATH. */
  | {
      installType: 'npm';
      package: string;
      version: string;
      integrity: string;
      /** Key in the package's bin map naming the server entry script. */
      entryBin: string;
      args: string[];
      approxMb: number;
      lockedDeps: LockedDep[];
    }
  /** No installable distribution (needs a toolchain) - PATH or nothing. */
  | {
      installType: 'detect-only';
      bin: string;
      args: string[];
      installHint: string;
      /** The hint for a Linux machine (a remote host), when it differs. */
      linuxInstallHint?: string;
    };

/** An npm server's spec. */
export type NpmServerSpec = Extract<ServerSpec, { installType: 'npm' }>;

export type LanguageEntry = {
  /** Monaco/VS Code language id - also the registry key. */
  id: string;
  name: string;
  extensions: string[];
  server: ServerSpec;
};

export const LANGUAGE_REGISTRY: LanguageEntry[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    server: { installType: 'builtin' },
  },
  { id: 'json', name: 'JSON', extensions: ['json', 'jsonc'], server: { installType: 'builtin' } },
  {
    id: 'css',
    name: 'CSS / SCSS / Less',
    extensions: ['css', 'scss', 'less'],
    server: { installType: 'builtin' },
  },
  { id: 'html', name: 'HTML', extensions: ['html', 'htm'], server: { installType: 'builtin' } },
  {
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyi'],
    server: {
      installType: 'npm',
      package: 'pyright',
      version: '1.1.411',
      integrity:
        'sha512-03S/vmS5lF1S/tVbKc2WNXCMq8JWCwta/qIYjj1jvqbQhoy+N3NgBzHTSmUlbYD6DJwqQ5XHf108QujoqeURvw==',
      entryBin: 'pyright-langserver',
      args: ['--stdio'],
      approxMb: 19,
      lockedDeps: [],
    },
  },
  {
    id: 'yaml',
    name: 'YAML',
    extensions: ['yaml', 'yml'],
    server: {
      installType: 'npm',
      package: 'yaml-language-server',
      version: '1.24.0',
      integrity:
        'sha512-+HGcwu4M7IC+UDhDZScTZR8qsl2MMj/X1E5e83QcWzWn2pctj0fv8HHdrHHcbc1KB3CuRPJ4gc1Nm36D0iCu0g==',
      entryBin: 'yaml-language-server',
      args: ['--stdio'],
      approxMb: 6,
      lockedDeps: [
        {
          name: '@vscode/l10n',
          version: '0.0.18',
          integrity:
            'sha512-KYSIHVmslkaCDyw013pphY+d7x1qV8IZupYfeIfzNA+nsaWHbn5uPuQRvdRFsa9zFzGeudPuoGoZ1Op4jrJXIQ==',
        },
        {
          name: 'ajv',
          version: '8.20.0',
          integrity:
            'sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==',
        },
        {
          name: 'ajv-draft-04',
          version: '1.0.0',
          integrity:
            'sha512-mv00Te6nmYbRp5DCwclxtt7yV/joXJPGS7nM+97GdxvuttCOfgI3K4U25zboyeX0O+myI8ERluxQe5wljMmVIw==',
        },
        {
          name: 'ajv-i18n',
          version: '4.2.0',
          integrity:
            'sha512-v/ei2UkCEeuKNXh8RToiFsUclmU+G57LO1Oo22OagNMENIw+Yb8eMwvHu7Vn9fmkjJyv6XclhJ8TbuigSglPkg==',
        },
        {
          name: 'fast-deep-equal',
          version: '3.1.3',
          integrity:
            'sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==',
        },
        {
          name: 'fast-uri',
          version: '3.1.5',
          integrity:
            'sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==',
        },
        {
          name: 'json-schema-traverse',
          version: '1.0.0',
          integrity:
            'sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==',
        },
        {
          name: 'jsonc-parser',
          version: '3.3.1',
          integrity:
            'sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ==',
        },
        {
          name: 'picomatch',
          version: '4.0.5',
          integrity:
            'sha512-RvwwcruNjI1ncT5xRakeyS9Lf8lcItv34KD+aif+VH9kduAyfYBipGh12274xtenIPZ119/R9BdTBa8gAwSh0A==',
        },
        {
          name: 'prettier',
          version: '3.9.6',
          integrity:
            'sha512-OpN0zzVdiaiAhxpuuj5efpIS4sY9j7bY6uR5mnj5yPzGkdkjNKSJeUThPb60Jw29QuAZgA4o+/iB49kFiaBX6g==',
        },
        {
          name: 'request-light',
          version: '0.5.8',
          integrity:
            'sha512-3Zjgh+8b5fhRJBQZoy+zbVKpAQGLyka0MPgW3zruTF4dFFJ8Fqcfu9YsAvi/rvdcaTeWG3MkbZv4WKxAn/84Lg==',
        },
        {
          name: 'require-from-string',
          version: '2.0.2',
          integrity:
            'sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==',
        },
        {
          name: 'vscode-jsonrpc',
          version: '8.2.0',
          integrity:
            'sha512-C+r0eKJUIfiDIfwJhria30+TYWPtuHJXHtI7J0YlOmKAo7ogxP20T0zxB7HZQIFhIyvoBPwWskjxrvAtfjyZfA==',
        },
        {
          name: 'vscode-languageserver',
          version: '9.0.1',
          integrity:
            'sha512-woByF3PDpkHFUreUa7Hos7+pUWdeWMXRd26+ZX2A8cFx6v/JPTtd4/uN0/jB6XQHYaOlHbio03NTHCqrgG5n7g==',
        },
        {
          name: 'vscode-languageserver-protocol',
          version: '3.17.5',
          integrity:
            'sha512-mb1bvRJN8SVznADSGWM9u/b07H7Ecg0I3OgXDuLdn307rl/J3A9YD6/eYOssqhecL27hK1IPZAsaqh00i/Jljg==',
        },
        {
          name: 'vscode-languageserver-textdocument',
          version: '1.0.12',
          integrity:
            'sha512-cxWNPesCnQCcMPeenjKKsOCKQZ/L6Tv19DTRIGuLWe32lyzWhihGVJ/rcckZXJxfdKCFvRLS3fpBIsV/ZGX4zA==',
        },
        {
          name: 'vscode-languageserver-types',
          version: '3.17.5',
          integrity:
            'sha512-Ld1VelNuX9pdF39h2Hgaeb5hEZM2Z3jUrrMgWQAu82jMtZp7p3vJT3BzToKtZI7NgQssZje5o0zryOrhQvzQAg==',
        },
        {
          name: 'vscode-uri',
          version: '3.1.0',
          integrity:
            'sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==',
        },
        {
          name: 'yaml',
          version: '2.8.3',
          integrity:
            'sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==',
        },
      ],
    },
  },
  {
    id: 'shellscript',
    name: 'Shell',
    extensions: ['sh', 'bash', 'zsh'],
    server: {
      installType: 'npm',
      package: 'bash-language-server',
      version: '5.6.0',
      integrity:
        'sha512-DCuV+/BZAAozsp5blvi6jDnU/ZDaTpJpWM0zqwGjnirfqv7iBsMK32xOze/jipxU0PUZ6CBUKgRUMKI7Kk70Lg==',
      entryBin: 'bash-language-server',
      args: ['start'],
      approxMb: 8,
      lockedDeps: [
        {
          name: '@mixmark-io/domino',
          version: '2.2.0',
          integrity:
            'sha512-Y28PR25bHXUg88kCV7nivXrP2Nj2RueZ3/l/jdx6J9f8J4nsEGcgX0Qe6lt7Pa+J79+kPiJU3LguR6O/6zrLOw==',
        },
        {
          name: '@nodelib/fs.scandir',
          version: '2.1.5',
          integrity:
            'sha512-vq24Bq3ym5HEQm2NKCr3yXDwjc7vTsEThRDnkp2DK9p1uqLR+DHurm/NOTo0KG7HYHU7eppKZj3MyqYuMBf62g==',
        },
        {
          name: '@nodelib/fs.stat',
          version: '2.0.5',
          integrity:
            'sha512-RkhPPp2zrqDAQA/2jNhnztcPAlv64XdhIp7a7454A5ovI7Bukxgt7MX7udwAu3zg1DcpPU0rz3VV1SeaqvY4+A==',
        },
        {
          name: '@nodelib/fs.walk',
          version: '1.2.8',
          integrity:
            'sha512-oGB+UxlgWcgQkgwo8GcEGwemoTFt3FIO9ababBmaGwXIoBKZ+GTy0pP185beGg7Llih/NSHSV2XAs1lnznocSg==',
        },
        {
          name: '@one-ini/wasm',
          version: '0.2.0',
          integrity:
            'sha512-n+L/BvrwKUn7q5O3wHGo+CJZAqfewh38+37sk+eBzv/39lM9pPgPRd4sOZRvSRzo0ukLxzyXso4WlGj2oKZ5hA==',
        },
        {
          name: 'balanced-match',
          version: '1.0.2',
          integrity:
            'sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==',
        },
        {
          name: 'brace-expansion',
          version: '2.1.4',
          integrity:
            'sha512-hGfVzPxthbf3+2yjg/RBs60cB0FhqBS/zvdV/4wn4/BmN0bNMMHPc4V/BbFieqf1TKAGGAHnY4eSjajCl0f2Xg==',
        },
        {
          name: 'braces',
          version: '3.0.3',
          integrity:
            'sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==',
        },
        {
          name: 'commander',
          version: '13.1.0',
          integrity:
            'sha512-/rFeCpNJQbhSZjGVwO9RFV3xPqbnERS8MmIQzCtD/zl6gpJuV/bMLuN92oG3F7d8oDEHHRrujSXNUr8fpjntKw==',
        },
        {
          name: 'editorconfig',
          version: '2.0.1',
          integrity:
            'sha512-jMVc7LbF/M13cSpBiVWGut+qhIyOddIhSXPAntMSboEigGFGaQmBow9ZrVog0VT2K89qm0cyGHa7FRhcOqP8hA==',
        },
        {
          name: 'fast-glob',
          version: '3.3.3',
          integrity:
            'sha512-7MptL8U0cqcFdzIzwOTHoilX9x5BrNqye7Z/LuC7kCMRio1EMSyqRK3BEAUD7sXRq4iT4AzTVuZdhgQ2TCvYLg==',
        },
        {
          name: 'fastq',
          version: '1.20.1',
          integrity:
            'sha512-GGToxJ/w1x32s/D2EKND7kTil4n8OVk/9mycTc4VDza13lOvpUZTGX3mFSCtV9ksdGBVzvsyAVLM6mHFThxXxw==',
        },
        {
          name: 'fill-range',
          version: '7.1.1',
          integrity:
            'sha512-YsGpe3WHLK8ZYi4tWDg2Jy3ebRz2rXowDxnld4bkQB00cc/1Zw9AWnC0i9ztDJitivtQvaI9KaLyKrc+hBW0yg==',
        },
        {
          name: 'fuzzy-search',
          version: '3.2.1',
          integrity:
            'sha512-vAcPiyomt1ioKAsAL2uxSABHJ4Ju/e4UeDM+g1OlR0vV4YhLGMNsdLNvZTpEDY4JCSt0E4hASCNM5t2ETtsbyg==',
        },
        {
          name: 'glob-parent',
          version: '5.1.2',
          integrity:
            'sha512-AOIgSQCepiJYwP3ARnGx+5VnTu2HBYdzbGP45eLw1vr3zB3vZLeyed1sC9hnbcOc9/SrMyM5RPQrkGz4aS9Zow==',
        },
        {
          name: 'is-extglob',
          version: '2.1.1',
          integrity:
            'sha512-SbKbANkN603Vi4jEZv49LeVJMn4yGwsbzZworEoyEiutsN3nJYdbO36zfhGJ6QEDpOZIFkDtnq5JRxmvl3jsoQ==',
        },
        {
          name: 'is-glob',
          version: '4.0.3',
          integrity:
            'sha512-xelSayHH36ZgE7ZWhli7pW34hNbNl8Ojv5KVmkJD4hBdD3th8Tfk9vYasLM+mXWOZhFkgZfxhLSnrwRr4elSSg==',
        },
        {
          name: 'is-number',
          version: '7.0.0',
          integrity:
            'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
        },
        {
          name: 'merge2',
          version: '1.4.1',
          integrity:
            'sha512-8q7VEgMJW4J8tcfVPy8g09NcQwZdbwFEqhe/WZkoIzjn/3TGDwtOCYtXGxA3O8tPzpczCCDgv+P2P5y00ZJOOg==',
        },
        {
          name: 'micromatch',
          version: '4.0.8',
          integrity:
            'sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==',
        },
        {
          name: 'minimatch',
          version: '10.0.1',
          integrity:
            'sha512-ethXTt3SGGR+95gudmqJ1eNhRO7eGEGIgYA9vnPatK4/etz2MEVDno5GMCibdMTuBMyElzIlgxMna3K94XDIDQ==',
        },
        {
          name: 'node-fetch',
          version: '2.7.0',
          integrity:
            'sha512-c4FRfUm/dbcWZ7U+1Wq0AwCyFL+3nt2bEw05wfxSz+DWpWsitgmSgYmy2dQdWyKC1694ELPqMs/YzUSNozLt8A==',
        },
        {
          name: 'picomatch',
          version: '2.3.2',
          integrity:
            'sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==',
        },
        {
          name: 'queue-microtask',
          version: '1.2.3',
          integrity:
            'sha512-NuaNSa6flKT5JaSYQzJok04JzTL1CA6aGhv5rfLW3PgqA+M2ChpZQnAC8h8i4ZFkBS8X5RqkDBHA7r4hej3K9A==',
        },
        {
          name: 'reusify',
          version: '1.1.0',
          integrity:
            'sha512-g6QUff04oZpHs0eG5p83rFLhHeV00ug/Yf9nZM6fLeUrPguBTkTQOdpAWWspMh55TZfVQDPaN3NQJfbVRAxdIw==',
        },
        {
          name: 'run-parallel',
          version: '1.2.0',
          integrity:
            'sha512-5l4VyZR86LZ/lDxZTR6jqL8AFE2S0IFLMP26AbjsLVADxHdhB/c0GUsH+y39UfCi3dzz8OlQuPmnaJOMoDHQBA==',
        },
        {
          name: 'semver',
          version: '7.8.5',
          integrity:
            'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==',
        },
        {
          name: 'to-regex-range',
          version: '5.0.1',
          integrity:
            'sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==',
        },
        {
          name: 'tr46',
          version: '0.0.3',
          integrity:
            'sha512-N3WMsuqV66lT30CrXNbEjx4GEwlow3v6rr4mCcv6prnfwhS01rkgyFdjPNBYd9br7LpXV1+Emh01fHnq2Gdgrw==',
        },
        {
          name: 'turndown',
          version: '7.2.0',
          integrity:
            'sha512-eCZGBN4nNNqM9Owkv9HAtWRYfLA4h909E/WGAWWBpmB275ehNhZyk87/Tpvjbp0jjNl9XwCsbe6bm6CqFsgD+A==',
        },
        {
          name: 'vscode-jsonrpc',
          version: '8.0.2',
          integrity:
            'sha512-RY7HwI/ydoC1Wwg4gJ3y6LpU9FJRZAUnTYMXthqhFXXu77ErDd/xkREpGuk4MyYkk4a+XDWAMqe0S3KkelYQEQ==',
        },
        {
          name: 'vscode-languageserver',
          version: '8.0.2',
          integrity:
            'sha512-bpEt2ggPxKzsAOZlXmCJ50bV7VrxwCS5BI4+egUmure/oI/t4OlFzi/YNtVvY24A2UDOZAgwFGgnZPwqSJubkA==',
        },
        {
          name: 'vscode-languageserver-protocol',
          version: '3.17.2',
          integrity:
            'sha512-8kYisQ3z/SQ2kyjlNeQxbkkTNmVFoQCqkmGrzLH6A9ecPlgTbp3wDTnUNqaUxYr4vlAcloxx8zwy7G5WdguYNg==',
        },
        {
          name: 'vscode-languageserver-textdocument',
          version: '1.0.12',
          integrity:
            'sha512-cxWNPesCnQCcMPeenjKKsOCKQZ/L6Tv19DTRIGuLWe32lyzWhihGVJ/rcckZXJxfdKCFvRLS3fpBIsV/ZGX4zA==',
        },
        {
          name: 'vscode-languageserver-types',
          version: '3.17.2',
          integrity:
            'sha512-zHhCWatviizPIq9B7Vh9uvrH6x3sK8itC84HkamnBWoDFJtzBf7SWlpLCZUit72b3os45h6RWQNC9xHRDF8dRA==',
        },
        {
          name: 'web-tree-sitter',
          version: '0.24.5',
          integrity:
            'sha512-+J/2VSHN8J47gQUAvF8KDadrfz6uFYVjxoxbKWDoXVsH2u7yLdarCnIURnrMA6uSRkgX3SdmqM5BOoQjPdSh5w==',
        },
        {
          name: 'webidl-conversions',
          version: '3.0.1',
          integrity:
            'sha512-2JAn3z8AR6rjK8Sm8orRC0h/bcl/DqL7tRPdGZ4I1CjdF+EaMLmYxBHyXuKL849eucPFhvBoxMsflfOb8kxaeQ==',
        },
        {
          name: 'whatwg-url',
          version: '5.0.0',
          integrity:
            'sha512-saE57nupxk6v3HY35+jzBwYa0rKSy0XR8JSxZPwgLr7ys0IBzhGviA1/TUGJLmSVqs8pb9AnvICXEuOHLprYTw==',
        },
        {
          name: 'zod',
          version: '3.24.2',
          integrity:
            'sha512-lY7CDW43ECgW9u1TcT3IoXHflywfVqDYze4waEz812jR/bZ8FHDsl7pFQoSZTz5N+2NqRXs8GBwnAwo3ZNxqhQ==',
        },
      ],
    },
  },
  {
    id: 'php',
    name: 'PHP',
    extensions: ['php', 'phtml'],
    server: {
      // Intelephense ships as one webpack bundle that requires only Node
      // built-ins: its package.json dependencies are inlined, so nothing is
      // locked here. Its premium features need a licence key; the free tier
      // (completion, hover, diagnostics, go-to-definition) needs none.
      // Telemetry is off by default (`intelephense.telemetry.enabled`).
      installType: 'npm',
      package: 'intelephense',
      version: '1.18.5',
      integrity:
        'sha512-dqCH1YNCRlHGBLND+iUFjBJlGwM4pPimX2jm8AaP/6K2WZNM2K2+E8dOWCD3ZYMP2zC2ICBD9Soe2oxKtU9d9A==',
      entryBin: 'intelephense',
      args: ['--stdio'],
      approxMb: 26,
      lockedDeps: [],
    },
  },
  {
    id: 'go',
    name: 'Go',
    extensions: ['go'],
    server: {
      installType: 'detect-only',
      bin: 'gopls',
      args: [],
      installHint: 'go install golang.org/x/tools/gopls@latest',
    },
  },
  {
    id: 'rust',
    name: 'Rust',
    extensions: ['rs'],
    server: {
      installType: 'detect-only',
      bin: 'rust-analyzer',
      args: [],
      installHint: 'rustup component add rust-analyzer',
    },
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    extensions: ['kt', 'kts'],
    server: {
      installType: 'detect-only',
      bin: 'kotlin-language-server',
      args: [],
      installHint: 'brew install kotlin-language-server',
      linuxInstallHint: 'install kotlin-language-server from its GitHub releases (needs a JDK)',
    },
  },
  {
    id: 'java',
    name: 'Java',
    extensions: ['java'],
    server: {
      installType: 'detect-only',
      bin: 'jdtls',
      args: [],
      installHint: 'brew install jdtls (needs a JDK)',
      linuxInstallHint: 'install jdtls from the Eclipse downloads (needs a JDK)',
    },
  },
  {
    id: 'swift',
    name: 'Swift',
    extensions: ['swift'],
    server: {
      installType: 'detect-only',
      bin: 'sourcekit-lsp',
      args: [],
      installHint: 'ships with Xcode / xcode-select --install',
      linuxInstallHint: 'ships with the Swift toolchain (swift.org/install)',
    },
  },
  {
    id: 'dart',
    name: 'Dart / Flutter',
    extensions: ['dart'],
    server: {
      installType: 'detect-only',
      // The analysis server ships inside the Dart SDK (Flutter bundles it).
      bin: 'dart',
      args: ['language-server', '--protocol=lsp'],
      installHint: 'install the Dart SDK or Flutter (brew install dart)',
      linuxInstallHint: 'install the Dart SDK or Flutter (dart.dev/get-dart)',
    },
  },
  {
    id: 'cpp',
    name: 'C / C++',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'],
    server: {
      installType: 'detect-only',
      bin: 'clangd',
      args: [],
      installHint: 'xcode-select --install or brew install llvm',
      linuxInstallHint: "sudo apt install clangd (or your distribution's clangd package)",
    },
  },
];

export function registryEntry(languageId: string): LanguageEntry | undefined {
  return LANGUAGE_REGISTRY.find((e) => e.id === languageId);
}

export function registryEntryForExtension(ext: string): LanguageEntry | undefined {
  const lower = ext.toLowerCase();
  return LANGUAGE_REGISTRY.find((e) => e.extensions.includes(lower));
}

/** Where npm serves a package's tarball (a scoped name keeps its scope in the path). */
export function tarballUrl(name: string, version: string): string {
  const basename = name.includes('/') ? name.split('/')[1] : name;
  return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}

export type NpmTarball = {
  name: string;
  version: string;
  url: string;
  integrity: string;
  /** A locked dependency (lands in `node_modules/<name>`), not the server package itself. */
  dep: boolean;
};

/** Every tarball an npm server's install needs: the package first, then its locked deps. */
export function npmTarballs(spec: NpmServerSpec): NpmTarball[] {
  return [
    {
      name: spec.package,
      version: spec.version,
      url: tarballUrl(spec.package, spec.version),
      integrity: spec.integrity,
      dep: false,
    },
    ...spec.lockedDeps.map((d) => ({
      name: d.name,
      version: d.version,
      url: tarballUrl(d.name, d.version),
      integrity: d.integrity,
      dep: true,
    })),
  ];
}

/**
 * The installed versions to try, best first: the registry's pinned version
 * when present, else newest first (an install that predates an app update).
 * `.partial` staging folders are never a version.
 */
export function orderInstalledVersions(versions: string[], pinned: string): string[] {
  const complete = versions.filter((v) => !v.endsWith('.partial'));
  return complete.includes(pinned)
    ? [pinned, ...complete.filter((v) => v !== pinned)]
    : [...complete].sort().reverse();
}

/** The install hint for a machine of `platform` (a remote host's), null for none. */
export function installHintFor(spec: ServerSpec, platform: string | null): string | null {
  if (spec.installType !== 'detect-only') return null;
  if (platform === 'linux' && spec.linuxInstallHint) return spec.linuxInstallHint;
  return spec.installHint;
}

/**
 * The program a server runs as when found on a machine's PATH: an npm
 * server's bin name, a detect-only server's tool; null for a built-in.
 */
export function pathBinOf(spec: ServerSpec): string | null {
  if (spec.installType === 'npm') return spec.entryBin;
  if (spec.installType === 'detect-only') return spec.bin;
  return null;
}
