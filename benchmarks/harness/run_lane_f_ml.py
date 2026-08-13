#!/usr/bin/env python3
"""Lane F — Paired-LLM QA accuracy (Memory Lane + local LLM pipeline).

The industry-standard metric (what Honcho/Mem0 brag about): retrieve context,
feed to an LLM answerer, judge the answer against the gold standard using
LongMemEval's official evaluate_qa.py prompt templates.

This measures the FULL PIPELINE (memory store + LLM answerer), clearly labeled
as such — NOT the store alone. Memory Lane retrieves top-k sessions via FTS5,
the LLM answers from that context, and the judge scores correctness.

Cost: ZERO (local Ollama). Slow: ~10-15s/question on RX 580.

Usage:
  python run_lane_f_ml.py [--items N] [--k 5] [--model qwen3:4b]
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_backend as L

BENCH = Path(__file__).resolve().parent.parent

# LongMemEval official answer-check prompts (from evaluate_qa.py, kept verbatim)
ANSCHECK_TEMPLATES = {
    'single-session-user': (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no.\n\n"
        "Question: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    'multi-session': (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no.\n\n"
        "Question: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    'temporal-reasoning': (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no. "
        "In addition, do not penalize off-by-one errors for the number of days.\n\n"
        "Question: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    'knowledge-update': (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response contains some previous information along with an updated answer, the "
        "response should be considered as correct as long as the updated answer is the required "
        "answer.\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    'single-session-preference': (
        "I will give you a question, a rubric for desired personalized response, and a response "
        "from a model. Please answer yes if the response satisfies the desired response. "
        "Otherwise, answer no. The model does not need to reflect all the points in the rubric. "
        "The response is correct as long as it recalls and utilizes the user's personal "
        "information correctly.\n\nQuestion: {q}\n\nRubric: {a}\n\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
}
ABSTAIN_TEMPLATE = (
    "I will give you an unanswerable question, an explanation, and a response from a model. "
    "Please answer yes if the model correctly identifies the question as unanswerable. "
    "The model could say that the information is incomplete, or some other information is given "
    "but the asked information is not.\n\nQuestion: {q}\n\nExplanation: {a}\n\nModel Response: {r}\n\n"
    "Does the model correctly identify the question as unanswerable? Answer yes or no only."
)

# Map LongMemEval question_type -> answer-check template key
TYPE_MAP = {
    'single-session-user': 'single-session-user',
    'single-session-assistant': 'single-session-user',
    'single-session-preference': 'single-session-preference',
    'multi-session': 'multi-session',
    'temporal-reasoning': 'temporal-reasoning',
    'knowledge-update': 'knowledge-update',
}


def llm(prompt, model, backend, max_tokens=800):
    """Route through the backend abstraction."""
    out, _ = L.strip_cost(L.llm_call(prompt, backend=backend, model=model, max_tokens=max_tokens))
    return out


def judge(q, answer, response, qtype, backend, model=None):
    """Use LongMemEval's official judge prompt. Returns 'yes'/'no'."""
    is_abs = qtype.endswith('_abs') or '_abs' in qtype
    if is_abs:
        prompt = ABSTAIN_TEMPLATE.format(q=q, a=answer, r=response)
    else:
        key = TYPE_MAP.get(qtype, 'single-session-user')
        prompt = ANSCHECK_TEMPLATES[key].format(q=q, a=answer, r=response)
    out = llm(prompt, model if backend == "local" else model, backend, max_tokens=500).lower()
    # strip thinking-prefix junk and take first yes/no token
    m = re.search(r'\b(yes|no)\b', out)
    return m.group(1) if m else ("yes" if out.strip().startswith("yes") else "no")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=100)
    ap.add_argument("--k", type=int, default=10, help="top-k sessions retrieved")
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--backend", default="local", choices=["local", "merge"], help="LLM backend: local (Ollama) or merge (main provider)")
    ap.add_argument("--rerank", action="store_true", help="U6: LLM-rerank candidates before answering")
    ap.add_argument("--model-override", default="", help="explicit model for merge backend (e.g. deepseek/deepseek-v4-flash)")
    ap.add_argument("--lib", default="", help="library dir to search (default: ml-lane-f)")
    ap.add_argument("--dataset", default=str(BENCH / "datasets" / "longmemeval_oracle.json"))
    args = ap.parse_args()

    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))[: args.items]

    # 1. Build the Memory Lane FTS library (reuse if present)
    lib_dir = Path(args.lib) if args.lib else BENCH / "libraries" / "ml-lane-f"
    CURRENT_LIB_DIR[0] = str(lib_dir)
    if not (lib_dir / "MANIFEST.json").exists():
        build = BENCH / "harness" / "_build_fts_library.mjs"
        p = subprocess.run(["node", str(build), str(args.dataset), str(lib_dir)],
                           capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            print("FTS library build failed:", p.stderr[-500:])
            sys.exit(1)
        print(p.stdout.strip())

    results = []
    t0 = time.time()
    for i, inst in enumerate(dataset):
        q = inst["question"]
        gold = inst.get("answer_session_ids") or []
        qtype = inst.get("question_type", "")
        answer = inst.get("answer", "")

        # Retrieve top-k sessions via Memory Lane FTS5 (node helper)
        ret = _retrieve(q, args.k)
        # U6: LLM-rerank the candidates before building context
        if args.rerank and ret:
            ret = rerank(q, ret, args.backend, args.model if args.backend == "local" else (args.model_override or None), top_n=6)
        context = _format_context(ret)

        # U7: Chain-of-Note answer prompt (evidence-then-answer)
        answer_prompt = ANSWER_PROMPT_CON.format(context=context, q=q)
        # merge (v4-pro thinking) burns output budget on evidence notes — needs
        # 2000+ tokens; local qwen is fine at 800.
        ans_tokens = 2000 if args.backend == "merge" else 800
        response = llm(answer_prompt, args.model if args.backend == "local" else (args.model_override or None), args.backend, max_tokens=ans_tokens)

        # Judge with LongMemEval official logic
        verdict = judge(q, answer, response, qtype, args.backend, args.model if args.backend == "local" else (args.model_override or None))
        correct = verdict == "yes"
        # Secondary deterministic check: gold answer substring appears in the
        # response (or its FINAL ANSWER line). The 3-4B local judge is
        # unreliable; substring containment is a fair, reproducible supplement.
        final_line = response
        for ln in response.splitlines():
            if ln.strip().upper().startswith("FINAL ANSWER"):
                final_line = ln.split(":", 1)[1] if ":" in ln else ln
                break
        gold_norm = str(answer).lower().strip()
        resp_norm = str(final_line).lower()
        contains = bool(gold_norm) and gold_norm[:40] in resp_norm
        correct_substring = correct or contains

        results.append({
            "question_id": inst["question_id"],
            "question_type": qtype,
            "question": q,
            "gold_answer": answer,
            "model_response": response[:400],
            "judge_verdict": verdict,
            "correct": correct,
            "contains_gold": contains,
            "correct_substring": correct_substring,
        })
        if (i + 1) % 10 == 0:
            el = time.time() - t0
            acc = sum(r["correct"] for r in results) / len(results)
            acc2 = sum(r["correct_substring"] for r in results) / len(results)
            print(f"  [{i+1}/{len(dataset)}] acc={acc:.3f} acc_substr={acc2:.3f} elapsed={el:.0f}s")

    acc = sum(r["correct"] for r in results) / len(results) if results else 0
    acc_sub = sum(r["correct_substring"] for r in results) / len(results) if results else 0
    metrics = {
        "run_id": run_id,
        "system": "memory-lane + llm",
        "backend": args.backend,
        "model": args.model if args.backend == "local" else ("merge-default (deepseek-v4-pro)" if not args.model_override else args.model_override),
        "k": args.k,
        "instances": len(results),
        "qa_accuracy": acc,
        "qa_accuracy_substring": acc_sub,
        "correct": sum(r["correct"] for r in results),
        "correct_substring": sum(r["correct_substring"] for r in results),
        "dataset_sha256": hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest(),
        "note": "Paired pipeline: Memory Lane FTS5 retrieval + LLM answerer + LongMemEval official judge. Backend selectable (local Ollama or Merge main model). qa_accuracy uses model judge; qa_accuracy_substring adds deterministic gold-substring containment.",
    }
    (BENCH / "logs").mkdir(exist_ok=True)
    (BENCH / "results").mkdir(exist_ok=True)
    (BENCH / "logs" / f"lane-f-{run_id}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")
    (BENCH / "results" / f"lane-f-{run_id}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    print("\n=== LANE F (MEMORY LANE + LOCAL LLM) QA ACCURACY ===")
    print(json.dumps(metrics, indent=2))


# Module-global library dir (set from --lib in main)
CURRENT_LIB_DIR = [str(BENCH / "libraries" / "ml-lane-f")]


def _retrieve(query, k):
    """Run the node FTS search helper; returns list of {lib_id, session_id, excerpt}."""
    script = BENCH / "harness" / "_fts_search.mjs"
    lib_dir = CURRENT_LIB_DIR[0]
    p = subprocess.run(
        ["node", str(script), query, str(k), str(lib_dir)],
        capture_output=True, text=True, timeout=120, cwd=str(BENCH / "harness"))
    try:
        out = p.stdout.strip().split("\n")[-1]
        return json.loads(out)
    except Exception:
        return []


def rerank(query, records, backend, model=None, top_n=6):
    """U6 (Mem0 LLMReranker pattern): score each record 0.0-1.0 relevance to the
    query, keep the top_n. One LLM call per record (cheap). Returns reranked
    records (best first) with a rerank_score field."""
    if not records:
        return records
    scored = []
    for r in records:
        doc = (r.get('body') or r.get('excerpt') or '')[:2500]
        prompt = (
            "You are a relevance scoring assistant. Given a query and a document, "
            "score how relevant the document is to the query on a scale from 0.0 to 1.0 "
            "(1.0 = perfectly relevant and directly answers the query; 0.0 = not relevant). "
            "Respond with only a single numerical score between 0.0 and 1.0, nothing else.\n\n"
            f"Query: {query}\n\nDocument: {doc}\n\nScore:"
        )
        out = llm(prompt, model if backend == "local" else None, backend, max_tokens=500)
        m = re.search(r'(\d+\.\d+|\d+)', out)
        score = min(max(float(m.group(1)), 0.0), 1.0) if m else 0.5
        scored.append({**r, "rerank_score": score})
    scored.sort(key=lambda x: x["rerank_score"], reverse=True)
    return scored[:top_n]


# U7 (LongMemEval Chain-of-Note): extract evidence per record, then answer.
# Demands a clean FINAL ANSWER line after the evidence notes so the judge gets
# a parseable answer (and truncation doesn't lose it).
ANSWER_PROMPT_CON = """You are recalling facts from a user's private memory library. The records below are retrieved search results.

STEP 1 — For EACH record, copy the specific evidence in it that relates to the question (or write "no relevant evidence").
STEP 2 — Based ONLY on the evidence you copied, answer the question concisely.
If NO record contains the answer, say "not in memory" — do not guess or fabricate.

End with a line exactly like: FINAL ANSWER: <your concise answer>

RECORDS (ordered by recency):
{context}

QUESTION: {q}

EVIDENCE NOTES:
"""


def _format_context(ret):
    if not ret:
        return "(no context retrieved)"
    parts = []
    # U7: sort by block timestamp (recency) so the reader sees time order
    sorted_ret = sorted(ret, key=lambda r: r.get('created_at') or r.get('lib_id') or 0)
    for i, r in enumerate(sorted_ret[:6], 1):
        # Use the full body (retrieval found the session; truncation was losing
        # answers buried mid-transcript). Fall back to excerpt.
        ex = r.get('body') or r.get('excerpt') or ''
        ex = ex[:2400]
        ex = ex.strip()
        ts = r.get('created_at') or '?'
        parts.append(f"--- Record {i} (session {r.get('session_id','?')}, time {ts}) ---\n{ex}")
    return "\n\n".join(parts)


if __name__ == "__main__":
    main()
