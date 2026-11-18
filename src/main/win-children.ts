/**
 * Whether a Windows shell has a program running - `PtyHost.foregroundBusy`
 * there. node-pty's Windows `process` is the name the pty was spawned with,
 * forever (`powershell.exe` with Claude Code running in it), so the
 * foreground cannot be read off the pty: the OS is asked for the shell's
 * child processes instead.
 *
 * One PowerShell answers every question while there are questions (a cold
 * start costs ~0.5 s, a warm CIM query ~30 ms) and leaves after a quiet
 * spell; answers are cached for a moment, as a following view polls. A child
 * older than the shell is a stale parent id (Windows reuses pids), never a
 * child; ConPTY's own `conhost.exe` is not the user's program.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

/** How long an answer is reused. */
export const CHILDREN_CACHE_MS = 1000;
/** How long the PowerShell waits for the next question before it leaves. */
const IDLE_EXIT_MS = 30_000;
/** No answer this long = unknown (the PowerShell is restarted). */
export const ANSWER_TIMEOUT_MS = 5000;
/**
 * The first answer of a fresh PowerShell waits longer: a cold WMI service can
 * take seconds, and timing that out would restart it cold again, forever.
 */
export const FIRST_ANSWER_TIMEOUT_MS = 15_000;

/** Reads one pid per line, answers `<pid> <child pid>:<name> …` per line. */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = 0
  if (-not [int]::TryParse($line, [ref]$id)) { continue }
  $kids = @()
  $self = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -Property CreationDate
  if ($self) {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -Property ProcessId,Name,CreationDate |
      Where-Object { $_.CreationDate -ge $self.CreationDate } |
      ForEach-Object { '{0}:{1}' -f $_.ProcessId, $_.Name })
  }
  [Console]::Out.WriteLine((@("$id") + $kids) -join ' ')
  [Console]::Out.Flush()
}
`;

export type ChildProcessInfo = { pid: number; name: string };

/** One answer line: the asked pid and its children, or null for a line that is not one. */
export function parseChildrenLine(
  line: string,
): { pid: number; children: ChildProcessInfo[] } | null {
  const [head, ...rest] = line.trim().split(/\s+/);
  const pid = Number(head);
  if (!head || !Number.isSafeInteger(pid)) return null;
  const children: ChildProcessInfo[] = [];
  for (const item of rest) {
    const at = item.indexOf(':');
    const child = Number(item.slice(0, at));
    if (at > 0 && Number.isSafeInteger(child))
      children.push({ pid: child, name: item.slice(at + 1) });
  }
  return { pid, children };
}

/** Whether these children mean a program runs in the shell. */
export function runsProgram(children: ChildProcessInfo[]): boolean {
  return children.some((c) => c.name.toLowerCase() !== 'conhost.exe');
}

type Waiter = { pid: number; resolve: (children: ChildProcessInfo[] | null) => void };

/** Starts the answering PowerShell; a fake in tests. */
export type PowerShellSpawner = () => ChildProcessWithoutNullStreams;

function spawnPowerShell(): ChildProcessWithoutNullStreams {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return spawn(
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(SCRIPT, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
}

/** The PowerShell, started on the first question. */
export class WindowsChildren {
  private ps: ChildProcessWithoutNullStreams | null = null;
  private waiting: Waiter[] = [];
  private partial = '';
  /** The running PowerShell has answered once: it is warm. */
  private answered = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<
    number,
    { at: number; answer: Promise<ChildProcessInfo[] | null> }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly spawnPs: PowerShellSpawner = spawnPowerShell,
  ) {}

  /** The shell's children; null when the OS could not be asked. */
  children(pid: number): Promise<ChildProcessInfo[] | null> {
    const hit = this.cache.get(pid);
    if (hit && this.now() - hit.at < CHILDREN_CACHE_MS) return hit.answer;
    const answer = this.ask(pid);
    this.cache.set(pid, { at: this.now(), answer });
    // An unknown is not worth keeping.
    void answer.then((a) => {
      if (a === null && this.cache.get(pid)?.answer === answer) this.cache.delete(pid);
    });
    for (const [key, entry] of this.cache) {
      if (this.now() - entry.at > CHILDREN_CACHE_MS * 10) this.cache.delete(key);
    }
    return answer;
  }

  /** Whether a program runs in the shell; false when that cannot be told. */
  async busy(pid: number): Promise<boolean> {
    const children = await this.children(pid);
    return children !== null && runsProgram(children);
  }

  dispose(): void {
    this.stop();
  }

  private ask(pid: number): Promise<ChildProcessInfo[] | null> {
    const ps = this.start();
    if (!ps) return Promise.resolve(null);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_EXIT_MS);
    this.idle.unref?.();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          // A wedged PowerShell answers nothing again: start over (this
          // one - a later one is not the one that wedged).
          this.stop(ps);
        },
        this.answered ? ANSWER_TIMEOUT_MS : FIRST_ANSWER_TIMEOUT_MS,
      );
      timer.unref?.();
      this.waiting.push({
        pid,
        resolve: (children) => {
          clearTimeout(timer);
          resolve(children);
        },
      });
      ps.stdin.write(`${pid}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams | null {
    if (this.ps) return this.ps;
    let ps: ChildProcessWithoutNullStreams;
    try {
      ps = this.spawnPs();
    } catch {
      return null;
    }
    // Never what keeps a process (the daemon at its idle exit) alive.
    ps.unref();
    for (const stream of [ps.stdin, ps.stdout, ps.stderr]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    ps.on('error', () => this.stop(ps));
    ps.on('exit', () => this.stop(ps));
    ps.stdin.on('error', () => undefined);
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (data: string) => {
      // A stopped PowerShell's late output answers nothing.
      if (this.ps !== ps) return;
      this.partial += data;
      let nl: number;
      while ((nl = this.partial.indexOf('\n')) >= 0) {
        const line = this.partial.slice(0, nl);
        this.partial = this.partial.slice(nl + 1);
        const parsed = parseChildrenLine(line);
        if (!parsed) continue;
        // Answers come in question order; one for another pid is out of
        // step, and every later answer would be too: start over.
        const w = this.waiting.shift();
        if (!w) continue;
        if (w.pid !== parsed.pid) {
          w.resolve(null);
          this.stop(ps);
          return;
        }
        this.answered = true;
        w.resolve(parsed.children);
      }
    });
    this.ps = ps;
    return ps;
  }

  /** End the PowerShell (or note it ended): every open question is unknown. */
  private stop(which: ChildProcessWithoutNullStreams | null = this.ps): void {
    if (!which || which !== this.ps) return;
    this.ps = null;
    this.partial = '';
    this.answered = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      which.stdin.end();
      which.kill();
    } catch {
      // Already gone.
    }
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) w.resolve(null);
    this.cache.clear();
  }
}
