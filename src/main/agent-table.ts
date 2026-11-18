/**
 * The agent CLIs double0 knows by name: each one's binary, the vendor's own
 * installer and the folders it installs into, its login and status commands,
 * and the origins / callback ports its sign-in uses. Core: every shell gets
 * the install folders on its PATH (agent-bins.ts); signing a CLI in on a host
 * (a private plan) is the official build's and reads the
 * same table (a private plan › M7). Import-free: the host
 * daemon and the renderer load it too.
 */

export type SignInAgentId = 'claude' | 'codex' | 'opencode' | 'cursor-agent';
export type SignInAgent = {
  id: SignInAgentId;
  label: string;
  bin: string;
  /** The login, as typed (behind `AGENT_PATH`). */
  login: string;
  /**
   * The vendor's own installer (verified in a plain Ubuntu 22.04 with curl
   * only, 2026-11-01 - none needs Node). Run from the "Open a terminal…"
   * dialog's button, in that visible host terminal; never pinned - the CLIs
   * update themselves.
   */
  install: string;
  /**
   * Where that installer puts the binary, from the home folder. The host
   * daemon reads its PATH once at start, and OpenCode's installer adds its
   * folder in `.bashrc` only (a login shell that is not interactive never
   * sees it): `which` misses both, so detection also looks here.
   */
  homeBins: readonly string[];
  /** The status check's arguments (after `bin`), or null when the CLI has none. */
  status: readonly string[] | null;
  /**
   * The account the status check reads: the CLI's default config folder (the
   * check runs with the host's own env, so `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
   * set by a wrapper are another account it does not see).
   */
  account: string | null;
  /** The https origins a sign-in page of this CLI may be on. */
  origins: readonly string[];
  /** The `localhost` ports its browser login may come back to. */
  callbackPorts: readonly number[];
};

export const ANTHROPIC_ORIGINS = [
  'https://claude.com',
  'https://claude.ai',
  'https://platform.claude.com',
  'https://console.anthropic.com',
] as const;

export const SIGN_IN_AGENTS: readonly SignInAgent[] = [
  {
    // Read off 2.1.316: the URL (claude.com, redirect to platform.claude.com)
    // and a "Paste code here" prompt - no localhost callback.
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    login: 'claude auth login',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    homeBins: ['.local/bin/claude', '.claude/local/claude'],
    status: ['auth', 'status', '--json'],
    account: '~/.claude',
    origins: ANTHROPIC_ORIGINS,
    callbackPorts: [],
  },
  {
    // Read off 0.166.0 in a container: the page is on auth.openai.com, its
    // redirect_uri is http://127.0.0.1:1455/auth/callback, and the login
    // server listens on 127.0.0.1 only (a callback with a wrong state gets
    // 400 "State mismatch" and the login keeps waiting).
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    login: 'codex login',
    // The standalone installer (`~/.codex/packages`, linked from ~/.local/bin).
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    homeBins: ['.local/bin/codex'],
    status: ['login', 'status'],
    account: '~/.codex',
    origins: ['https://auth.openai.com'],
    callbackPorts: [1455],
  },
  {
    // `auth login` asks for the provider first; each provider's page is on
    // its own origin (read off 1.17.20: `auth list` counts the credentials).
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    login: 'opencode auth login',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    homeBins: ['.opencode/bin/opencode'],
    status: ['auth', 'list'],
    account: '~/.local/share/opencode',
    origins: [...ANTHROPIC_ORIGINS, 'https://github.com', 'https://auth.openai.com'],
    callbackPorts: [1455],
  },
  {
    // Its `status` starts a login of its own when signed out - no check.
    id: 'cursor-agent',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    login: 'NO_OPEN_BROWSER=1 cursor-agent login',
    install: 'curl https://cursor.com/install -fsS | bash',
    homeBins: ['.local/bin/cursor-agent'],
    status: null,
    account: null,
    origins: ['https://cursor.com'],
    callbackPorts: [],
  },
];
