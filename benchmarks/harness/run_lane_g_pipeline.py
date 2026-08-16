#!/usr/bin/env python3
"""Lane G — Auto-Observation pipeline benchmark: ours vs Honcho (on/off).

Tests the FULL Auto-Observation pipeline (Observer → Store → Distiller →
Injector) against Honcho, with the hosted service toggled on/off.

Protocol (pre-registered in BENCHMARK_PROTOCOL.md §Lane G):
  1. Ingests LongMemEval sessions into a Memory Lane library.
  2. Runs the deterministic Observer over every haystack message →
     observations.jsonl.
  3. Runs the Distiller (DeepSeek) → DERIVED.md + PROFILE_SNAPSHOT.md.
  4. For each question, answers with THREE conditions, same answerer model
     (DeepSeek v4-flash via DeepSeek), judged by gold-answer containment:
       - baseline : no memory context (zero-shot)
       - ours     : FTS5 retrieval + ML observation snapshot + derived profile
       - honcho   : FTS5 retrieval + Honcho peer context (hosted service ON)
  5. Reports accuracy per condition. Delta(ours - baseline) = injection
     usefulness of the local pipeline. Delta(ours - honcho) = parity check.

Usage:
  python run_lane_g_pipeline.py [--items 30] [--lib <dir>] [--honcho]
  --honcho: also run the Honcho condition (requires HONCHO_API_KEY)
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BENCH / "harness"))
import llm_backend as L

DATASET = BENCH / "datasets" / "longmemeval_oracle.json"
DEFAULT_LIB = BENCH / "libraries" / "ml-lane-a"

ANSWER_PROMPT = """Answer the question based ONLY on the provided context. If the context does not contain the answer, say "I don't know". Be concise.

CONTEXT:
{context}

QUESTION: {question}

ANSWER:"""


def load_gold_answers(items):
    """Gold answer strings per question for substring judging."""
    out = {}
    for inst in items:
        out[inst["question_id"]] = inst.get("answer", "")
    return out


def judge(response, gold):
    """Deterministic gold-substring containment (same as Lane F)."""
    if not gold or not response:
        return 0.0
    gold_norm = re.sub(r"\s+", " ", gold.lower()).strip()
    resp_norm = re.sub(r"\s+", " ", response.lower()).strip()
    if not gold_norm:
        return 0.0
    # exact or near-exact substring (allow minor whitespace diffs)
    if gold_norm in resp_norm:
        return 1.0
    # token-level containment of the first 4 gold tokens
    toks = gold_norm.split()[:4]
    if len(toks) >= 3 and all(t in resp_norm for t in toks):
        return 1.0
    return 0.0


JUDGE_PROMPT = """You are grading whether an AI answer to a memory question is CORRECT given the gold answer. Answer only YES or NO.

QUESTION: {question}
GOLD ANSWER: {gold}
AI ANSWER: {answer}

Is the AI answer correct (same fact, entity, or value as the gold answer, even if worded differently)? Say YES or NO."""


def judge_llm(question, response, gold):
    """LLM judge (DeepSeek via DeepSeek) — tolerant of paraphrase. Falls back to
    substring judge when the LLM call fails. Returns 1.0/0.0."""
    if not gold or not response:
        return 0.0
    # Fast path: substring containment already agrees
    fast = judge(response, gold)
    if fast == 1.0:
        return 1.0
    if len(response) < 5 or response.lower().startswith("i don't know"):
        return 0.0
    out, _ = L.strip_cost(L.llm_call(
        JUDGE_PROMPT.format(question=question[:400], gold=gold[:200], answer=response[:400]),
        backend="deepseek", max_tokens=500,
    ))
    verdict = (out or "").strip().upper()
    if verdict.startswith("YES"):
        return 1.0
    if verdict.startswith("NO"):
        return 0.0
    return fast  # fallback


def load_snapshot(lib_dir):
    """Load ML observation snapshot + derived profile (Injector output)."""
    obs_file = lib_dir / "observations.jsonl"
    obs = []
    if obs_file.exists():
        for line in obs_file.read_text(encoding="utf-8").splitlines():
            try:
                o = json.loads(line)
                obs.append(f"[{o.get('cls','?')}] {o.get('excerpt','')[:150]}")
            except json.JSONDecodeError:
                continue
    snapshot = "\n".join(f"- {o}" for o in obs[-300:]) if obs else "(no observations)"
    derived = ""
    derived_file = lib_dir / "DERIVED.md"
    if derived_file.exists():
        lines = [l.strip().lstrip("-• ").strip() for l in derived_file.read_text(encoding="utf-8").splitlines()
                 if l.strip().startswith("-")]
        derived = "\n".join(f"- {l}" for l in lines[:10])
    return snapshot, derived


def fts_retrieve(query, lib_dir, top=3, hybrid=True):
    """FTS5 (+Vertex dense via RRF when available) retrieve.
    Returns (raw_blocks, fact_sections). Fact sections are the '## Extracted
    facts' part of each retrieved block — the distilled answer-bearing content
    (Lane F finding: raw transcripts bury answers, facts make them findable)."""
    import subprocess
    use_hybrid = hybrid and os.environ.get("VERTEX_ACCESS_TOKEN")
    script = "hybrid_retrieve.mjs" if use_hybrid else "fts_retrieve.mjs"
    p = subprocess.run(
        ["node", script, query, str(lib_dir), str(top)],
        capture_output=True, text=True, cwd=str(BENCH / "harness"), timeout=90,
        env={**os.environ},
    )
    try:
        raw_blocks = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        raw_blocks = []
    facts = []
    for b in raw_blocks:
        m = re.search(r"## Extracted facts\s*\n([\s\S]*)$", b)
        if m:
            for line in m.group(1).splitlines():
                line = line.strip().lstrip("-• ").strip()
                if len(line) > 8:
                    facts.append(line)
    return raw_blocks, facts[:40]


def honcho_context(query, api_key, limit=5):
    """Honcho search — hosted service ON (v3 SDK)."""
    from honcho import Honcho
    client = Honcho(api_key=api_key)
    try:
        results = client.search(query, limit=limit)
    except Exception as e:
        return f"(honcho search error: {str(e)[:80]})"
    ctx = []
    for r in results:
        content = getattr(r, "content", None) or str(r)
        sid = getattr(r, "session_id", "?")
        ctx.append(f"[{sid}] {str(content)[:200]}")
    return "\n".join(f"- {c}" for c in ctx) if ctx else "(no honcho context)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", type=int, default=30)
    ap.add_argument("--lib", default=str(DEFAULT_LIB))
    ap.add_argument("--honcho", action="store_true", help="run Honcho condition")
    ap.add_argument("--honcho-key", default="", help="Honcho API key (or set HONCHO_API_KEY)")
    args = ap.parse_args()

    dataset = json.loads(DATASET.read_text(encoding="utf-8"))[: args.items]
    gold = load_gold_answers(dataset)
    lib_dir = Path(args.lib)

    # Pre-run Observer + Distiller if observations are missing
    obs_file = lib_dir / "observations.jsonl"
    if not obs_file.exists() or obs_file.stat().st_size == 0:
        print("[lane-g] no observations — running Observer...")
        import subprocess
        p = subprocess.run(["node", "run_observer_dataset.mjs", "--items", str(args.items),
                            "--lib", str(lib_dir)], capture_output=True, text=True, cwd=BENCH / "harness", timeout=300)
        print(p.stdout.strip())
        if p.returncode != 0:
            print(p.stderr[-500:])
    if not (lib_dir / "DERIVED.md").exists():
        print("[lane-g] no DERIVED.md — running Distiller...")
        p = subprocess.run([sys.executable, "distill_observations.py", "--lib", str(lib_dir), "--backend", "deepseek"],
                           capture_output=True, text=True, cwd=BENCH / "harness", timeout=600)
        print(p.stdout.strip()[-800:])

    snapshot, derived = load_snapshot(lib_dir)

    # Honcho ingest (once) if enabled
    if args.honcho:
        from honcho import Honcho, MessageCreateParams
        api_key = args.honcho_key or os.environ.get("HONCHO_API_KEY", "")
        if not api_key:
            print("[lane-g] Honcho condition requires HONCHO_API_KEY (or --honcho-key). Skipping.")
            args.honcho = False
        else:
            client = Honcho(api_key=api_key)
            print("[lane-g] ingesting into Honcho...")
            for inst in dataset[: args.items]:
                for si, sess in enumerate(inst["haystack_sessions"]):
                    sess_id = f"laneG_{inst['question_id']}_{si}"
                    try:
                        session = client.session(sess_id)
                    except Exception:
                        session = client.session(sess_id)
                    for turn in sess:
                        try:
                            session.add_messages([MessageCreateParams(content=turn["content"], peer_id="benchmark")])
                        except Exception as e:
                            print(f"  honcho ingest err: {str(e)[:60]}")

    results = []
    t0 = time.time()
    for i, inst in enumerate(dataset):
        qid = inst["question_id"]
        q = inst["question"]
        ctx, facts = fts_retrieve(q, lib_dir)
        fts_text = "\n\n".join(ctx[:2]) if ctx else "(no retrieval)"
        facts_text = "\n".join(f"- {f}" for f in facts[:30]) if facts else ""

        # Condition A: baseline (zero-shot, no memory)
        a = L.strip_cost(L.llm_call(ANSWER_PROMPT.format(context="(no context)", question=q),
                                    backend="deepseek", max_tokens=800))[0]

        # Condition B: ours (facts + ML snapshot + derived profile)
        ours_ctx = f"RETRIEVED FACTS:\n{facts_text or '(none)'}"
        ours_ctx += f"\n\nRETRIEVED MEMORY:\n{fts_text}"
        ours_ctx += f"\n\nSESSION SNAPSHOT:\n{snapshot}"
        if derived:
            ours_ctx += f"\n\nDERIVED PROFILE:\n{derived}"
        b = L.strip_cost(L.llm_call(ANSWER_PROMPT.format(context=ours_ctx, question=q),
                                    backend="deepseek", max_tokens=800))[0]

        # Condition C: honcho (hosted ON)
        c = None
        if args.honcho:
            h_ctx = honcho_context(q, api_key)
            honcho_ctx = f"RETRIEVED FACTS:\n{facts_text or '(none)'}\n\nRETRIEVED MEMORY:\n{fts_text}\n\nHONCHO CONTEXT:\n{h_ctx}"
            c = L.strip_cost(L.llm_call(ANSWER_PROMPT.format(context=honcho_ctx, question=q),
                                        backend="deepseek", max_tokens=800))[0]

        g = gold.get(qid, "")
        row = {
            "question_id": qid,
            "baseline": judge_llm(q, a, g),
            "ours": judge_llm(q, b, g),
            "honcho": judge_llm(q, c, g) if c is not None else None,
            "question": q[:80],
            "baseline_answer": (a or "")[:150],
            "ours_answer": (b or "")[:150],
            "honcho_answer": (c or "")[:150] if c is not None else None,
        }
        results.append(row)
        if (i + 1) % 5 == 0:
            print(f"[{i+1}/{len(dataset)}] elapsed={time.time()-t0:.0f}s")

    n = len(results)
    base = sum(r["baseline"] for r in results) / n
    ours = sum(r["ours"] for r in results) / n
    hrow = [r for r in results if r["honcho"] is not None]
    honcho = sum(r["honcho"] for r in hrow) / len(hrow) if hrow else None

    metrics = {
        "run_id": time.strftime("%Y-%m-%dT%H-%M-%S"),
        "system": "memory-lane-auto-observation",
        "instances": n,
        "baseline_accuracy": base,
        "ours_accuracy": ours,
        "ours_delta_over_baseline": ours - base,
        "honcho_accuracy": honcho,
        "ours_vs_honcho_delta": (ours - honcho) if honcho is not None else None,
        "honcho_enabled": args.honcho,
        "notes": "deterministic gold-substring judge; DeepSeek v4-flash via DeepSeek answerer",
    }
    (BENCH / "results" / f"lane-g-pipeline-{metrics['run_id']}.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")
    (BENCH / "logs" / f"lane-g-pipeline-{metrics['run_id']}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results), encoding="utf-8")

    print("\n=== LANE G — AUTO-OBSERVATION PIPELINE ===")
    print(f"baseline (no memory): {base*100:.1f}%")
    print(f"ours (ML observer+distiller+injector): {ours*100:.1f}%  delta={metrics['ours_delta_over_baseline']*100:+.1f}pt")
    if honcho is not None:
        print(f"honcho (hosted ON): {honcho*100:.1f}%  delta_vs_ours={metrics['ours_vs_honcho_delta']*100:+.1f}pt")
    print(JSON := json.dumps(metrics, indent=2))
    (BENCH / "results" / "LANE_G_LATEST.json").write_text(JSON, encoding="utf-8")


if __name__ == "__main__":
    main()
