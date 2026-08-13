#!/usr/bin/env python3
"""Honcho — Lane A: Retrieval Recall benchmark runner (verified SDK path).

Mirror of run_lane_a_ml.mjs. Ingests the SAME LongMemEval instances into
Honcho (each haystack session = one Honcho Session, messages per turn), then
runs each question via peer.search() and measures session-level recall@k
against the gold answer_session_ids.

Verified 2026-08-04:
  - Session(session_id=..., honcho=client) creates/gets a session
  - session.add_messages([peer.message(content=...)]) writes
  - peer.search(query, limit) returns Message objects with .session_id
  - semantic search confirmed working (write then search returns the session)

Usage:
  python run_lane_a_honcho.py [--items N] [--dataset PATH] [--clean]
"""
import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
API_KEY = os.environ.get("HONCHO_API_KEY")
if not API_KEY:
    raise SystemExit("HONCHO_API_KEY environment variable is required (e.g. HONCHO_API_KEY=... python run_lane_a_honcho.py --items 500)")
WORKSPACE = os.environ.get("HONCHO_WORKSPACE", "memory-lane-benchmark")
PEER = "benchmark"

from honcho import Honcho, Session  # noqa: E402


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=500)
    ap.add_argument("--dataset", default=str(BENCH / "datasets" / "longmemeval_oracle.json"))
    ap.add_argument("--clean", action="store_true", help="delete benchmark sessions before ingest")
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    os.environ["HONCHO_API_KEY"] = API_KEY
    client = Honcho(api_key=API_KEY, base_url="https://api.honcho.dev", workspace_id=WORKSPACE)
    peer = client.peer(PEER)

    if args.clean:
        try:
            for s in peer.sessions().items:
                s.delete()
            print("[clean] wiped benchmark peer sessions")
        except Exception as e:
            print(f"[clean] partial wipe: {e}")

    # --- Ingest: each haystack session = one Honcho Session
    print(f"[ingest] {len(dataset)} instances -> Honcho workspace {WORKSPACE} peer {PEER}")
    session_ids = set()  # haystack session ids ingested
    sid_map = {}  # haystack id -> honcho session id (namespaced to avoid tombstones)
    t0 = time.time()
    ingested = 0
    for inst in dataset:
        for si, sess in enumerate(inst["haystack_sessions"]):
            hsid = inst["haystack_session_ids"][si]
            # namespaced honcho session id — avoids tombstone collisions from --clean deletes
            honcho_sid = f"lme_{hsid}_{si}"
            try:
                hsession = Session(session_id=honcho_sid, honcho=client)
                msgs = [peer.message(content=t["content"], metadata={"role": t["role"]}) for t in sess]
                hsession.add_messages(msgs)
                session_ids.add(hsid)
                sid_map[hsid] = honcho_sid
                ingested += 1
            except Exception as e:
                print(f"  [ingest err {hsid}] {type(e).__name__}: {str(e)[:150]}")
    print(f"[ingest] {ingested} sessions in {time.time()-t0:.1f}s")

    # --- Query
    print(f"[run] {len(dataset)} questions via peer.search")
    results = []
    for i, inst in enumerate(dataset):
        gold = inst.get("answer_session_ids") or []
        q = inst["question"]
        retrieved_sessions = []
        try:
            hits = peer.search(query=q, limit=25)
            # search returns Message objects; their session_id is the NAMESPACED id
            # map back to haystack session ids for scoring against gold
            rev = {v: k for k, v in sid_map.items()}
            retrieved_sessions = [rev.get(h.session_id, h.session_id) for h in hits if h.session_id]
        except Exception as e:
            print(f"  [query err {inst['question_id']}] {type(e).__name__}: {str(e)[:150]}")
            retrieved_sessions = []
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
        "system": "honcho",
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
    (BENCH / "logs" / f"honcho-lane-a-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"honcho-lane-a-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== HONCHO LANE A METRICS ===")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
