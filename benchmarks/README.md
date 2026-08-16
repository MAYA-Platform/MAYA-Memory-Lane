# Benchmarks — Memory Lane vs. Agent-Memory Competitors

Independent, pre-registered, reproducible benchmark results for Memory Lane.

**Core honesty rule (from the protocol):** we report *measured results on
pre-registered metrics under identical conditions*, and we keep two kinds of
numbers strictly apart:

1. **Controlled runs (our harness)** — Memory Lane vs Honcho on the same
   dataset (LongMemEval oracle), identical queries, official LongMemEval
   scoring semantics. Directly comparable, fully logged.
2. **External numbers (vendor self-reports / third-party evals)** — what the
   vendors published from their own setups, or what independent evaluations
   found. Labeled `[VENDOR]` / `[INDEPENDENT]`. **Not** directly comparable to
   our controlled runs or to each other.

We never claim to have run a competitor on our harness when we did not.

## Files

| File | What it is |
|---|---|
| `BENCHMARK_PROTOCOL.md` | Pre-registered method, written before any run (no hindsight bias). Defines lanes, dataset, metrics, and the honesty rules. |
| `SIDE_BY_SIDE_REPORT.md` | The current side-by-side: controlled runs, Memory Lane capability proofs, LLM QA lane, external vendor numbers, capability matrix, and explicit "what we will NOT claim." Every controlled figure traces to a logged run file. |
| `THEORY_TO_PROOF_REPORT.html` | Narrative report of the same data: theory → hypothesis → experiment → results → proof, with honest boundaries and full reproducibility. Same numbers as the side-by-side, human-readable. |
| `README.md` | This file. |

## Reproducibility

The full controlled suite is a ~30–40 min run on a machine with Node 22+
and Python 3:

```bash
git clone https://github.com/MAYA-Platform/MAYA-Memory-Lane
# dataset: huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
# harness (private, holds credentials)
python run_all_lanes.py --all     # Lane A both systems + Lanes B-E
python harness/generate_sbs_report.py   # regenerates SIDE_BY_SIDE_REPORT.md from fresh logs
```

The harness itself is kept private because it contains service credentials
(Honcho API key) and internal paths. The protocol, the report, and this README
are the public, reviewable surface. Anyone with a LongMemEval download can
stand up their own harness against the same protocol.

## Current status

- Protocol: pre-registered 2026-08-04, unchanged since.
- Controlled Lane A (retrieval recall, 500 instances): Memory Lane (FTS5) vs
  Honcho, identical conditions — see `SIDE_BY_SIDE_REPORT.md` §1 for the
  latest logged numbers and their source files.
- Lanes B–E (integrity, resume, portability, compaction): Memory Lane proofs;
  Honcho has no such mechanisms (reported as factual N/A, not a loss).
- Lane F (LLM QA over retrieved memory): shows the answerer-model effect —
  the store retrieves, the model answers (see report §3).
- Mem0, Zep/Graphiti, Letta, LangMem: code-level studied (repos cloned, read)
  but not stood up on our harness — their numbers in the report are external
  and labeled as such.
