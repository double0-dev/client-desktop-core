#!/usr/bin/env python3
"""
Probe which Codex CLI hook events fire for a scripted interaction, exactly as
the app would see them - the Codex twin of probe-claude-hooks.py, for writing
the Codex entry of AGENT_ADAPTERS (src/main/terminal.ts) against the real
binary rather than its docs.

It spawns `codex` under a pty with hooks injected as `-c` config overrides
(`hooks.<Event>=[{hooks=[{type="command",command="…"}]}]`, parsed as TOML -
the shape the app's `codex` shim injects, src/main/codex-status-hooks.ts),
logs every hook event with its JSON stdin to hooks.log, then sends one tiny
prompt and waits for the Stop hook. Findings so far (codex-cli 0.160.0,
2026-10-03): `hooks` is a stable, enabled feature; every override shape
parses under `--strict-config`, also ahead of `resume`; the events are
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, Stop, Interrupt, SubagentStart/Stop, PreCompact/PostCompact;
hook sources MERGE (a `-c` override adds to, never replaces, config.toml
hooks). Without a login the TUI shows only the sign-in screen and NO hook
fires - run `codex login` first. Hooks are TRUST-gated: a non-managed hook
(`-c` ones count as the "Session flags" source) runs only once the user has
trusted its hash in the TUI's `/hooks` (saved as `hooks.state` in
config.toml), so expect the first logged-in run to list them as needing
review; `--dangerously-bypass-hook-trust` (an extra argument here) skips
that for one invocation - the app never passes it. Still to verify against a
logged-in CLI: the event stdin shapes, whether a lifecycle matcher
(`startup`) is matched exactly or as a regex, and what `/new` fires.

    python3 scripts/probe-codex-hooks.py [workdir]          # codex on PATH
    CODEX=/path/to/codex python3 scripts/probe-codex-hooks.py
    python3 scripts/probe-codex-hooks.py . --dangerously-bypass-hook-trust

Costs one small model call once logged in. Ends the CLI with SIGTERM - never
SIGKILL (a hard kill leaves its session state dirty).
"""
import json, os, pty, re, select, signal, struct, sys, termios, fcntl, time

WORK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TMPDIR', '/tmp'), 'double0-codex-probe'))
os.makedirs(WORK, exist_ok=True)
CODEX = os.environ.get('CODEX', 'codex')
HOOK = os.path.join(WORK, 'hook.sh')
LOG = os.path.join(WORK, 'hooks.log')
EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt']
EXTRA = sys.argv[2:]  # e.g. --dangerously-bypass-hook-trust

with open(HOOK, 'w') as f:
    f.write('#!/bin/sh\nexec 2>/dev/null\n'
            "ts=$(perl -MTime::HiRes=time -e 'printf \"%.3f\", time')\n"
            'printf \'%s %s %s\\n\' "$ts" "$1" "$(cat | tr -d \'\\n\' | cut -c1-2000)" >> "$PROBE_DIR/hooks.log"\nexit 0\n')
os.chmod(HOOK, 0o755)
try: os.remove(LOG)
except FileNotFoundError: pass

def override(event):
    matcher = 'matcher=".*",' if event in ('PreToolUse', 'PostToolUse', 'PermissionRequest') else ''
    return f'hooks.{event}=[{{{matcher}hooks=[{{type="command",command="{HOOK} {event}"}}]}}]'

args = [CODEX] + EXTRA
for e in EVENTS:
    args += ['-c', override(e)]
env = dict(os.environ, PROBE_DIR=WORK, TERM='xterm-256color')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe(CODEX, args, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
screen = b''

def pump(secs):
    global screen
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r: continue
        try: b = os.read(fd, 65536)
        except OSError: return
        if not b: return
        screen += b

def hooklines():
    return open(LOG).read().splitlines() if os.path.exists(LOG) else []

pump(10)
os.write(fd, b'Create a file named hello.txt containing the word hello, then run `ls -la`, then reply with the single word done.')
time.sleep(0.5); os.write(fd, b'\r')
t0 = time.time(); stop_at = None
while time.time() - t0 < 150:
    pump(1)
    if any(l.split(' ', 2)[1:2] == ['Stop'] for l in hooklines()):
        stop_at = stop_at or time.time()
        if time.time() - stop_at > 4: break
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass

text = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]', b'', screen).decode('utf8', 'replace')
print('==== last screen lines')
print('\n'.join([l.rstrip() for l in text.splitlines() if l.strip()][-12:]))
print('\n==== hooks.log (ts event | payload without paths)')
for line in hooklines():
    ts, event, payload = (line.split(' ', 2) + ['', ''])[:3]
    try: d = json.loads(payload)
    except ValueError: d = {'raw': payload[:300]}
    for k in ('transcript_path', 'session_id', 'cwd'): d.pop(k, None)
    print(ts, event, json.dumps(d)[:600])
if not hooklines():
    print('(no hook fired - not logged in, or hooks untrusted: retry with --dangerously-bypass-hook-trust as an extra argument)')
print(f'\nfull log: {LOG}')
