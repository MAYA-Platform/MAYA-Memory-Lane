#!/usr/bin/env python3
"""LangMem — Lane A: Retrieval Recall benchmark runner (native pipeline).

Mirror of run_lane_a_honcho.py / run_lane_a_ml.mjs. Same LongMemEval oracle
instances, same queries, same gold standard, same scoring semantics.

Fair-mirror design (how LangMem is actually used, not a strawman):
  - Extraction: langmem.create_memory_manager (their schema-based LLM extraction,
    the product's core claim) via DeepSeek v4-flash through Merge Gateway.
  - Storage: langgraph InMemoryStore with semantic index (bge-m3 via Ollama,
    local, free — same embeddings cost class as our own lane).
  - Search: store.search(query=<raw question>) — same raw-query search shape
    Honcho's peer.search and Mem0's search use.
  - Retrieval unit: haystack session id (extracted memories carry session_id
    metadata; a question's gold sessions are scored against the ranked
    session ids derived from retrieved memories).

Note on extraction cost: one LLM call per session via Merge (~$0.00004) —
the full 940-session ingest is well under $0.10.

Usage:
  python run_lane_a_langmem.py [--items N] [--dataset PATH] [--model MODEL]
"""
import argparse
import asyncio
import hashlib
import json
import os
import time
import sys
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from llm_backend import _load_merge_config  # noqa: E402

from langgraph.store.memory import InMemoryStore  # noqa: E402
from langmem import create_memory_manager  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402


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


def make_embed_fn():
    """bge-m3 via Ollama /api/embed — local, free, 1024-dim."""
    import urllib.request

    def embed(texts):
        payload = json.dumps({"model": "bge-m3", "input": texts}).encode()
        req = urllib.request.Request(
            "http://127.0.0.1:11434/api/embed", data=payload,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read())
        return d["embeddings"]

    return embed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=500)
    ap.add_argument("--dataset", default=str(BENCH / "datasets" / "longmemeval_oracle.json"))
    ap.add_argument("--model", default="gpt-4o-mini")
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    # LLM (DeepSeek) + store (InMemory, bge-m3 via Ollama)
    cfg = _load_merge_config()
    llm = ChatOpenAI(
        model=args.model,
        api_key=cfg["api_key"],
        base_url=cfg["base_url"],
        max_tokens=1024,
        timeout=180,
    )
    store = InMemoryStore(index={"dims": 1024, "embed": make_embed_fn()})
    manager = create_memory_manager(llm, enable_updates=False, enable_deletes=False)

    # --- Ingest: each haystack session = extraction -> flat memories w/ session_id
    print(f"[ingest] {len(dataset)} instances -> LangMem memory store (extraction via {args.model})")
    t0 = time.time()
    ingested = 0
    mem_total = 0
    errs = 0
    for inst in dataset:
        for si, sess in enumerate(inst["haystack_sessions"]):
            hsid = inst["haystack_session_ids"][si]
            msgs = [{"role": t["role"], "content": t["content"]} for t in sess]
            try:
                extracted = asyncio.run(manager.ainvoke({"messages": msgs}))
                for m in extracted:
                    # m is ExtractedMemory; m.content is a Memory(value) object
                    mem_val = getattr(m, "content", None)
                    content = getattr(mem_val, "content", None) or getattr(mem_val, "value", None) or str(mem_val)
                    store.put(
                        ("memories", "lme"),
                        key=f"{hsid}_{mem_total}_{si}",
                        value={"content": content, "session_id": hsid},
                    )
                    mem_total += 1
                ingested += 1
            except Exception as e:
                errs += 1
                if errs <= 5:
                    print(f"  [ingest err {hsid}] {type(e).__name__}: {str(e)[:150]}")
        if (ingested + errs) % 200 == 0 and (ingested + errs) > 0:
            print(f"  [ingest] {ingested+errs} sessions ({time.time()-t0:.0f}s, {mem_total} memories)")
    print(f"[ingest] {ingested} sessions, {mem_total} memories, {errs} errs in {time.time()-t0:.1f}s")

    # --- Query: raw question via store semantic search -> session ids
    print(f"[run] {len(dataset)} questions via store.search")
    results = []
    for i, inst in enumerate(dataset):
        gold = inst.get("answer_session_ids") or []
        q = inst["question"]
        retrieved_sessions = []
        try:
            items = store.search(("memories", "lme"), query=q, limit=25)
            seen = set()
            for it in items:
                sid = it.value.get("session_id") if isinstance(it.value, dict) else None
                if sid and sid not in seen:
                    seen.add(sid)
                    retrieved_sessions.append(sid)
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
        "system": "langmem",
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
    (BENCH / "logs" / f"langmem-lane-a-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"langmem-lane-a-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== LANGMEM LANE A METRICS ===")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
