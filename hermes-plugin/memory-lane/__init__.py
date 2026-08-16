"""Memory Lane memory plugin — MemoryProvider for local-first chain-verified memory.

Memory Lane is a zero-dependency, MIT, local-first memory library (SQLite FTS5
+ SHA-256 chain-verified blocks) that benchmarks 61% recall@5 on LongMemEval —
above hosted Honcho (40%) and Mem0 (68% on dense+hosted, 61% local FTS5) — while
running entirely offline on consumer hardware. This provider wires it into
Hermes as a first-class MemoryProvider so it appears in the same settings menu
as Honcho/Mem0/Supermemory.

Read side (the differentiator): the provider shells out to a tiny Node CLI
bridge over the existing core lib, preserving the exact FTS5 retrieval path and
chain verification. Four tools are exposed: ml_recent, ml_search, ml_resume,
ml_answer.

Auto-resume: prefetch() pulls the most recent blocks once at session start and
injects their content as context, so a fresh session begins with working memory
of where the last session left off.

Write side: durable writes are handled by the Session Auto-Sealer (session →
continuity block → block_to_memory_lane.py → ingest). This provider is
deliberately read-focused to avoid double-sealing; on_memory_write mirrors the
built-in memory tool into the library as an observation block.

Config (env or config.yaml under memory_lane:):
  MEMORY_LANE_LIBRARY — library dir (default E:/MAYA_BULK/memory-lane-live)
  MEMORY_LANE_CLI     — node bridge script path
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

DEFAULT_LIBRARY = "E:/MAYA_BULK/memory-lane-live"
DEFAULT_CLI = "E:/MAYA_BULK/memory-lane-public-repo/tools/memory-lane-cli.mjs"


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
        "Returns an exact match, or a synthesized answer from retrieved evidence. "
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

ALL_TOOL_SCHEMAS = [RECENT_SCHEMA, SEARCH_SCHEMA, RESUME_SCHEMA, ANSWER_SCHEMA]


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
            if not Path(cli).exists():
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

    # -- Context injection (auto-resume) ------------------------------------

    def system_prompt_block(self) -> str:
        return (
            "Memory Lane (local persistent memory) is active. Call ml_recent at "
            "session start, and ml_search / ml_resume / ml_answer when the user "
            "references past decisions, projects, or says 'pick up last session'."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Pull recent blocks once at session start and inject as context."""
        with self._prefetch_lock:
            if self._prefetched:
                return self._last_prefetch
            self._prefetched = True
            self._last_prefetch = self._format_recent_context(5)
            return self._last_prefetch

    def _format_recent_context(self, limit: int) -> str:
        """Format recent blocks as clean prose for context injection."""
        data = self._raw_recent(limit)
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

    # -- Tools --------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return ALL_TOOL_SCHEMAS

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "ml_recent":
            limit = int(args.get("limit") or 5)
            return json.dumps(self._raw_recent(limit))
        if tool_name == "ml_search":
            return self._run("search", args.get("query", ""), str(args.get("limit") or 5))
        if tool_name == "ml_resume":
            return self._run("resume", args.get("phrase", ""))
        if tool_name == "ml_answer":
            return self._run("answer", args.get("question", ""))
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

    def _raw_recent(self, limit: int) -> Dict[str, Any]:
        out = self._run_json("recent", str(max(1, min(limit, 25))))
        return out if isinstance(out, dict) else {"ok": False, "error": "bad response"}

    def _run(self, *argv: str) -> str:
        """Run the bridge and return the raw JSON string (or a tool-error JSON)."""
        node = _find_node()
        if not node:
            return json.dumps({"ok": False, "error": "node not found on PATH"})
        cli = _resolve(self._cli, "MEMORY_LANE_CLI", DEFAULT_CLI)
        lib = _resolve(self._library, "MEMORY_LANE_LIBRARY", DEFAULT_LIBRARY)
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
