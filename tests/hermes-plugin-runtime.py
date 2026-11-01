"""Installed Hermes MemoryManager contract probe; run only with HERMES_AGENT_SOURCE."""
import importlib.util
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

source = os.environ["HERMES_AGENT_SOURCE"]
sys.path.insert(0, source)
from agent.memory_manager import MemoryManager

library, cli = sys.argv[1:3]
receipts = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        receipts.append(body)
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["MEMORY_LANE_LIBRARY"] = library
os.environ["MEMORY_LANE_CLI"] = cli
os.environ["MEMORY_LANE_ACCESS_TOKEN"] = "test-alice"
os.environ["MEMORY_LANE_NAMESPACE"] = "client-a"
os.environ["MEMORY_LANE_SESSION_URL"] = f"http://127.0.0.1:{server.server_port}/api/v3/session"

file = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin/memory-lane/__init__.py"
spec = importlib.util.spec_from_file_location("memory_lane_runtime_probe", file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
provider = module.MemoryLaneMemoryProvider()
manager = MemoryManager()
manager.add_provider(provider)
manager.initialize_all("session-a", hermes_home=os.environ["HERMES_HOME"], platform="cli", agent_context="primary")
assert manager.get_provider("memory-lane") is provider
assert "ml_query" in [x["name"] for x in provider.get_tool_schemas()]
manager.on_turn_start(1, "PRIVATE_MESSAGE_NEVER_EXPORT")
assert provider._session_id == "session-a"
context = provider.prefetch("Orchid", session_id="session-a")
assert "A-491" in context and "B-492" not in context, context
manager.on_turn_start(2, "SECOND_PRIVATE_MESSAGE")
manager.on_session_end([{"role": "user", "content": "TRANSCRIPT_NEVER_EXPORT"}])
manager.on_session_switch("session-b", reset=True)
manager.on_turn_start(1, "THIRD_PRIVATE_MESSAGE")
assert provider._session_id == "session-b"
assert "A-491" in provider.prefetch("Orchid", session_id="session-b")
for _ in range(30):
    if len(receipts) >= 3:
        break
    threading.Event().wait(0.05)
server.shutdown()
assert len(receipts) == 3, receipts
assert sorted(x["sessionId"] for x in receipts) == ["session-a", "session-a", "session-b"], receipts
assert all(x["sketch"] == "" and "closeBlockId" not in x for x in receipts), receipts
assert not any("PRIVATE_MESSAGE" in json.dumps(x) or "TRANSCRIPT" in json.dumps(x) for x in receipts)
print(json.dumps({"ok": True, "runtime": "installed MemoryManager", "turns": len(receipts), "prefetch": "scoped"}))
