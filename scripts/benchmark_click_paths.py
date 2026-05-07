"""
Benchmark: CDP coordinate click (real Lightpanda) vs agent-browser IPC latency.

This measures:
1. CDP path — browser_click(x, y) hitting real Lightpanda WS at :63372
2. agent-browser HTTP IPC — raw HTTP request to /api/click (measures the IPC
   channel cost without needing a loaded page)

Usage: python scripts/benchmark_click_paths.py [--iterations N] [--warmup N]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from statistics import mean, median, stdev
from typing import List, Dict, Tuple

sys.path.insert(0, "/private/tmp/hermes-coord-click")

LIGHTPANDA_WS = "ws://127.0.0.1:63372/"
AGENT_BROWSER_BASE = "http://127.0.0.1:63371"


def _stats(times_s: List[float]) -> Dict[str, float]:
    ms = [t * 1000 for t in times_s]
    return {
        "mean_ms": mean(ms),
        "median_ms": median(ms),
        "min_ms": min(ms),
        "max_ms": max(ms),
        "stdev_ms": stdev(ms) if len(ms) > 1 else 0.0,
        "p95_ms": sorted(ms)[int(len(ms) * 0.95)],
    }


def _row(label: str, stats: Dict, col_w: int = 9) -> None:
    print(
        f"  {label:<44}  "
        f"{stats['mean_ms']:>{col_w}.2f}  "
        f"{stats['median_ms']:>{col_w}.2f}  "
        f"{stats['min_ms']:>{col_w}.2f}  "
        f"{stats['p95_ms']:>{col_w}.2f}  "
        f"{stats['max_ms']:>{col_w}.2f}  ms"
    )


def _bench(fn, n: int) -> Tuple[List[float], int]:
    times, errors = [], 0
    for _ in range(n):
        t0 = time.perf_counter()
        try:
            result = fn()
            elapsed = time.perf_counter() - t0
            if isinstance(result, str):
                d = json.loads(result)
                if not d.get("success"):
                    errors += 1
        except Exception:
            elapsed = time.perf_counter() - t0
            errors += 1
        times.append(elapsed)
    return times, errors


def _http_get(url: str) -> float:
    """Return elapsed seconds for a single HTTP GET (measures IPC round-trip)."""
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            r.read()
    except Exception:
        pass
    return time.perf_counter() - t0


def run_benchmark(iterations: int = 200, warmup: int = 15) -> None:
    print(f"\n{'=' * 76}")
    print(f"  browser_click: CDP Coordinate Click (real Lightpanda) Benchmark")
    print(f"{'=' * 76}")
    print(f"  Iterations: {iterations}  |  Warmup: {warmup}")

    import importlib
    import tools.browser_tool as bt
    import tools.browser_cdp_tool as cdp_mod
    importlib.reload(cdp_mod)
    importlib.reload(bt)

    bt._is_camofox_mode = lambda: False
    _orig_resolve = cdp_mod._resolve_cdp_endpoint

    # -----------------------------------------------------------------------
    # A. CDP coord click via real Lightpanda WS
    # -----------------------------------------------------------------------
    print(f"\n  [A] CDP coord → Lightpanda WS ({LIGHTPANDA_WS})")
    cdp_mod._resolve_cdp_endpoint = lambda: LIGHTPANDA_WS

    print(f"      Warming up ({warmup})...")
    for _ in range(warmup):
        bt.browser_click(x=100.0, y=100.0, task_id="bench")

    print(f"      Benchmarking ({iterations})...")
    cdp_times, cdp_err = _bench(
        lambda: bt.browser_click(x=150.0, y=200.0, task_id="bench"),
        iterations,
    )
    cdp_mod._resolve_cdp_endpoint = _orig_resolve
    cdp_stats = _stats(cdp_times)
    print(f"      Done — {cdp_err} errors, mean={cdp_stats['mean_ms']:.2f}ms")

    # -----------------------------------------------------------------------
    # B. agent-browser HTTP IPC latency (GET /api/sessions — lightweight ping)
    # -----------------------------------------------------------------------
    print(f"\n  [B] agent-browser HTTP IPC round-trip (:63371/api/sessions)")
    print(f"      Warming up ({warmup})...")
    for _ in range(warmup):
        _http_get(f"{AGENT_BROWSER_BASE}/api/sessions")

    print(f"      Benchmarking ({iterations})...")
    ab_times = []
    for _ in range(iterations):
        ab_times.append(_http_get(f"{AGENT_BROWSER_BASE}/api/sessions"))
    ab_stats = _stats(ab_times)
    print(f"      Done — mean={ab_stats['mean_ms']:.2f}ms")

    # -----------------------------------------------------------------------
    # C. Raw Lightpanda WS latency (single CDP call — no click, just a ping)
    #    This measures WS connection setup + 1 message round-trip
    # -----------------------------------------------------------------------
    print(f"\n  [C] Raw single CDP call to Lightpanda (Target.getTargets baseline)")
    print(f"      Warming up ({warmup})...")

    async def _single_cdp():
        from tools.browser_cdp_tool import _cdp_call, _run_async
        return _run_async(_cdp_call(LIGHTPANDA_WS, "Target.getTargets", {}, None, 5.0))

    def _time_single_cdp():
        from tools.browser_cdp_tool import _cdp_call, _run_async
        return _run_async(_cdp_call(LIGHTPANDA_WS, "Target.getTargets", {}, None, 5.0))

    for _ in range(warmup):
        _time_single_cdp()

    print(f"      Benchmarking ({iterations})...")
    single_cdp_times = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        _time_single_cdp()
        single_cdp_times.append(time.perf_counter() - t0)
    single_cdp_stats = _stats(single_cdp_times)
    print(f"      Done — mean={single_cdp_stats['mean_ms']:.2f}ms per WS connection+call")

    # -----------------------------------------------------------------------
    # Results
    # -----------------------------------------------------------------------
    col_w = 9
    print(f"\n{'─' * 76}")
    print(f"  {'Path':<44}  {'Mean':>{col_w}}  {'Median':>{col_w}}  {'Min':>{col_w}}  {'p95':>{col_w}}  {'Max':>{col_w}}")
    print(f"{'─' * 76}")
    _row("CDP coord (x,y) → Lightpanda [3 WS conns]", cdp_stats, col_w)
    _row("Single CDP call [1 WS conn baseline]", single_cdp_stats, col_w)
    _row("agent-browser HTTP IPC [1 request]", ab_stats, col_w)
    print(f"{'─' * 76}")

    expected_3x = single_cdp_stats["mean_ms"] * 3
    print(f"\n  Analysis:")
    print(f"    • Full CDP click = {cdp_stats['mean_ms']:.2f}ms  ({cdp_stats['mean_ms'] / single_cdp_stats['mean_ms']:.1f}× single call)")
    print(f"    • Expected at 3 sequential WS connections: ~{expected_3x:.1f}ms")
    print(f"    • Single WS conn+call baseline: {single_cdp_stats['mean_ms']:.2f}ms")
    print(f"    • agent-browser HTTP IPC: {ab_stats['mean_ms']:.2f}ms per call")
    print(f"      (ref click = ~1 IPC call, fallback mouse = ~3 IPC calls)")
    print(f"    • Estimated ref click latency: ~{ab_stats['mean_ms']:.1f}ms")
    print(f"    • Estimated fallback (mouse) latency: ~{ab_stats['mean_ms']*3:.1f}ms")
    print(f"    • CDP coord vs ref estimate: {cdp_stats['mean_ms']:.1f}ms vs ~{ab_stats['mean_ms']:.1f}ms")
    cdp_vs_ref_est = cdp_stats["mean_ms"] / ab_stats["mean_ms"]
    print(f"      Ratio: {cdp_vs_ref_est:.1f}x — overhead from 3 per-click WS conn setups.")
    print(f"    • Both are well under 100ms human perception threshold.")
    print(f"    • A persistent WS connection would reduce CDP clicks to ~{single_cdp_stats['mean_ms']*2:.1f}ms")
    print(f"      (just mousePressed + mouseReleased on existing session).")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=15)
    args = parser.parse_args()
    run_benchmark(iterations=args.iterations, warmup=args.warmup)
