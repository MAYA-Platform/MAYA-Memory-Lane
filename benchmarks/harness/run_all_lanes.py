#!/usr/bin/env python3
"""Memory Lane vs Honcho — 24h benchmark orchestrator.

Runs the full pre-registered suite on every tick:
  - Lane A: Memory Lane retrieval recall (500 LongMemEval instances)
  - Lane A: Honcho retrieval recall (same 500 instances)
  - Lane B: Memory Lane integrity/tamper-evidence
  - Lanes C/D/E: Memory Lane resume, portability, compaction

Logs every run with timestamps + hashes to logs/ and results/.
Delivers a concise summary on stdout (cron watchdog pattern).

Usage:
  python run_all_lanes.py [--items N] [--honcho] [--ml] [--lanes-b-e]
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
HARNESS = BENCH / "harness"
NODE = "node"
PY = sys.executable


def ts():
    return datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")


def run(cmd, timeout=1200):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(HARNESS))
        return p.returncode, p.stdout[-3000:], p.stderr[-1000:]
    except subprocess.TimeoutExpired:
        return 124, "", "TIMEOUT"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=500)
    ap.add_argument("--honcho", action="store_true", help="run Honcho Lane A")
    ap.add_argument("--ml", action="store_true", help="run Memory Lane Lane A")
    ap.add_argument("--lanes-b-e", action="store_true", help="run Memory Lane Lanes B-E")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    do_all = args.all
    do_honcho = args.honcho or do_all
    do_ml = args.ml or do_all
    do_b_e = args.lanes_b_e or do_all

    started = datetime.now(timezone.utc).isoformat()
    summary = {"started": started, "run_id": ts(), "items": args.items, "lanes": {}}

    (BENCH / "logs").mkdir(exist_ok=True)
    (BENCH / "results").mkdir(exist_ok=True)

    # Lane A — Honcho (slow: ~15 min for 500)
    if do_honcho:
        print(f"[{ts()}] Honcho Lane A starting ({args.items} items)...")
        rc, out, err = run([PY, "run_lane_a_honcho.py", "--items", str(args.items)])
        summary["lanes"]["honcho_lane_a"] = {"rc": rc, "out_tail": out[-800:] if rc else "see results/"}
        print(f"[{ts()}] Honcho Lane A done rc={rc}")

    # Lane A — Memory Lane (fast ingest, slow search ~9 min for 500)
    if do_ml:
        print(f"[{ts()}] Memory Lane Lane A starting ({args.items} items)...")
        rc, out, err = run([NODE, "run_lane_a_ml.mjs"])
        summary["lanes"]["ml_lane_a"] = {"rc": rc, "out_tail": out[-800:] if rc else "see results/"}
        print(f"[{ts()}] Memory Lane Lane A done rc={rc}")

    # Lanes B-E — Memory Lane proofs
    if do_b_e:
        print(f"[{ts()}] Memory Lane Lanes B-E starting...")
        rc, out, err = run([NODE, "run_lane_b.mjs"])
        summary["lanes"]["lane_b"] = {"rc": rc, "out_tail": out[-600:] if rc else "see results/"}
        rc, out, err = run([NODE, "run_lanes_cde.mjs"])
        summary["lanes"]["lanes_cde"] = {"rc": rc, "out_tail": out[-600:] if rc else "see results/"}
        print(f"[{ts()}] Memory Lane Lanes B-E done")

    # Write run receipt
    receipt = BENCH / "results" / f"RUN_RECEIPT_{summary['run_id']}.json"
    receipt.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    # Concise stdout for cron delivery
    print("\n=== MEMORY LANE vs HONCHO — 24h BENCHMARK RUN ===")
    print(f"Run: {summary['run_id']}")
    print(f"Started: {started}")
    print(f"Receipt: {receipt}")
    lanes = summary["lanes"]
    print(f"Lanes executed: {', '.join(lanes.keys()) or 'NONE (use --all / --honcho / --ml / --lanes-b-e)'}")
    print(f"Full metrics in results/ — JSONL traces in logs/")


if __name__ == "__main__":
    main()
