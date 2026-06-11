#!/usr/bin/env bash
# live-attach.sh — plug into a RUNNING hermes TUI (Ink or OpenTUI) and measure it.
#
#   bench/live-attach.sh <pid> [out-dir]          # sample memory+cpu until Ctrl-C
#   bench/live-attach.sh <pid> --profile [secs]   # also grab a CPU profile window (default 30s)
#   bench/live-attach.sh <pid> --heap             # grab a heap snapshot (large file!)
#
# Find your TUI pid:  pgrep -af 'dist/main.js'        (OpenTUI)
#                     pgrep -af 'dist/entry.js'       (Ink)
# Works on any live session — no restart, no flags needed at launch:
# profiling uses SIGUSR1 (Node opens an inspector port on demand).
# In-TUI complements (OpenTUI only): /mem (live stats line), /heapdump.
set -euo pipefail
PID="${1:?usage: live-attach.sh <pid> [outdir|--profile [secs]|--heap]}"
shift || true
OUT="${1:-/tmp/tui-live-$PID}"; MODE="sample"; SECS=30
[[ "${1:-}" == "--profile" ]] && { MODE=profile; OUT="/tmp/tui-live-$PID"; SECS="${2:-30}"; }
[[ "${1:-}" == "--heap"    ]] && { MODE=heap;    OUT="/tmp/tui-live-$PID"; }
mkdir -p "$OUT"
echo "target pid=$PID cmd=$(tr '\0' ' ' </proc/$PID/cmdline | cut -c1-80)"
echo "out: $OUT"

sample() {
  local f="$OUT/samples.jsonl"
  echo "sampling 1Hz → $f  (Ctrl-C to stop; render: node bench/live-render.mjs $OUT)"
  local prev_cpu=0 hz; hz=$(getconf CLK_TCK)
  while kill -0 "$PID" 2>/dev/null; do
    local rss pss pdirty hwm cpu t
    rss=$(awk '/^Rss:/{print $2}' /proc/$PID/smaps_rollup 2>/dev/null || echo 0)
    pss=$(awk '/^Pss:/{print $2}' /proc/$PID/smaps_rollup 2>/dev/null || echo 0)
    pdirty=$(awk '/^Private_Dirty:/{print $2}' /proc/$PID/smaps_rollup 2>/dev/null || echo 0)
    hwm=$(awk '/^VmHWM:/{print $2}' /proc/$PID/status 2>/dev/null || echo 0)
    cpu=$(awk '{print $14+$15}' /proc/$PID/stat 2>/dev/null || echo 0)
    t=$(date +%s.%N)
    printf '{"t":%s,"rss_kb":%s,"pss_kb":%s,"private_dirty_kb":%s,"vmhwm_kb":%s,"cpu_ticks":%s,"cpu_hz":%s}\n' \
      "$t" "$rss" "$pss" "$pdirty" "$hwm" "$cpu" "$hz" >> "$f"
    sleep 1
  done
  echo "process exited; $(wc -l <"$f") samples in $f"
}

cdp() { # open inspector on demand, find the ws url
  kill -USR1 "$PID"; sleep 0.7
  local port; port=$(ss -tlnp 2>/dev/null | grep "pid=$PID" | grep -oE ':(92[0-9]{2})' | head -1 | tr -d ':')
  [[ -z "$port" ]] && port=9229
  curl -s "http://127.0.0.1:$port/json" | grep -oE 'ws://[^"]+' | head -1
}

case "$MODE" in
  sample) sample ;;
  profile)
    WS=$(cdp); echo "CDP: $WS — profiling ${SECS}s (interact with the TUI now!)"
    node "$(dirname "$0")/live-cdp.mjs" "$WS" profile "$SECS" "$OUT/live.cpuprofile"
    echo "→ $OUT/live.cpuprofile  (open in https://speedscope.app or chrome://inspect)" ;;
  heap)
    WS=$(cdp); echo "CDP: $WS — heap snapshot (may pause the TUI briefly)"
    node "$(dirname "$0")/live-cdp.mjs" "$WS" heap 0 "$OUT/live.heapsnapshot"
    echo "→ $OUT/live.heapsnapshot (Chrome DevTools → Memory → Load)" ;;
esac
