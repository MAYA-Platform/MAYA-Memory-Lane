#!/usr/bin/env python3
"""
Memory Lane — inbox watcher (v3, 2026-08-05).

The "they do NOTHING" automation layer: watch a drop folder for transcript
files, ingest each one into a Memory Lane library via tools/ingest.mjs,
archive processed files to processed/<YYYY-MM-DD>/, and emit a short report
only when work happened. Runs as a no_agent cron job — silent when idle.

Config (env vars):
  ML_INBOX      drop folder (default: ./inbox)
  ML_LIBRARY    target Memory Lane library (default: ./empty-library)
  ML_REPO       Memory Lane repo root (default: repo root)
  ML_EXTS       comma-separated extensions to watch (default: .md,.txt,.json,.log)

Behavior:
  - Scans INBOX for files with a watched extension, ignoring dotfiles/temp.
  - Ingests each via `node tools/ingest.mjs <file> --source inbox --quiet`.
  - On success: moves the file to processed/<date>/ without replacing a name.
    Archive requires an atomic no-replace rename; unsupported filesystems or
    platforms leave the source in place for operator reconciliation.
    A known same-day archive collision stops before ingestion. The precheck
    cannot prevent a new collision appearing while ingestion is running.
  - On failure: stops the current run with a nonzero exit. Inspect the source
    and library before restarting; separate scheduled invocations may still run.
  - Prints nothing when there was nothing to do. Prints a short summary when
    work happened. Prints an error to stdout when a file failed (so the cron
    delivery surfaces it).
"""
import argparse
import datetime
import errno
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_INBOX = Path(os.environ.get("ML_INBOX", str(Path(__file__).resolve().parent.parent / "inbox")))
DEFAULT_LIBRARY = Path(os.environ.get("ML_LIBRARY", str(Path(__file__).resolve().parent.parent / "empty-library")))
DEFAULT_REPO = Path(__file__).resolve().parent.parent
DEFAULT_EXTS = os.environ.get("ML_EXTS", ".md,.txt,.json,.log")

NODE = shutil.which("node") or "node"


def find_node():
    """Locate node.exe reliably on Windows (cron PATH may be minimal)."""
    candidates = [
        shutil.which("node"),
        r"C:\Program Files\nodejs\node.exe",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return "node"


def _linux_renameat2():
    import ctypes
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        rename = getattr(libc, "renameat2", None)
        if rename is not None:
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
        return rename
    except OSError:
        return None


def supports_archive_noreplace():
    return os.name == "nt" or (sys.platform.startswith("linux") and _linux_renameat2() is not None)


def archive_noreplace(source, destination):
    """Move within a filesystem only when an atomic no-replace rename exists."""
    if os.name == "nt":
        # Windows rename raises FileExistsError instead of replacing destination.
        os.rename(source, destination)
        return
    if sys.platform.startswith("linux"):
        import ctypes
        rename = _linux_renameat2()
        if rename is not None:
            if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) == 0:
                return
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
    # Do not fall back to a check followed by a replacing move.
    raise OSError(errno.ENOTSUP, "atomic no-replace archive is unavailable")


def main():
    # Keep status and filenames printable on legacy consoles without altering files.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")
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
    if not supports_archive_noreplace():
        print("ML-WATCH ✗ atomic no-replace archival is unavailable on this platform; no ingestion started.")
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
                # Use one destination for both checks, including across midnight.
                date_dir = inbox / "processed" / datetime.date.today().isoformat()
                dest = date_dir / f.name
                if os.path.lexists(dest):
                    raise FileExistsError("archive destination already exists; ingestion not started")
                r = subprocess.run(
                    [node, str(ingest_js), str(f), "--source", "inbox", "--library", str(library), "--quiet"],
                    capture_output=True, timeout=180,
                    cwd=str(repo),
                )
                try:
                    stdout = r.stdout.decode("utf-8", errors="strict")
                    stderr = r.stderr.decode("utf-8", errors="strict")
                except UnicodeDecodeError:
                    failures.append({"file": f.name, "error": "ingest output is not valid UTF-8; outcome unconfirmed"})
                    break
                if r.returncode == 0:
                    out = json.loads(stdout.strip().splitlines()[-1])
                    if (not isinstance(out, dict) or out.get("ok") is not True
                            or not isinstance(out.get("block_id"), str) or not out["block_id"].strip()
                            or type(out.get("lib_id")) is not int or out["lib_id"] < 1):
                        raise ValueError("ingest receipt invalid; outcome unconfirmed")
                    # Archive to processed/<date>/
                    date_dir.mkdir(parents=True, exist_ok=True)
                    archive_noreplace(f, dest)
                    processed.append({
                        "file": f.name,
                        "block_id": out.get("block_id"),
                        "lib_id": out.get("lib_id"),
                        "chain_intact": out.get("chain_intact"),
                        "facts_count": out.get("facts_count", 0),
                    })
                else:
                    failures.append({"file": f.name, "error": (stderr or stdout).strip()[-300:]})
                    break
            except Exception as e:  # noqa: BLE001
                failures.append({"file": f.name, "error": str(e)[-300:]})
                break

        if not processed and not failures:
            return 0  # silent — nothing to do
        if processed:
            print(f"ML-WATCH ✓ ingested {len(processed)} file(s):")
            for p in processed:
                print(f"  - {p['file']} → {p['block_id']} (lib {p['lib_id']}, "
                      f"chain_intact={p['chain_intact']}, facts={p['facts_count']})")
        if failures:
            print("ML-WATCH ✗ stopped (inspect source and library before restarting; separate scheduled runs may retry):")
            for fl in failures:
                print(f"  - {fl['file']}: {fl['error']}")
            return 1
        return 0

    if args.once:
        return run_once()

    result = run_once()
    if result:
        return result
    if args.loop:
        import time
        while True:
            time.sleep(args.loop)
            result = run_once()
            if result:
                return result
    return 0


if __name__ == "__main__":
    sys.exit(main())
