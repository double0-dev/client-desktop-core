# double0 desktop

A desktop workspace for coding agents and terminals: projects, sessions (each
in its own git worktree if you like), terminals that keep running across
restarts, a file explorer with git status, and an editor with language
servers and previews. Cross-platform (macOS, Windows, Linux).

This repository is the open core. The official build adds its own features on
top through a small set of extension points; none of that code lives here, and
the core builds, tests and runs on its own.

## Core and Pro

This is **double0 Core**: free and open source, built from this source by
you. **double0 Pro** is the official, signed app with everything Core has
and more, sold as a subscription - see [double0.dev/pricing](https://double0.dev/pricing/).

Pro's code is not in this repository, so this tracker is for Core only.
Questions about Pro, a plan or a charge go to
[hello@double0.dev](mailto:hello@double0.dev).

## Stack

- **Electron** + **electron-vite** (main / preload / renderer, HMR in dev)
- **React 19** + **TanStack Router** (file-based, hash history)
- **Tailwind v4** + **shadcn/ui** on Radix primitives
- **PGlite** (embedded Postgres) + **Drizzle** in main, TanStack DB
  collections in the renderer - local-first, a single local user
- **xterm.js** + **node-pty** for terminals, run by a session daemon so shells
  outlive the app window
- **Monaco** (the `@codingame/monaco-vscode-*` packages) with language
  servers over `vscode-languageclient`
- **Vitest** for tests

## Getting started

```bash
pnpm install          # also compiles the pty module against Electron
pnpm dev              # the app, with HMR
```

Node 22 and pnpm (the version in `package.json` › `packageManager`).

## Scripts

```bash
pnpm dev              # electron-vite dev
pnpm start            # electron-vite preview
pnpm typecheck:core   # routes:generate + tsc (node + web)
pnpm test:core        # vitest, both projects
pnpm lint             # eslint
pnpm format:check     # prettier --check on sources and scripts
pnpm quality:core     # typecheck + lint + format:check + test - the gate
pnpm build:core       # typecheck + test + production bundle to out/
pnpm package:core     # build:core, then an installable app in dist-core/ (package:core:dir: unpacked)
pnpm routes:generate  # tsr generate (router tree)
pnpm test:coverage    # v8 coverage report in coverage/
```

Packaging compiles the terminal's native pty module on your machine: on macOS
the Xcode command line tools, on Windows the Visual Studio Build Tools, on
Linux `build-essential` and Python. The package is unsigned - fine for an app
you build for yourself.

Use the `:core` scripts: they build without the Pro extension (`PRO=0`).
The plain scripts are the official build's; `pnpm dev` and `pnpm build` notice the missing `pro/` folder on their
own.

## Layout

```
src/
  main/        Electron main: windows, IPC handlers, git / fs / search,
               terminals and the session daemon (daemon/), PGlite (db/)
  preload/     the context bridge - window.api
  renderer/    the React app (src/routes - TanStack file routes; src/lib -
               logic by domain: git, session, settings, workspace, terminal,
               search, monaco)
  pro-stub/    the empty twins of the four Pro entry modules
resources/     runtime icons
build/         packaging icons
scripts/       build, boundary and export checks, agent CLI probes
```

`core-paths.txt` lists what this tree is made of. The app has four entry
modules (`src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/main.tsx`, `src/main/daemon/daemon-main.ts`) that each load
an extension (`@pro/*`); in this tree they resolve to the empty twins in
`src/pro-stub/`, and every surface that an extension could fill renders its
core fallback. No other file imports one - `src/main/pro-boundary.test.ts`
and the lint rules hold that line.

## Testing

Two Vitest projects (`vitest.config.ts`):

| project    | environment | matches                           |
| ---------- | ----------- | --------------------------------- |
| `main`     | node        | `src/{main,preload}/**/*.test.ts` |
| `renderer` | jsdom       | `src/renderer/**/*.test.{ts,tsx}` |

Tests sit next to what they cover (`foo.ts` → `foo.test.ts`), and a behavior
change brings its tests in the same commit: new pure logic gets a test file
beside it, a changed IPC handler extends its `src/main/<area>.test.ts`
(rejection paths included), and a new DB column or IPC channel fails the
parity suites below until both sides agree. Keep the pure part of a feature
out of the module that imports Electron, so it can be tested. Component tests build on `src/renderer/src/test-support.tsx`
(`stubApi()` for the preload bridge, `fakeFs()`, `withLayout()`); main's IPC
handlers are tested for real against throwaway repos and folders in
`tmpdir()`.

Suites worth knowing:

- `src/main/ipc-channels.test.ts` - both sides of the preload↔main wire
  agree on every channel name.
- `src/main/db/row-schemas.test.ts` - the zod row schemas match the Drizzle
  tables key for key.
- `src/main/pro-boundary.test.ts` - no core file imports Pro code outside the
  four composition roots.

On Node 25+, run the renderer tests with
`NODE_OPTIONS=--no-experimental-webstorage` (Node's own `localStorage`
shadows jsdom's).

## Environments

A build is **local** or **production** (`src/main/app-env.ts`): a packaged
app (`pnpm package:core`) is production, `pnpm dev:core` is local. A local
instance keeps its data in a separate folder (`double0-desktop-core-dev`),
shows a red icon and a DEV badge, and registers its own link scheme, so it
runs beside an installed copy without touching it.

## Contributing

This repository does not accept contributions for now - pull requests are
closed without review. That may change later.

## Security

Please report a vulnerability privately through GitHub's **Report a
vulnerability** button on this repository's Security tab, not in a public
issue.

## License

Apache License 2.0 - see [LICENSE](LICENSE).

The double0 name and logo are not part of that license (its section 6): a
build you distribute from this code needs a name and icon of its own.
