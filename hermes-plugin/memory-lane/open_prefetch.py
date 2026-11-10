"""Bounded, local-only session-open handoff to a later managed worker.

No bearer, transcript, or process-global profile binding is retained. A cache
miss is harmless: the provider falls back to its ordinary scoped retrieval.
"""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

TTL_SECONDS = 300
MAX_ENTRIES = 8
MAX_BYTES = 65536


def _root(home):
    root = Path(home) / "cache" / "memory-lane-open"
    if any(p.is_symlink() for p in (Path(home), root.parent, root)):
        raise ValueError("session-open cache may not use symlinks")
    return root


def _key(identity, session_id):
    return hashlib.sha256((identity + "\0" + session_id).encode()).hexdigest() + ".json"


def store(home, identity, session_id, context):
    if not identity or not session_id or not context:
        return False
    payload = json.dumps({"identity": identity, "session_id": session_id,
                          "created": time.time(), "context": context}).encode()
    if len(payload) > MAX_BYTES:
        return False
    root = _root(home)
    root.mkdir(parents=True, exist_ok=True)
    # Generated cache entries only. Never traverse or prune a symlink.
    entries = sorted((p for p in root.glob("*.json") if not p.is_symlink()),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for p in entries[MAX_ENTRIES - 1:]:
        p.unlink(missing_ok=True)
    target = root / _key(identity, session_id)
    if target.is_symlink():
        return False
    fd, temporary = tempfile.mkstemp(prefix=".open-", dir=root)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def consume(home, identity, session_id):
    if not identity or not session_id:
        return ""
    path = _root(home) / _key(identity, session_id)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        age = time.time() - data["created"]
        if (data.get("identity") != identity or data.get("session_id") != session_id
                or not 0 <= age <= TTL_SECONDS or not isinstance(data.get("context"), str)):
            return ""
        return data["context"]
    except (OSError, ValueError, KeyError, TypeError):
        return ""
    finally:
        path.unlink(missing_ok=True)
