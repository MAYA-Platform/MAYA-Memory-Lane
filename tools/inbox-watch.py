#!/usr/bin/env python3
"""
Memory Lane — inbox watcher (v3, 2026-08-05).

The "they do NOTHING" automation layer: watch a drop folder for transcript
files, ingest each one into a Memory Lane library via tools/ingest.mjs,
archive processed files to processed/<YYYY-MM-DD>/, and emit a short report
only when work happened. Runs as a no_agent cron job — silent when idle.

Config (env vars):
  ML_INBOX      drop folder (default: E:/MAYA_BULK/memory-lane-inbox)
  ML_LIBRARY    target Memory Lane library (default: E:/MAYA_BULK/memory-lane-live)
  ML_REPO       Memory Lane repo root (default: E:/MAYA_BULK/memory-lane-public-repo)
  ML_EXTS       comma-separated extensions to watch (default: .md,.txt,.json,.log)

Behavior:
  - Scans INBOX for files with a watched extension, ignoring dotfiles/temp.
  - Ingests each via `node tools/ingest.mjs <file> --source inbox --quiet`.
  - On success: moves the file to processed/<date>/.
  - On failure: leaves the file in place (so it retries next tick) and logs.
  - Prints nothing when there was nothing to do. Prints a short summary when
    work happened. Prints an error to stdout when a file failed (so the cron
    delivery surfaces it).
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_INBOX = Path(os.environ.get("ML_INBOX", "E:/MAYA_BULK/memory-lane-inbox"))
DEFAULT_LIBRARY = Path(os.environ.get("ML_LIBRARY", "E:/MAYA_BULK/memory-lane-live"))
DEFAULT_REPO = Path(os.environ.get("ML_REPO", "E:/MAYA_BULK/memory-lane-public-repo"))
DEFAULT_EXTS = os.environ.get("ML_EXTS", ".md,.txt,.json,.log")

NODE = shutil.which("node") or "node"


def find_node():
    """Locate node.exe reliably on Windows (cron PATH may be minimal)."""
    candidates = [
        shutil.which("node"),
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files\nodejs\node.exe",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return "node"


def main():
    ap = argparse.ArgumentParser(description="Memory Lane inbox watcher")
    ap.add_argument("--inbox", default=str(DEFAULT_INBOX))
    ap.add_argument("--library", default=str(DEFAULT_LIBRARY))
    ap.add_argument("--repo", default=str(DEFAULT_REPO))
    ap.add_argument("--exts", default=DEFAULT_EXTS)
    ap.add_argument("--once", action="store_true", help="single pass, no loop (cron mode)")
    ap.add_argument("--loop", type=int, default=0, help="loop every N seconds (daemon mode)")
    args = ap.parse_args()

    inbox = Path(args.inbox)
    library = Path(args.library)
    repo = Path(args.repo)
    exts = tuple(e.strip().lower() for e in args.exts.split(",") if e.strip())
    ingest_js = repo / "tools" / "ingest.mjs"

    if not (library / "MANIFEST.json").exists():
        print(f"ML-WATCH ✗ library missing MANIFEST.json: {library}")
        sys.exit(1)
    if not ingest_js.exists():
        print(f"ML-WATCH ✗ ingest CLI not found: {ingest_js}")
        sys.exit(1)

    inbox.mkdir(parents=True, exist_ok=True)

    def run_once():
        node = find_node()
        processed = []
        failures = []
        # Collect candidate files: any file with a watched extension, not a dotfile.
        candidates = []
        for f in sorted(inbox.iterdir()):
            if not f.is_file():
                continue
            if f.name.startswith(".") or f.name.startswith("~"):
                continue
            if f.suffix.lower() in exts:
                candidates.append(f)
        for f in candidates:
            try:
                r = subprocess.run(
                    [node, str(ingest_js), str(f), "--source", "inbox", "--library", str(library), "--quiet"],
                    capture_output=True, text=True, timeout=180,
                    cwd=str(repo),
                )
                if r.returncode == 0:
                    out = json.loads(r.stdout.strip().splitlines()[-1])
                    # Archive to processed/<date>/
                    date_dir = inbox / "processed" / datetime.date.today().isoformat()
                    date_dir.mkdir(parents=True, exist_ok=True)
                    dest = date_dir / f.name
                    shutil.move(str(f), str(dest))
                    processed.append({
                        "file": f.name,
                        "block_id": out.get("block_id"),
                        "lib_id": out.get("lib_id"),
                        "chain_intact": out.get("chain_intact"),
                        "facts_count": out.get("facts_count", 0),
                    })
                else:
                    failures.append({"file": f.name, "error": (r.stderr or r.stdout or "").strip()[-300:]})
            except Exception as e:  # noqa: BLE001
                failures.append({"file": f.name, "error": str(e)[-300:]})

        if not processed and not failures:
            return  # silent — nothing to do
        if processed:
            print(f"ML-WATCH ✓ ingested {len(processed)} file(s):")
            for p in processed:
                print(f"  - {p['file']} → {p['block_id']} (lib {p['lib_id']}, "
                      f"chain_intact={p['chain_intact']}, facts={p['facts_count']})")
        if failures:
            print("ML-WATCH ✗ failures (files left in place for retry):")
            for fl in failures:
                print(f"  - {fl['file']}: {fl['error']}")

    if args.once:
        run_once()
        return

    run_once()
    if args.loop:
        import time
        while True:
            time.sleep(args.loop)
            run_once()


if __name__ == "__main__":
    main()
