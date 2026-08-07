#!/usr/bin/env python3
"""Graphiti — Lane A: Retrieval Recall benchmark runner (native pipeline).

Mirror of run_lane_a_honcho.py. Same LongMemEval oracle instances, same
queries, same gold standard, same scoring semantics.

Fair-mirror design (Graphiti's real product — temporal knowledge graph):
  - Graph: Neo4j (must be running; see start_neo4j note).
  - Ingest: each haystack session ingested as one EPISODE via
    graphiti.ingest_episode(episode=..., group_id=session_id) — group_id is
    Graphiti's native partition key, which we set to the haystack session id.
  - Search: graphiti.search(query, group_ids=...) — hybrid semantic+BM25+graph
    retrieval, the product's core claim. Returns EntityEdge facts.
  - Retrieval unit: haystack session id (via group_id on returned facts).

Note: Graphiti is a temporal-graph system; its search returns *facts* (edges),
not sessions. We map facts back to sessions via group_id. LLM extraction and
embedding run through the clients passed at construction (gpt-4o-mini via
Merge for LLM, bge-m3 via Ollama for embeddings — same cost class as other
lanes). This is Graphiti's real ingestion pipeline (it always extracts
entities/facts from raw episodes).

Usage:
  python run_lane_a_graphiti.py [--items N] [--dataset PATH] [--uri bolt://localhost:7687] [--user neo4j] [--password PASSWORD]
"""
import argparse
import asyncio
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from llm_backend import _load_merge_config  # noqa: E402


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
    ap.add_argument("--uri", default="bolt://localhost:7687")
    ap.add_argument("--user", default="neo4j")
    ap.add_argument("--password", default="password")
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    cfg = _load_merge_config()

    # LLM + embedder clients — gpt-4o-mini via Merge, bge-m3 via Ollama
    try:
        from graphiti_core.llm_client import OpenAIClient, LLMConfig
        from graphiti_core.embedder import OpenAIEmbedder, EmbedderConfig
        from graphiti_core.graphiti import Graphiti
        llm = OpenAIClient(
            LLMConfig(
                model="gpt-4o-mini",
                api_key=cfg["api_key"],
                base_url=cfg["base_url"],
            )
        )
        embedder = OpenAIEmbedder(
            EmbedderConfig(
                model="bge-m3",
                api_key="ollama",  # bge-m3 served by Ollama; driver points at it
                base_url="http://127.0.0.1:11434",
                dims=1024,
            )
        )
    except Exception as e:
        print(f"FATAL: graphiti import/config failed: {e}")
        print("Is graphiti-core installed and is Neo4j running?")
        sys.exit(2)

    print(f"[neo4j] {args.uri} as {args.user}")
    try:
        g = Graphiti(uri=args.uri, user=args.user, password=args.password,
                     llm_client=llm, embedder=embedder)
    except Exception as e:
        print(f"FATAL: cannot connect to Neo4j at {args.uri}: {e}")
        sys.exit(2)

    # --- Ingest: each haystack session = one episode, group_id = session id
    print(f"[ingest] {len(dataset)} instances -> Graphiti (Neo4j, gpt-4o-mini, bge-m3)")
    t0 = time.time()
    ingested = 0
    errs = 0
    for inst in dataset:
        for si, sess in enumerate(inst["haystack_sessions"]):
            hsid = inst["haystack_session_ids"][si]
            # Graphiti episode: list of dialog turns with role/content
            episode = [
                {"role": t["role"], "content": t["content"]} for t in sess
            ]
            try:
                asyncio.run(g.ingest_episode(episode=episode, group_id=hsid))
                ingested += 1
            except Exception as e:
                errs += 1
                if errs <= 5:
                    print(f"  [ingest err {hsid}] {type(e).__name__}: {str(e)[:150]}")
        if (ingested + errs) % 100 == 0 and (ingested + errs) > 0:
            print(f"  [ingest] {ingested+errs} sessions ({time.time()-t0:.0f}s)")
    print(f"[ingest] {ingested} sessions, {errs} errs in {time.time()-t0:.1f}s")

    # --- Query: raw question via hybrid search -> session ids from group_id
    print(f"[run] {len(dataset)} questions via Graphiti search")
    results = []
    for i, inst in enumerate(dataset):
        gold = inst.get("answer_session_ids") or []
        q = inst["question"]
        retrieved_sessions = []
        try:
            edges = asyncio.run(g.search(query=q, num_results=25))
            seen = set()
            for e in edges:
                gid = getattr(e, "group_id", None)
                if gid and gid not in seen:
                    seen.add(gid)
                    retrieved_sessions.append(gid)
        except Exception as ex:
            print(f"  [query err {inst['question_id']}] {type(ex).__name__}: {str(ex)[:150]}")
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
        "system": "graphiti",
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
    (BENCH / "logs" / f"graphiti-lane-a-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"graphiti-lane-a-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== GRAPHITI LANE A METRICS ===")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
