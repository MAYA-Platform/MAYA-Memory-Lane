"""Two-profile installed MemoryManager probe with disposable homes and libraries."""
import importlib.util
import json
import os
import pathlib
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

source = os.environ["HERMES_AGENT_SOURCE"]
sys.path.insert(0, source)
from agent.memory_manager import MemoryManager
from agent.secret_scope import set_multiplex_active, set_secret_scope, reset_secret_scope
from hermes_constants import set_hermes_home_override, reset_hermes_home_override

alpha_library, beta_library, cli, root = sys.argv[1:5]
root = pathlib.Path(root)
receipts = []
children = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        receipts.append({"authorization": self.headers.get("Authorization"),
                         "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/api/v3/session"
file = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin/memory-lane/__init__.py"
spec = importlib.util.spec_from_file_location("memory_lane_runtime_probe", file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_run = module.subprocess.run


def capture_run(*args, **kwargs):
    env = kwargs["env"]
    children.append({key: env.get(key) for key in ("MEMORY_LANE_LIBRARY", "MEMORY_LANE_ACCESS_TOKEN",
        "MEMORY_LANE_MERGE_CONFIG", "MEMORY_LANE_DECISIONS_URL", "MERGE_API_KEY")})
    assert env.get("MEMORY_LANE_ACCESS_TOKEN") != "poison-process-token"
    assert env.get("MERGE_API_KEY") is None
    assert env.get("MEMORY_LANE_DECISIONS_URL") is None
    return real_run(*args, **kwargs)


module.subprocess.run = capture_run
profiles = {}
for name, library, token, namespace in (
    ("alpha", alpha_library, "test-alice", "client-a"),
    ("beta", beta_library, "test-bob", "client-b"),
):
    home = root / name
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(
        f"memory_lane:\n  namespace: {namespace}\n  session_url: {url}\n", encoding="utf-8")
    profiles[name] = {"home": home, "secrets": {
        "MEMORY_LANE_LIBRARY": library, "MEMORY_LANE_CLI": cli,
        "MEMORY_LANE_ACCESS_TOKEN": token}}


@contextmanager
def scoped(name):
    profile = profiles[name]
    home_token = set_hermes_home_override(profile["home"])
    secret_token = set_secret_scope(profile["secrets"], profile_home=str(profile["home"]))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


set_multiplex_active(True)
try:
    managers = {}
    for name in ("alpha", "beta"):
        with scoped(name):
            manager = MemoryManager()
            provider = module.MemoryLaneMemoryProvider()
            manager.add_provider(provider)
            manager.initialize_all("session-" + name, hermes_home=str(profiles[name]["home"]),
                                   platform="cli", agent_context="primary")
            assert manager.get_provider("memory-lane") is provider
            managers[name] = manager

    with scoped("alpha"):
        managers["alpha"].on_turn_start(1, "PRIVATE_ALPHA_MESSAGE")
        alpha = managers["alpha"].prefetch_all("Orchid", session_id="session-alpha")
        assert "A-491" in alpha and "B-492" not in alpha, alpha
        managers["alpha"].on_session_end([{"role": "user", "content": "TRANSCRIPT_NEVER_EXPORT"}])
        managers["alpha"].on_session_switch("session-alpha-next", reset=True)
        managers["alpha"].on_turn_start(1, "SECOND_PRIVATE_ALPHA")
        assert "A-491" in managers["alpha"].prefetch_all("Orchid", session_id="session-alpha-next")

    assert managers["alpha"].prefetch_all("Orchid", session_id="session-alpha-next") == ""
    managers["alpha"].on_turn_start(2, "UNSCOPED_MESSAGE")
    with scoped("beta"):
        assert managers["alpha"].prefetch_all("Orchid", session_id="session-alpha-next") == ""
        managers["alpha"].on_turn_start(2, "FOREIGN_MESSAGE")
        managers["beta"].on_turn_start(1, "PRIVATE_BETA_MESSAGE")
        beta = managers["beta"].prefetch_all("Orchid", session_id="session-beta")
        assert "B-492" in beta and "A-491" not in beta, beta

    with scoped("alpha"):
        managers["alpha"].on_session_switch("session-alpha-no-token", reset=True)
        secret_token = set_secret_scope({"MEMORY_LANE_LIBRARY": alpha_library,
                                         "MEMORY_LANE_CLI": cli},
                                        profile_home=str(profiles["alpha"]["home"]))
        try:
            managers["alpha"].on_turn_start(1, "MISSING_TOKEN_MESSAGE")
            assert managers["alpha"].prefetch_all("Orchid", session_id="session-alpha-no-token") == ""
        finally:
            reset_secret_scope(secret_token)

    for _ in range(40):
        if len(receipts) >= 3:
            break
        threading.Event().wait(0.05)
    assert len(receipts) == 3, receipts
    assert len(children) == 3, children
    assert sorted(r["authorization"] for r in receipts) == ["Bearer test-alice", "Bearer test-alice", "Bearer test-bob"]
    assert sorted(r["body"]["namespace"] for r in receipts) == ["client-a", "client-a", "client-b"]
    assert all(r["body"]["sketch"] == "" and "closeBlockId" not in r["body"] for r in receipts)
    assert all("PRIVATE" not in json.dumps(r) and "TRANSCRIPT" not in json.dumps(r) for r in receipts)
    assert [c["MEMORY_LANE_LIBRARY"] for c in children] == [alpha_library, alpha_library, beta_library]
    assert [c["MEMORY_LANE_ACCESS_TOKEN"] for c in children] == ["test-alice", "test-alice", "test-bob"]
    assert all(c["MEMORY_LANE_MERGE_CONFIG"] == os.devnull for c in children)
    print(json.dumps({"ok": True, "runtime": "installed MemoryManager", "profiles": 2,
                      "turns": len(receipts), "subprocesses": len(children), "unscoped_refused": True,
                      "prefetch": "profile-scoped"}))
finally:
    set_multiplex_active(False)
    server.shutdown()
