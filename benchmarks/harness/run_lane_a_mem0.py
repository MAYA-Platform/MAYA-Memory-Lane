#!/usr/bin/env python3
"""Mem0 — Lane A: Retrieval Recall benchmark runner (native pipeline).

Mirror of run_lane_a_honcho.py. Same LongMemEval oracle instances, same
queries, same gold standard, same scoring semantics.

Fair-mirror design (Mem0's real product pipeline, not a strawman):
  - add(messages, user_id=session_id): Mem0's native LLM extraction + storage.
    Extraction model: gpt-4o-mini via DeepSeek. NOTE: DeepSeek v4-flash
    via DeepSeek returns content in the `thinking` field, which Mem0's extraction
    parser reads as empty (extracts nothing). gpt-4o-mini is OpenAI-native and
    is also the family Mem0's own benchmarks use (GPT-4o), so this is a
    conservative, comparable setup.
  - Embedder: Ollama bge-m3 (local, free — same cost class as our own lane).
  - Vector store: Chroma (local, zero server).
  - search(query): Mem0's native multi-signal retrieval per user.
  - Retrieval unit: haystack session id (via user_id, which we set to the
    haystack session id at ingest).

Cost: one extraction LLM call per session via DeepSeek (~$0.00004) — the full
940-session ingest is well under $0.10.

Usage:
  python run_lane_a_mem0.py [--items N] [--dataset PATH] [--model MODEL] [--clean]
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from llm_backend import _load_deepseek_config  # noqa: E402

from mem0 import Memory  # noqa: E402


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
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--clean", action="store_true", help="wipe chroma dir before ingest")
    ap.add_argument("--query-only", action="store_true", help="skip ingest; query existing chroma store")
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    cfg = _load_deepseek_config()
    chroma_path = str(BENCH / "libraries" / "mem0-chroma")
    if args.clean and not args.query_only and Path(chroma_path).exists():
        shutil.rmtree(chroma_path, ignore_errors=True)
        print("[clean] wiped chroma dir")

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    m = Memory.from_config({
        "llm": {
            "provider": "openai",
            "config": {
                "model": args.model,
                "api_key": cfg["api_key"],
                "openai_base_url": cfg["base_url"],
                "max_tokens": 1024,
                "temperature": 0,
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": "bge-m3",
                "ollama_base_url": "http://127.0.0.1:11434",
                "embedding_dims": 1024,
            },
        },
        "vector_store": {
            "provider": "chroma",
            "config": {
                "collection_name": "lme",
                "path": chroma_path,
            },
        },
        "version": "v1.1",
    })

    # --- Ingest: all sessions under one user, memories tagged w/ session_id
    if args.query_only:
        print(f"[ingest] SKIP (--query-only) — using existing chroma store at {chroma_path}")
    else:
        print(f"[ingest] {len(dataset)} instances -> Mem0 (chroma local, bge-m3, {args.model})")
        t0 = time.time()
        ingested = 0
        errs = 0
        for inst in dataset:
            for si, sess in enumerate(inst["haystack_sessions"]):
                hsid = inst["haystack_session_ids"][si]
                msgs = [{"role": t["role"], "content": t["content"]} for t in sess]
                try:
                    m.add(msgs, user_id="lme", metadata={"session_id": hsid})
                    ingested += 1
                except Exception as e:
                    errs += 1
                    if errs <= 5:
                        print(f"  [ingest err {hsid}] {type(e).__name__}: {str(e)[:150]}")
            if (ingested + errs) % 200 == 0 and (ingested + errs) > 0:
                print(f"  [ingest] {ingested+errs} sessions ({time.time()-t0:.0f}s)")
        print(f"[ingest] {ingested} sessions, {errs} errs in {time.time()-t0:.1f}s")

    # --- Query: raw question via Mem0 search (user=lme) -> map via metadata
    print(f"[run] {len(dataset)} questions via Mem0 search")
    results = []
    for i, inst in enumerate(dataset):
        gold = inst.get("answer_session_ids") or []
        q = inst["question"]
        retrieved_sessions = []
        try:
            resp = m.search(q, filters={"user_id": "lme"}, top_k=25)
            # resp is a dict: {"results": [{memory, metadata, score, ...}, ...]}
            hits = resp.get("results", []) if isinstance(resp, dict) else resp
            seen = set()
            for h in hits:
                if not isinstance(h, dict):
                    continue
                uid = None
                md = h.get("metadata") or {}
                if isinstance(md, dict):
                    uid = md.get("session_id")
                if uid and uid not in seen:
                    seen.add(uid)
                    retrieved_sessions.append(uid)
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
        "system": "mem0",
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
    (BENCH / "logs" / f"mem0-lane-a-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"mem0-lane-a-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== MEM0 LANE A METRICS ===")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
