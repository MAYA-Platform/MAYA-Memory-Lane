"""Memory Lane memory plugin — MemoryProvider for local-first chain-verified memory.

Memory Lane is a zero-dependency, MIT, local-first memory library (SQLite FTS5
+ SHA-256 chain-verified blocks) that benchmarks 61% recall@5 on LongMemEval —
above hosted Honcho (40%) and Mem0 (68% on dense+hosted, 61% local FTS5) — while
using deterministic local retrieval on consumer hardware; optional Jev decisions send minimized context externally. This provider wires it into
Hermes as a first-class MemoryProvider so it appears in the same settings menu
as Honcho/Mem0/Supermemory.

Read side (the differentiator): the provider shells out to a tiny Node CLI
bridge over the existing core lib, preserving the exact FTS5 retrieval path and
chain verification. Five tools are exposed: ml_recent, ml_search, ml_resume,
ml_answer, and the V3-scoped ml_query.

Auto-resume: prefetch() pulls the most recent blocks once at session start and
injects their content as context, so a fresh session begins with working memory
of where the last session left off.

Write side: the provider does not mirror memory writes. Session freshness anchors are sent only to the authenticated V3 session endpoint when explicitly configured. Canonical closeout sealing remains owned by the existing feeder.

Config (env or config.yaml under memory_lane:):
  MEMORY_LANE_LIBRARY — library dir (default ~/.memory-lane)
  MEMORY_LANE_CLI     — node bridge script path
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

DEFAULT_LIBRARY = os.path.expanduser("~/.memory-lane")


def _default_cli() -> str:
    """Find the bridge in a source checkout; copied plugins must configure it explicitly."""
    plugin_file = Path(__file__).resolve()
    for root in plugin_file.parents:
        candidate = root / "tools" / "memory-lane-cli.mjs"
        if candidate.is_file():
            return str(candidate)
    return ""


DEFAULT_CLI = _default_cli()


def _coerce_path(value: Any) -> str:
    return str(value).strip() if value else ""


# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function-calling format; names match the MCP server so
# behavior is identical whether reached via MCP or the provider).
# ---------------------------------------------------------------------------

RECENT_SCHEMA = {
    "name": "ml_recent",
    "description": (
        "Get a digest of the most recent memory blocks from Memory Lane (local "
        "persistent memory). Call this at the START of a session, or when the "
        "user says 'pick up last session' / 'resume' / 'where did we leave off', "
        "to load what was recently worked on. Returns block titles AND content "
        "excerpts, so one call gives real working context."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Number of recent blocks (default 5, max 25)."},
            "query": {"type": "string", "description": "Optional first-message or topic hint for Jev selection."},
        },
        "required": [],
    },
}

SEARCH_SCHEMA = {
    "name": "ml_search",
    "description": (
        "Full-text search across the Memory Lane library (local persistent "
        "memory). Use to recall past decisions, people, projects, or facts the "
        "user referenced before. Returns matching blocks with content excerpts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search terms, e.g. 'honda civic' or 'launch timeline'."},
            "limit": {"type": "integer", "description": "Max results (default 5, max 25)."},
        },
        "required": ["query"],
    },
}

RESUME_SCHEMA = {
    "name": "ml_resume",
    "description": (
        "Resolve a resume phrase or block id to the Memory Lane block(s) it "
        "points at. Use when the user gives a resume phrase, a cb_... block id, "
        "or says 'block logic resume'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "phrase": {"type": "string", "description": "Resume phrase or block id, e.g. 'cb_continuity_173'."},
        },
        "required": ["phrase"],
    },
}

ANSWER_SCHEMA = {
    "name": "ml_answer",
    "description": (
        "Ask Memory Lane a natural-language question about persistent memory. "
        "Returns verbatim source passages selected deterministically or by Jev decisions. "
        "Use when the user asks something memory might answer better than "
        "guessing: 'what did we decide about X', 'when is Y', 'who is Z'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "A natural-language question."},
        },
        "required": ["question"],
    },
}

QUERY_SCHEMA = {
    "name": "ml_query",
    "description": (
        "Run a scoped Memory Lane V3 evidence, bundle, or temporal query. "
        "Returns source-backed evidence; Jev is used only when the namespace "
        "allows external decisions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "entity": {"type": "string"},
            "predicate": {"type": "string"},
            "asOf": {"type": "string"},
            "knownAt": {"type": "string"},
            "bundle": {"type": "boolean"},
            "limit": {"type": "integer"},
            "requiredEntities": {"type": "array", "items": {"type": "string"}},
            "before": {"type": "string"},
        },
        "required": [],
    },
}

ALL_TOOL_SCHEMAS = [RECENT_SCHEMA, SEARCH_SCHEMA, RESUME_SCHEMA, ANSWER_SCHEMA, QUERY_SCHEMA]


class MemoryLaneMemoryProvider(MemoryProvider):
    """Local-first chain-verified memory via the Memory Lane library."""

    def __init__(self):
        self._library = DEFAULT_LIBRARY
        self._cli = DEFAULT_CLI
        self._session_id = ""
        self._prefetched = False
        self._prefetch_lock = threading.Lock()
        self._last_prefetch = ""
        self._init_error = ""
        self._session_url = os.environ.get("MEMORY_LANE_SESSION_URL", "").strip()
        self._namespace = os.environ.get("MEMORY_LANE_NAMESPACE", "").strip()

    # -- MemoryProvider ABC -------------------------------------------------

    @property
    def name(self) -> str:
        return "memory-lane"

    def is_available(self) -> bool:
        """Local check: node on PATH + library MANIFEST present + bridge exists."""
        try:
            node = _find_node()
            if not node:
                return False
            cli = _resolve(self._cli, "MEMORY_LANE_CLI", DEFAULT_CLI)
            if not cli or not Path(cli).is_file():
                return False
            lib = _resolve(self._library, "MEMORY_LANE_LIBRARY", DEFAULT_LIBRARY)
            return Path(lib, "MANIFEST.json").exists()
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id or ""
        self._library = _resolve(self._library, "MEMORY_LANE_LIBRARY", DEFAULT_LIBRARY)
        self._cli = _resolve(self._cli, "MEMORY_LANE_CLI", DEFAULT_CLI)
        self._prefetched = False
        # cron/flush contexts should not inject personal memory into prompts.
        agent_context = kwargs.get("agent_context", "")
        platform = kwargs.get("platform", "cli")
        if agent_context in {"cron", "flush"} or platform == "cron":
            self._prefetched = True  # skip prefetch for non-primary contexts
        else:
            self._report_activity()

    def on_session_start(self, session_id: str = "", **kwargs) -> None:
        if session_id:
            self._session_id = session_id
        self._prefetched = False
        self._last_prefetch = ""
        self._report_activity(sketch=kwargs.get("first_message", ""))

    # -- Context injection (auto-resume) ------------------------------------

    def system_prompt_block(self) -> str:
        return (
            "Memory Lane (local persistent memory) is active. Call ml_recent at "
            "session start, and ml_query / ml_search / ml_resume / ml_answer when the user "
            "references past decisions, projects, or says 'pick up last session'."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Pull recent blocks once at session start and inject as context."""
        with self._prefetch_lock:
            if self._prefetched:
                return self._last_prefetch
            self._prefetched = True
            self._last_prefetch = self._format_recent_context(5, query)
            return self._last_prefetch

    def _format_recent_context(self, limit: int, query: str = "") -> str:
        """Format recent blocks as clean prose for context injection."""
        data = self._raw_recent(limit, query)
        if not data.get("ok") or not data.get("blocks"):
            return ""
        lines = ["## Memory Lane — recent working context", ""]
        for b in data["blocks"]:
            title = b.get("title") or b.get("block_id") or ""
            excerpt = (b.get("excerpt") or "").strip()
            lines.append(f"- **{title}** (block {b.get('block_id')})")
            if excerpt:
                lines.append(f"  {excerpt}")
            lines.append("")
        return "\n".join(lines).strip()

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        # Recent-blocks pull is cheap and synchronous; no background queue needed.
        return

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", **kwargs) -> None:
        # A genuinely new session should re-pull recent memory (auto-resume).
        if kwargs.get("reset"):
            self._session_id = new_session_id
            self._prefetched = False
            self._last_prefetch = ""
            self._report_activity()

    def on_user_message(self, message: str, **kwargs) -> None:
        """Report scoped activity so the service can distinguish a wake from an active session."""
        self._report_activity(sketch=message)

    def on_session_end(self, close_block_id: str = "", **kwargs) -> None:
        close_block_id = close_block_id or kwargs.get("closeBlockId", "")
        if close_block_id:
            self._report_activity(close_block_id=close_block_id)

    def _report_activity(self, sketch: str = "", close_block_id: str = "") -> None:
        if not self._session_url or not self._namespace or not self._session_id:
            return
        parsed = urlsplit(self._session_url)
        loopback_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if (parsed.scheme != "https" and not loopback_http) or parsed.path.rstrip("/") != "/api/v3/session" or parsed.username or parsed.password:
            logger.warning("Memory Lane session URL must be the V3 session endpoint over HTTPS or loopback HTTP")
            return
        token = os.environ.get("MEMORY_LANE_ACCESS_TOKEN", "").strip()
        if not token:
            return
        payload = {
            "namespace": self._namespace,
            "sessionId": self._session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "runtime": "hermes",
            "sketch": str(sketch or "")[:500],
        }
        if close_block_id:
            payload["closeBlockId"] = str(close_block_id)[:128]

        def send():
            try:
                body = json.dumps(payload).encode("utf-8")
                request = Request(self._session_url, data=body, headers={
                    "Authorization": f"Bearer {token}", "Content-Type": "application/json",
                }, method="POST")
                with urlopen(request, timeout=1.5) as response:
                    if response.status not in (200, 202):
                        logger.warning("Memory Lane session activity rejected: HTTP %s", response.status)
            except Exception as exc:
                logger.debug("Memory Lane session activity unavailable: %s", type(exc).__name__)

        threading.Thread(target=send, name="memory-lane-session", daemon=True).start()

    # -- Tools --------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return ALL_TOOL_SCHEMAS

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "ml_recent":
            limit = int(args.get("limit") or 5)
            return json.dumps(self._raw_recent(limit, args.get("query", "")))
        if tool_name == "ml_search":
            return self._run("search", args.get("query", ""), str(args.get("limit") or 5))
        if tool_name == "ml_resume":
            return self._run("resume", args.get("phrase", ""))
        if tool_name == "ml_answer":
            return self._run("answer", args.get("question", ""))
        if tool_name == "ml_query":
            return self._run("query", json.dumps(args, separators=(",", ":")))
        raise NotImplementedError(f"{self.name} does not handle tool {tool_name}")

    # -- Write mirror (optional; durable writes come from the auto-sealer) ---

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        # Mirror built-in memory writes into the library as observations is
        # optional and can bloat the chain; kept as a no-op. The auto-sealer is
        # the authoritative durable write path.
        return

    def backup_paths(self) -> List[str]:
        lib = _resolve(self._library, "MEMORY_LANE_LIBRARY", DEFAULT_LIBRARY)
        paths = [lib]
        # The CLI bridge lives in the public repo checkout; include it so a
        # restore keeps the provider functional.
        cli = _resolve(self._cli, "MEMORY_LANE_CLI", DEFAULT_CLI)
        if cli:
            paths.append(cli)
        return paths

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "library", "description": "Memory Lane library directory (local)", "default": DEFAULT_LIBRARY, "secret": False},
            {"key": "cli", "description": "Path to memory-lane-cli.mjs bridge", "default": DEFAULT_CLI, "secret": False},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        # Store provider paths in config.yaml under memory_lane: (non-secret).
        try:
            from hermes_cli.config import set_config_value
            if values.get("library"):
                set_config_value("memory_lane.library", values["library"])
            if values.get("cli"):
                set_config_value("memory_lane.cli", values["cli"])
        except Exception:
            pass

    # -- Internals ----------------------------------------------------------

    def _raw_recent(self, limit: int, query: str = "") -> Dict[str, Any]:
        argv = ["recent", str(max(1, min(limit, 20)))]
        if query:
            argv.append(str(query)[:500])
        out = self._run_json(*argv)
        return out if isinstance(out, dict) else {"ok": False, "error": "bad response"}

    def _run(self, *argv: str) -> str:
        """Run the bridge and return the raw JSON string (or a tool-error JSON)."""
        node = _find_node()
        if not node:
            return json.dumps({"ok": False, "error": "node not found on PATH"})
        cli = _resolve(self._cli, "MEMORY_LANE_CLI", DEFAULT_CLI)
        lib = _resolve(self._library, "MEMORY_LANE_LIBRARY", DEFAULT_LIBRARY)
        if not cli or not Path(cli).is_file():
            return json.dumps({"ok": False, "error": "MEMORY_LANE_CLI must point to tools/memory-lane-cli.mjs"})
        env = dict(os.environ)
        env["MEMORY_LANE_LIBRARY"] = lib
        try:
            r = subprocess.run(
                [node, cli, *argv],
                capture_output=True, text=True, timeout=60, env=env,
            )
            if r.returncode != 0:
                return json.dumps({"ok": False, "error": (r.stderr or r.stdout or "unknown")[:400]})
            return (r.stdout or "").strip() or json.dumps({"ok": False, "error": "empty bridge output"})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def _run_json(self, *argv: str) -> Any:
        try:
            return json.loads(self._run(*argv))
        except Exception:
            return {"ok": False, "error": "invalid JSON from bridge"}


# ---------------------------------------------------------------------------
# Discovery helpers
# ---------------------------------------------------------------------------

def _find_node() -> Optional[str]:
    import shutil
    return shutil.which("node")


def _resolve(current: str, env_key: str, default: str) -> str:
    if os.environ.get(env_key):
        return os.environ[env_key]
    if current and current != default:
        return current
    # Fall back to config.yaml memory_lane.<key> if present.
    try:
        from hermes_cli.config import cfg_get, load_config
        cfg = load_config()
        key = env_key.replace("MEMORY_LANE_", "").lower()
        val = cfg_get(cfg, "memory_lane", key)
        if val:
            return str(val)
    except Exception:
        pass
    return default


def register(ctx) -> None:
    """Plugin-style registration hook."""
    ctx.register_memory_provider(MemoryLaneMemoryProvider())
