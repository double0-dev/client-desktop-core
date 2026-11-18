/**
 * A remote terminal's dev-server URLs, as this machine reaches them
 * (a private plan › 13). Pure: a URL the host printed
 * (`http://localhost:5173/app`) names the HOST's loopback. Until the user
 * opens it (`forward:open`) it is announced as printed, marked `open: false`
 * - nothing listens here; once opened it is announced as the forward's local
 * origin (`http://127.0.0.1:<local>/app`). The chip names the host either way
 * (`build-box:5173`).
 */

/** What the renderer gets beside a remote terminal's server URL: where it really runs. */
export type ForwardedServer = {
  /** The URL announced: the host's as printed (not open), or the local forward's (open). */
  url: string;
  hostId: string;
  /** The port on the host. */
  port: number;
  /** `localhost:5173` as the host printed it. */
  remote: string;
  /** A local forward listens for it (the user opened it). */
  open: boolean;
  /**
   * Not open yet, but forwarded to this local port last time - a browser tab
   * restored onto `127.0.0.1:<remembered>` may re-open it (the user's prior
   * action, plan › M3 as built).
   */
  remembered: number | null;
};

/** The host port a server URL names (80 / 443 when it names none), or null. */
export function serverPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** Every distinct host port a terminal's URLs name, in order. */
export function serverPorts(urls: readonly string[]): number[] {
  const out: number[] = [];
  for (const url of urls) {
    const port = serverPort(url);
    if (port !== null && !out.includes(port)) out.push(port);
  }
  return out;
}

/** The URL with its origin moved to `127.0.0.1:<localPort>` (path, query and hash kept). */
export function localServerUrl(url: string, localPort: number): string | null {
  try {
    const u = new URL(url);
    u.hostname = '127.0.0.1';
    u.port = String(localPort);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/**
 * The servers a remote terminal announces, as the renderer gets them: an
 * opened one (a live forward) as its local URL, any other as the host
 * printed it with `open: false` - opening that goes through `forward:open`.
 */
export function forwardedServerList(
  urls: readonly string[],
  hostId: string,
  localPortOf: (port: number) => number | null,
  rememberedOf: (port: number) => number | null = () => null,
): { urls: string[]; forwarded: ForwardedServer[] } {
  const out: string[] = [];
  const forwarded: ForwardedServer[] = [];
  for (const url of urls) {
    const port = serverPort(url);
    if (port === null) continue;
    const local = localPortOf(port);
    const shown = local === null ? url : localServerUrl(url, local);
    if (!shown || out.includes(shown)) continue;
    let remote: string;
    try {
      remote = new URL(url).host;
    } catch {
      remote = `localhost:${port}`;
    }
    out.push(shown);
    forwarded.push({
      url: shown,
      hostId,
      port,
      remote,
      open: local !== null,
      remembered: local === null ? rememberedOf(port) : null,
    });
  }
  return { urls: out, forwarded };
}
