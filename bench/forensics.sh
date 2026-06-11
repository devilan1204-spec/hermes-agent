#!/usr/bin/env bash
# forensics.sh — assemble a chronological "what killed my gateway" timeline.
#
# Usage: bench/forensics.sh <since>
#   <since> is anything `date -d` accepts: '3 days ago', '2026-06-08', 'yesterday' ...
#
# Read-only against system state: it greps logs, queries the sessions DB via a
# read-only sqlite URI, reads journalctl/dmesg, lists worktrees and running
# processes. It never kills, restarts or writes anything outside mktemp.
#
# Sources merged into one timestamp-sorted timeline (local time, ISO):
#   [gateway.log]   ~/.hermes/logs/gateway.log*       gateway lifecycle lines
#   [errors.log]    ~/.hermes/logs/errors.log*        ERROR/CRITICAL lines
#   [exit-diag]     ~/.hermes/logs/gateway-exit-diag.log      (JSONL, UTC)
#   [tui-crash]     ~/.hermes/logs/tui_gateway_crash.log      exit/signal/exception markers
#   [opentui]       ~/.hermes/logs/opentui-v2.log             (JSONL, epoch ms)
#   [shutdown-diag] ~/.hermes/logs/gateway-shutdown-diag.log  SIGTERM dump headers
#   [oom]/[systemd]/[sleep]  journalctl --user / -k (dmesg fallback)
#   [sessions]      ~/.hermes/state.db sessions table (tui/cli sources)
#   [worktree]      git worktree lists + dir mtimes under ~/github
#   [proc]          currently running tui_gateway / dist/main.js / dist/entry.js
set -uo pipefail

SINCE_SPEC="${1:-}"
if [ -z "$SINCE_SPEC" ]; then
  echo "usage: $0 <since>   (e.g. '3 days ago', '2026-06-08')" >&2
  exit 2
fi
SINCE_EPOCH="$(date -d "$SINCE_SPEC" +%s 2>/dev/null)" || {
  echo "error: date -d could not parse: $SINCE_SPEC" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="$REPO_ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

TMP="$(mktemp -d /tmp/forensics.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- journal ---
# User journal: OOM notices, hermes-gateway unit lifecycle, suspend/resume.
journalctl --user --since "@$SINCE_EPOCH" -o short-iso-precise --no-pager 2>"$TMP/jr-user.err" \
  | grep -iE 'oom|out of memory|killed process|hermes-gateway[^ ]*\.service|suspend|hibernat|Scheduled restart' \
  > "$TMP/journal-user.txt" || true

# Kernel journal: the authoritative OOM-kill records.
if ! journalctl -k --since "@$SINCE_EPOCH" -o short-iso-precise --no-pager 2>"$TMP/jr-kern.err" \
    | grep -iE 'out of memory|oom-kill|oom_reaper|invoked oom-killer' \
    > "$TMP/journal-kernel.txt"; then
  : > "$TMP/journal-kernel.txt"
fi
if [ -s "$TMP/jr-kern.err" ] && [ ! -s "$TMP/journal-kernel.txt" ]; then
  echo "note: journalctl -k unavailable ($(head -1 "$TMP/jr-kern.err")); trying dmesg" >&2
  dmesg -T 2>/dev/null | grep -iE 'out of memory|oom-kill|invoked oom-killer' > "$TMP/dmesg.txt" || true
fi
[ -e "$TMP/dmesg.txt" ] || : > "$TMP/dmesg.txt"

# ------------------------------------------------------------- processes ---
ps -eo pid,lstart,rss,args --sort=lstart 2>/dev/null \
  | grep -E 'tui_gateway|dist/main\.js|dist/entry\.js' \
  | grep -vE 'grep|forensics' > "$TMP/ps.txt" || true

# -------------------------------------------------------------- worktrees ---
{
  for d in "$HOME"/github/*/; do
    [ -e "$d/.git" ] || continue
    echo "## repo $d"
    timeout 10 git -C "$d" worktree list 2>/dev/null || echo "(git worktree list failed)"
  done
} > "$TMP/worktrees.txt" 2>/dev/null || true

# ---------------------------------------------------------------- python ---
export FORENSICS_SINCE="$SINCE_EPOCH" FORENSICS_TMP="$TMP" FORENSICS_SINCE_SPEC="$SINCE_SPEC"
exec "$PY" - <<'PYEOF'
import json, os, re, sqlite3, sys, time
from datetime import datetime, timezone

SINCE = float(os.environ["FORENSICS_SINCE"])
TMP = os.environ["FORENSICS_TMP"]
NOW = time.time()
HOME = os.path.expanduser("~")
LOGS = os.path.join(HOME, ".hermes", "logs")

events = []  # (epoch, tag, msg)

def add(ep, tag, msg):
    if ep is None or ep < SINCE or ep > NOW + 120:
        return
    msg = " ".join(str(msg).split())
    if msg:
        events.append((ep, tag, msg[:500]))

def local_naive(s, fmt):
    """Parse a naive local-time string -> epoch."""
    try:
        return datetime.strptime(s, fmt).timestamp()
    except ValueError:
        return None

def iso_any(s):
    """Parse an ISO timestamp (Z / +00:00 / +0530 offsets) -> epoch."""
    s = s.strip().replace("Z", "+00:00")
    # journald short-iso uses +0530 (no colon); fromisoformat on 3.11+ copes.
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        m = re.match(r"(.*)([+-]\d{2})(\d{2})$", s)
        if m:
            try:
                return datetime.fromisoformat(f"{m.group(1)}{m.group(2)}:{m.group(3)}").timestamp()
            except ValueError:
                return None
        return None

def read_lines(path):
    try:
        with open(path, errors="replace") as f:
            return f.readlines()
    except OSError:
        return []

PYLOG = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+(\w+)\s+(.*)$")

# --- gateway.log* : lifecycle lines -----------------------------------------
LIFECYCLE = re.compile(
    r"Starting Hermes Gateway|Gateway running|Press Ctrl\+C|Shutting down|shutdown"
    r"|stopp(ed|ing)|Recovered \d+ background|reaped|restart|Cron ticker started",
    re.I,
)
for path in sorted(p for p in os.listdir(LOGS) if p.startswith("gateway.log")):
    for line in read_lines(os.path.join(LOGS, path)):
        m = PYLOG.match(line)
        if m and LIFECYCLE.search(m.group(3)):
            add(local_naive(m.group(1), "%Y-%m-%d %H:%M:%S"), "gateway.log", m.group(3))

# --- errors.log* : ERROR/CRITICAL header lines ------------------------------
for path in sorted(p for p in os.listdir(LOGS) if p.startswith("errors.log")):
    for line in read_lines(os.path.join(LOGS, path)):
        m = PYLOG.match(line)
        if m and m.group(2) in ("ERROR", "CRITICAL"):
            add(local_naive(m.group(1), "%Y-%m-%d %H:%M:%S"), "errors.log",
                f"{m.group(2)} {m.group(3)}")

# --- gateway-exit-diag.log : JSONL, UTC ISO ---------------------------------
for line in read_lines(os.path.join(LOGS, "gateway-exit-diag.log")):
    try:
        rec = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        continue
    tag = rec.get("tag", "?")
    extra = ""
    if tag == "asyncio.run.SystemExit":
        extra = f" code={rec.get('code')}"
    elif tag == "gateway.start":
        extra = f" replace={rec.get('replace')} argv={' '.join(rec.get('argv', [])[-3:])}"
    elif tag == "asyncio.run.returned":
        extra = f" success={rec.get('success')}"
    add(iso_any(rec.get("ts", "")), "exit-diag", f"{tag} pid={rec.get('pid')}{extra}")

# --- tui_gateway_crash.log : section markers + [tui-parent] lines -----------
SECTION = re.compile(r"^=== (.+?) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?: · (.*?))? ===\s*$")
TUIPARENT = re.compile(r"^\[tui-parent\] (\S+Z) (.*)$")
for line in read_lines(os.path.join(LOGS, "tui_gateway_crash.log")):
    m = SECTION.match(line)
    if m:
        what, ts, detail = m.group(1), m.group(2), m.group(3) or ""
        add(local_naive(ts, "%Y-%m-%d %H:%M:%S"), "tui-crash",
            f"{what}{' · ' + detail if detail else ''}")
        continue
    m = TUIPARENT.match(line)
    if m and ("[lifecycle]" in m.group(2) or "uncaughtException" in m.group(2)):
        add(iso_any(m.group(1)), "tui-parent", m.group(2))

# --- opentui-v2.log : JSONL, epoch ms ---------------------------------------
for line in read_lines(os.path.join(LOGS, "opentui-v2.log")):
    try:
        rec = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        continue
    keep = (rec.get("scope") == "gateway"
            or rec.get("level") in ("warn", "error")
            or "transport" in str(rec.get("msg", "")))
    if keep:
        data = rec.get("data") or {}
        brief = {k: v for k, v in data.items() if k in
                 ("python", "reason", "code", "signal", "cause", "sid", "attempt")}
        add(rec.get("t", 0) / 1000.0, "opentui",
            f"{rec.get('level')} {rec.get('scope')}: {rec.get('msg')} {brief if brief else ''}")

# --- gateway-shutdown-diag.log : SIGTERM dump headers -----------------------
lines = read_lines(os.path.join(LOGS, "gateway-shutdown-diag.log"))
for i, line in enumerate(lines):
    if line.startswith("=== shutdown diagnostic"):
        for j in range(i, min(i + 4, len(lines))):
            mm = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*$", lines[j])
            if mm:
                add(iso_any(mm.group(1)), "shutdown-diag",
                    line.strip().strip("= ").strip())
                break

# --- journal files ----------------------------------------------------------
JLINE = re.compile(r"^(\S+)\s+\S+\s+(.*)$")
def journal(path, default_tag):
    for line in read_lines(path):
        m = JLINE.match(line)
        if not m:
            continue
        ep, msg = iso_any(m.group(1)), m.group(2)
        low = msg.lower()
        if "out of memory" in low or "oom-kill" in low or "oom killer" in low \
                or "invoked oom-killer" in low or "result 'oom-kill'" in low:
            tag = "oom"
        elif "suspend" in low or "hibernat" in low:
            tag = "sleep"
        else:
            tag = default_tag
        add(ep, tag, msg)

journal(os.path.join(TMP, "journal-user.txt"), "systemd")
journal(os.path.join(TMP, "journal-kernel.txt"), "oom")
for line in read_lines(os.path.join(TMP, "dmesg.txt")):
    m = re.match(r"^\[(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\]\s*(.*)$", line)
    if m:
        add(local_naive(re.sub(r" +", " ", m.group(1)), "%a %b %d %H:%M:%S %Y"),
            "oom", m.group(2))

# --- sessions DB ------------------------------------------------------------
abnormal_sessions = []
db = os.path.join(HOME, ".hermes", "state.db")
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    rows = con.execute(
        "SELECT id, source, started_at, ended_at, end_reason, message_count "
        "FROM sessions WHERE source IN ('tui','cli') AND "
        "(started_at >= ? OR (ended_at IS NOT NULL AND ended_at >= ?)) "
        "ORDER BY started_at", (SINCE, SINCE)).fetchall()
    con.close()
    for sid, source, st, en, reason, mc in rows:
        add(st, "sessions", f"START {source} session={sid} messages={mc}")
        if en is not None:
            flag = "" if reason else " ABNORMAL(no end_reason)"
            add(en, "sessions",
                f"END   {source} session={sid} reason={reason or 'NULL'} messages={mc}{flag}")
            if not reason:
                abnormal_sessions.append((sid, source, st, "ended, no end_reason"))
        else:
            add(st, "sessions",
                f"NOEND {source} session={sid} messages={mc} "
                f"ABNORMAL(no ended_at recorded — crashed parent or still running)")
            abnormal_sessions.append((sid, source, st, "no ended_at"))
except sqlite3.Error as e:
    print(f"note: sessions DB unreadable: {e}", file=sys.stderr)

# --- worktrees: current list + dir mtimes -----------------------------------
worktree_snapshot = open(os.path.join(TMP, "worktrees.txt"), errors="replace").read() \
    if os.path.exists(os.path.join(TMP, "worktrees.txt")) else ""
wt_dirs = []
for base in ([os.path.join(HOME, "github", d, ".worktrees")
              for d in (os.listdir(os.path.join(HOME, "github"))
                        if os.path.isdir(os.path.join(HOME, "github")) else [])]
             + [os.path.join(HOME, "github", "worktrees", d)
                for d in (os.listdir(os.path.join(HOME, "github", "worktrees"))
                          if os.path.isdir(os.path.join(HOME, "github", "worktrees")) else [])]):
    if not os.path.isdir(base):
        continue
    for name in os.listdir(base):
        p = os.path.join(base, name)
        if os.path.isdir(p):
            try:
                mt = os.stat(p).st_mtime
            except OSError:
                continue
            wt_dirs.append((p, mt))
            add(mt, "worktree", f"last-modified {p} "
                f"(age {round((NOW - mt) / 3600, 1)}h)")

# --- process snapshot -------------------------------------------------------
running = []
PSLINE = re.compile(r"^\s*(\d+)\s+(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(\d+)\s+(.*)$")
for line in read_lines(os.path.join(TMP, "ps.txt")):
    m = PSLINE.match(line)
    if not m:
        continue
    pid, lstart, rss, args = m.groups()
    ep = local_naive(re.sub(r" +", " ", lstart), "%a %b %d %H:%M:%S %Y")
    running.append((pid, ep, int(rss), args))
    add(ep, "proc", f"STILL-RUNNING pid={pid} rss={int(rss)//1024}MB started-here: {args[:200]}")

# --- emit timeline ----------------------------------------------------------
def iso(ep):
    return datetime.fromtimestamp(ep).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")

print(f"# forensics timeline since {os.environ['FORENSICS_SINCE_SPEC']!r} "
      f"({iso(SINCE)}) — generated {iso(NOW)}")
print(f"# {len(events)} events\n")

events.sort(key=lambda e: e[0])
prev = None
dup = 0
def flush(prev, dup):
    if prev is None:
        return
    suffix = f"  (x{dup + 1})" if dup else ""
    print(f"{iso(prev[0])} [{prev[1]}] {prev[2]}{suffix}")
for ev in events:
    if prev and ev[1] == prev[1] and ev[2] == prev[2] and ev[0] - prev[0] < 5:
        dup += 1
        continue
    flush(prev, dup)
    prev, dup = ev, 0
flush(prev, dup)

# --- summary ----------------------------------------------------------------
print("\n" + "=" * 72)
print("SUMMARY")
print("=" * 72)
from collections import Counter
by_tag = Counter(e[1] for e in events)
for tag, n in by_tag.most_common():
    print(f"  {n:6d}  [{tag}]")

ooms = [e for e in events if e[1] == "oom" and "Killed process" in e[2]]
print(f"\nOOM kernel kills in window: {len(ooms)}")
for e in ooms:
    m = re.search(r"Killed process (\d+) \(([^)]+)\).*?anon-rss:(\d+)kB", e[2])
    if m:
        print(f"  {iso(e[0])}  pid={m.group(1)} comm={m.group(2)} anon-rss={int(m.group(3))//1024}MB")
    else:
        print(f"  {iso(e[0])}  {e[2][:140]}")

oomd = [e for e in events if e[1] == "oom" and "Killed process" not in e[2]
        and ("oom" in e[2].lower())]
print(f"OOM-related systemd/unit notices: {len(oomd)}")

gexits = Counter()
for e in events:
    if e[1] == "tui-crash" and e[2].startswith("gateway exit"):
        m = re.search(r"reason=(.*)$", e[2])
        gexits[m.group(1) if m else "?"] += 1
print(f"\ntui_gateway exits by reason (tui_gateway_crash.log):")
for r, n in gexits.most_common():
    print(f"  {n:4d}  {r}")

sigs = Counter(e[2].split(" received")[0] for e in events
               if e[1] == "tui-crash" and " received" in e[2])
print(f"tui_gateway signals received: {dict(sigs) if sigs else 'none'}")

starts = sum(1 for e in events if e[1] == "exit-diag" and e[2].startswith("gateway.start"))
nz = sum(1 for e in events if e[1] == "exit-diag" and "exit_nonzero" in e[2])
print(f"\nplatform gateway (hermes-gateway.service): {starts} start(s), {nz} nonzero-exit(s) in window")

print(f"\nabnormal tui/cli sessions (no ended_at or no end_reason): {len(abnormal_sessions)}")
for sid, source, st, why in abnormal_sessions[-20:]:
    print(f"  {iso(st)}  {source} {sid}: {why}")

sleeps = [e for e in events if e[1] == "sleep"]
print(f"\nsuspend/hibernate events: {len(sleeps)}")

print(f"\ncurrently running TUI/gateway processes: {len(running)}")
for pid, ep, rss, args in running:
    print(f"  pid={pid} since={iso(ep) if ep else '?'} rss={rss//1024}MB {args[:120]}")

print(f"\ncurrent git worktrees (snapshot, not historical):")
for line in worktree_snapshot.splitlines():
    print(f"  {line}")
print("\nNOTE: worktree DELETIONS leave no on-disk record; only surviving dirs are")
print("listed. Prune suspects: cli.py _prune_stale_worktrees (24h/72h tiers) and")
print("the atexit _cleanup_worktree hook (removes dirty worktrees w/o unpushed commits).")
PYEOF
