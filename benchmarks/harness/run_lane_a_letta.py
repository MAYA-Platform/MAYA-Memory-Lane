#!/usr/bin/env python3
"""Letta — Lane A: Retrieval Recall benchmark runner (native server + REST API).

Mirror of run_lane_a_honcho.py. Same LongMemEval oracle instances, same
queries, same gold standard, same scoring semantics.

Fair-mirror design (Letta's real product path — the server + REST API):
  - Server: local Letta server (SQLite backend, no Postgres needed).
  - Agent: one agent created via POST /agents.
  - Ingest: each haystack session's turns inserted as archival passages via
    POST /agents/{id}/archival-memory, each passage tagged with the haystack
    session id (tags=[session_id]).
  - Search: GET /agents/{id}/archival-memory/search?query=<raw question>&top_k=25
    — semantic (embedding-based) search, the same shape as Honcho's peer.search.
  - Retrieval unit: haystack session id (from passage tags).

Note: Letta is a server runtime. The server must be started before this script
runs (see start_letta_server.bat / docker-compose). Embedding model for the
archival store is configured server-side; bge-m3 via Ollama is a supported
local embedder.

Usage:
  python run_lane_a_letta.py [--items N] [--dataset PATH] [--base_url http://127.0.0.1:8283]
"""
import argparse
import hashlib
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent

DEFAULT_BASE = "http://127.0.0.1:8283"


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def recall_at_k(gold, retrieved, k):
    top = set(retrieved[:k])
    if not gold:
        return 1.0
    return sum(1 for g in gold if g in top) / len(gold)


def ndcg_any_at_k(gold, retrieved, k):
    gold_set = set(gold)
    for i, sid in enumerate(retrieved[:k]):
        if sid in gold_set:
            return 1.0 / (i + 2)
    return 0.0


class LettaClient:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")

    def _req(self, method, path, body=None, timeout=120):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"HTTP {e.code} {method} {path}: {e.read()[:200]}")

    def create_agent(self, name="lme_bench"):
        # create_agent may require an LLM config; use the server defaults
        return self._req("POST", "/v1/agents", {"name": name})

    def insert_passages(self, agent_id, texts, tags=None):
        body = {"text": texts, "tags": tags or []}
        return self._req("POST", f"/v1/agents/{agent_id}/archival-memory", body)

    def search(self, agent_id, query, top_k=25):
        import urllib.parse
        q = urllib.parse.quote(query)
        return self._req("GET", f"/v1/agents/{agent_id}/archival-memory/search?query={q}&top_k={top_k}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=500)
    ap.add_argument("--dataset", default=str(BENCH / "datasets" / "longmemeval_oracle.json"))
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    client = LettaClient(args.base_url)
    print(f"[server] probing {args.base_url} ...")
    try:
        agent = client.create_agent()
    except Exception as e:
        print(f"FATAL: cannot reach Letta server at {args.base_url}: {e}")
        sys.exit(2)
    agent_id = agent["id"]
    print(f"[server] agent {agent_id} ready")

    # --- Ingest: each haystack session = passages tagged with session_id
    print(f"[ingest] {len(dataset)} instances -> Letta agent {agent_id}")
    t0 = time.time()
    ingested = 0
    errs = 0
    for inst in dataset:
        for si, sess in enumerate(inst["haystack_sessions"]):
            hsid = inst["haystack_session_ids"][si]
            # join turns into one passage per session, tagged with session id
            text = "\n".join(f"{t['role']}: {t['content']}" for t in sess)
            try:
                client.insert_passages(agent_id, [text], tags=[hsid])
                ingested += 1
            except Exception as e:
                errs += 1
                if errs <= 5:
                    print(f"  [ingest err {hsid}] {type(e).__name__}: {str(e)[:150]}")
        if (ingested + errs) % 200 == 0 and (ingested + errs) > 0:
            print(f"  [ingest] {ingested+errs} sessions ({time.time()-t0:.0f}s)")
    print(f"[ingest] {ingested} sessions, {errs} errs in {time.time()-t0:.1f}s")

    # --- Query: raw question via archival search -> session ids from tags
    print(f"[run] {len(dataset)} questions via archival-memory search")
    results = []
    for i, inst in enumerate(dataset):
        gold = inst.get("answer_session_ids") or []
        q = inst["question"]
        retrieved_sessions = []
        try:
            resp = client.search(agent_id, q, top_k=25)
            # resp: list of passages with tags
            seen = set()
            for p in resp:
                for tag in p.get("tags", []) or []:
                    if tag not in seen:
                        seen.add(tag)
                        retrieved_sessions.append(tag)
        except Exception as e:
            print(f"  [query err {inst['question_id']}] {type(e).__name__}: {str(e)[:150]}")
        results.append({
            "question_id": inst["question_id"],
            "question_type": inst.get("question_type"),
            "question": q,
            "gold_sessions": gold,
            "retrieved_sessions": retrieved_sessions,
            "session_recall_all_5": recall_at_k(gold, retrieved_sessions, 5),
            "session_recall_all_10": recall_at_k(gold, retrieved_sessions, 10),
            "session_ndcg_any_5": ndcg_any_at_k(gold, retrieved_sessions, 5),
            "session_ndcg_any_10": ndcg_any_at_k(gold, retrieved_sessions, 10),
        })
        if (i + 1) % 100 == 0:
            print(f"  [run] {i+1}/{len(dataset)}")

    agg = lambda fn: sum(fn(r) for r in results) / len(results) if results else 0
    metrics = {
        "run_id": run_id,
        "system": "letta",
        "dataset": Path(args.dataset).name,
        "instances": len(results),
        "dataset_sha256": sha256_bytes(Path(args.dataset).read_bytes()),
        "session_recall_all_5": agg(lambda r: r["session_recall_all_5"]),
        "session_recall_all_10": agg(lambda r: r["session_recall_all_10"]),
        "session_ndcg_any_5": agg(lambda r: r["session_ndcg_any_5"]),
        "session_ndcg_any_10": agg(lambda r: r["session_ndcg_any_10"]),
    }
    (BENCH / "logs").mkdir(exist_ok=True)
    (BENCH / "results").mkdir(exist_ok=True)
    (BENCH / "logs" / f"letta-lane-a-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"letta-lane-a-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== LETTA LANE A METRICS ===")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
