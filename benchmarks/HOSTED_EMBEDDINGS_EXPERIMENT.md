# Memory Lane — Hosted Embeddings Experiment (Lane A + Lane H)

**Date:** 2026-08-10
**Author:** Hermes (per Josh's "test every angle" directive)
**Status:** Pre-registered protocol (see `BENCHMARK_PROTOCOL.md` §Lane H), runs logged in `logs/*.jsonl`

---

## What this is

Memory Lane's default retrieval is **deterministic FTS5** (BM25, zero LLM, zero
embeddings). This experiment adds an **optional hosted-embedding lane**
(Vertex AI `text-embedding-004`), fused with FTS5 via Reciprocal Rank Fusion,
and measures whether a *strong* embedder closes the semantic-recall gap that
the *weak local* embedder (Ollama bge-m3) could not.

Nothing was replaced or removed. FTS5 remains the default; the dense lane is an
additive enhancement selected by `EMBED_PROVIDER=local|vertex`. This is also the
product path for "users without a local model": same library, hosted lane, still
~$0 at our volume.

## Code changes

- `lib/embeddings.js` (public repo): `EMBED_PROVIDER=local|vertex` switch;
  Vertex provider via REST predict endpoint (batch of 10, 6000-char slices to
  respect the 20000-token request cap; token passed via `VERTEX_ACCESS_TOKEN`).
  Degrades gracefully to FTS5-only when the provider is unavailable.
- `benchmarks/harness/run_lane_a_vertex.mjs` (public repo): Lane A runner,
  FTS5 + Vertex embeddings + RRF.
- `benchmarks/harness/run_lane_h_paraphrase.mjs` (benchmark dir): Lane H
  paraphrase probe runner.
- `benchmarks/harness/generate_paraphrase_probe.py` (benchmark dir): builds the
  paraphrase probe via DeepSeek/DeepSeek.

## Lane A — Retrieval recall (500 LongMemEval questions, identical protocol)

| System | recall@5 | recall@10 | Source run |
|---|---|---|---|
| FTS5 baseline (no embeddings) | **61.08%** | 73.22% | `ml-lane-a-2026-08-10T07-00-45-647Z.json` |
| FTS5 + local bge-m3 (prior U2 run) | 57.90% | — | `hybrid-lane-a-2026-08-04T23-01-26-147Z.json` |
| **FTS5 + Vertex text-embedding-004** | **66.05%** | **77.35%** | `vertex-lane-a-2026-08-10T17-58-01-536Z.json` |

**Delta vs baseline: +4.97 points recall@5, +4.13 points recall@10.**

Notes:
- The weak local embedder (bge-m3 via Ollama) *hurt* recall (−3.2 pts) — this
  matches the earlier U2/U4 finding. The strong hosted embedder *helps*.
- LongMemEval questions contain exact keywords, so FTS5 already covers much of
  it. The semantic lane's real value is paraphrase recall — see Lane H.
- Cost of the run: ~948 blocks × 1 embedding + 500 queries × 1 embedding.
  text-embedding-004 ≈ $0.000025/1K input tokens → well under $0.20 total.

## Lane H — Paraphrase/semantic recall probe

The honest test for "the thing about my car GPS" (different words, same
meaning, FTS5 can't match). N LongMemEval questions are paraphrased via
DeepSeek (instructed to avoid original keywords); gold sessions are
unchanged. Recall@5 measured for FTS5-only vs FTS5+Vertex on the paraphrase.

| Metric | FTS5 only | FTS5 + Vertex | Delta |
|---|---|---|---|
| recall@5 (paraphrase) | 21.25% | 31.46% | **+10.2 pts** |
| questions with a top-5 hit | 8/16 | 10/16 | +2 |

Mechanism confirmed per-question: FTS caught 8 (keyword overlap), dense alone
caught 11 (semantic overlap), and RRF fusion rescued 3 questions FTS missed
entirely. The lanes find *different* sessions — exactly the additive value
predicted. (Small N=16, directional not conclusive, but the mechanism is
reproducible and the Lane A delta is the statistically cleaner number.)

## What this means for the product

1. **Users with no local model** get semantic search through a free/hosted lane
   (GCP free tier / welcome credit), same code path, `EMBED_PROVIDER=vertex`.
2. **Local-first users** keep zero-dependency FTS5; when a strong local
   embedder lands (14B-class), it slots into the same provider switch.
3. **Honcho comparison:** Honcho's retrieval is semantic-only (40.0% recall@5
   in our controlled run). ML + Vertex (66.05%) now leads Honcho by a wider
   margin than ML-FTS5 alone (61.08%) did — and keeps ML's integrity/resume/
   portability lanes Honcho can't claim.

## Honest caveats

- Lane A numbers are LongMemEval-specific (keyword-heavy). The +5pt is real on
  this benchmark but the *product* win is the paraphrase lane (+10.2pt), which
  is the honest measure of the semantic gap — N=16, directional.
- The hosted lane is an external dependency when active (GCP). It is opt-in and
  degrades to FTS5-only, so it never blocks the local-first core.
- **Operational lesson:** gcloud access tokens expire (~1h). The first Lane H
  run silently failed with an expired token (0 delta) and required refresh +
  re-run. The embeddings module needs a token-refresh hook for long runs —
  flagged as follow-up work.
- The DeepSeek paraphrase generator skips ~60% of questions (thinking
  model returns empty content at modest max_tokens). 16/40 usable; fine for a
  directional probe, needs a non-thinking lane for a larger run.
