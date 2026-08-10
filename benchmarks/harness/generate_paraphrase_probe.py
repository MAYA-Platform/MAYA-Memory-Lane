#!/usr/bin/env python3
"""Generate the paraphrase probe for Lane H.

Takes the first N LongMemEval questions and produces a paraphrase of each
(different words, same meaning) using the Merge/DeepSeek backend. The gold
answer sessions are carried over unchanged, so we can measure whether
retrieval still finds the right session when the question says the same
thing in different words.

Output: datasets/paraphrase_probe.json
  [{ question_id, question, paraphrase, answer_session_ids, question_type }]
"""
import json
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from llm_backend import llm_call, strip_cost

BENCH = Path(__file__).parent.parent
DATASET = BENCH / "datasets" / "longmemeval_oracle.json"
OUT = BENCH / "datasets" / "paraphrase_probe.json"
N = int(os.environ.get("PROBE_N", "100"))

PROMPT_TMPL = """Rewrite the following question so it means EXACTLY the same thing but uses completely different words. This is for testing semantic search: the answer content stays the same but no keywords should overlap.

Rules:
- Same meaning, same target answer.
- Change the key nouns/verbs (synonyms, rephrasing). Avoid repeating the original's distinctive keywords.
- Keep it a single, natural question.
- Output ONLY the rewritten question, nothing else.

Original: {q}
Rewrite:"""


def main():
    data = json.loads(DATASET.read_text(encoding="utf-8"))[:N]
    probe = []
    ok = 0
    fail = 0
    for i, inst in enumerate(data):
        q = inst["question"]
        # DeepSeek-via-Merge is a thinking model: max_tokens < ~500 returns
        # empty content (thinking swallows the budget). Use 800.
        raw = llm_call(PROMPT_TMPL.format(q=q), backend="merge", max_tokens=800)
        if raw.startswith("__ERROR__"):
            p = ""
        else:
            p, _cost = strip_cost(raw)
            p = (p or "").strip()
            if not p and raw:
                p = raw.split("|||cost=")[0].strip()
        if not p or len(p) < 10:
            print(f"[{i+1}/{len(data)}] SKIP ({p[:50]!r} / {raw[:40]})")
            fail += 1
            continue
        p = p.strip().strip('"').strip("'")
        probe.append({
            "question_id": inst["question_id"],
            "question_type": inst.get("question_type", ""),
            "question": q,
            "paraphrase": p,
            "answer_session_ids": inst.get("answer_session_ids", []),
        })
        ok += 1
        if (i + 1) % 10 == 0:
            print(f"[{i+1}/{len(data)}] {ok} ok, {fail} fail")
            OUT.write_text(json.dumps(probe, indent=2), encoding="utf-8")

    OUT.write_text(json.dumps(probe, indent=2), encoding="utf-8")
    print(f"\nDONE: {ok} paraphrases written to {OUT} ({fail} skipped)")


if __name__ == "__main__":
    main()
