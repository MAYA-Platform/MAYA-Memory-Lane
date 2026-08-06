# Memory Lane vs Top-5 Agent-Memory Competitors — Scientific Side-by-Side

**Generated:** 2026-08-06T22:34:53+00:00 UTC
**Generator:** `harness/generate_sbs_report.py` — all figures read from logged run JSONs, not hand-typed.
**Protocol (pre-registered):** `BENCHMARK_PROTOCOL.md` (written before any run, no hindsight bias)

---

## 0. Scope honesty — read this first

This document reports **two different kinds of numbers, kept strictly apart**:

1. **CONTROLLED RUNS (our protocol)** — Memory Lane vs Honcho, identical dataset (LongMemEval oracle), identical queries, identical scoring (official LongMemEval semantics), run from this harness, traces in `logs/*.jsonl`. These are directly comparable to each other.
2. **VENDOR SELF-REPORTS / INDEPENDENT EVALS (external)** — numbers the vendors published from *their own* setups, or third-party evaluations of them. Different datasets, models, and scoring. **NOT directly comparable to our controlled runs** or to each other. Always labeled `[VENDOR]` / `[INDEPENDENT]`.

Mem0, Zep/Graphiti, Letta, and LangMem were **code-level studied** (repos cloned at `E:/MAYA_BULK/competitor-study/`) but were **not** stood up on our LongMemEval harness — standing up 4 heavy stacks (vector DBs, Neo4j, Postgres, paid LLM extraction) is a multi-day engineering project, and doing it half-way would produce worse science than not doing it. Their rows therefore show vendor/independent numbers + code-level capability findings, explicitly not our measurements.

---

## 1. Controlled runs (our protocol — directly comparable)

**Dataset:** LongMemEval oracle (500 instances), official session-level scoring semantics (`recall_all@k`, `ndcg_any@k`). No LLM judge in Lane A — pure retrieval.

| Metric | Memory Lane | Honcho | Source files |
|---|---|---|---|
| recall_all@5 | 61.1% | 40.0% | `ml-lane-a-2026-08-06T22-34-29-538Z.json` / `honcho-lane-a-2026-08-06T22-25-24-376491+00-00.json` |
| recall_all@10 | 73.2% | 47.9% | `ml-lane-a-2026-08-06T22-34-29-538Z.json` / `honcho-lane-a-2026-08-06T22-25-24-376491+00-00.json` |
| ndcg_any@5 | 62.0% | 28.5% | `ml-lane-a-2026-08-06T22-34-29-538Z.json` / `honcho-lane-a-2026-08-06T22-25-24-376491+00-00.json` |
| ndcg_any@10 | 65.5% | 29.5% | `ml-lane-a-2026-08-06T22-34-29-538Z.json` / `honcho-lane-a-2026-08-06T22-25-24-376491+00-00.json` |

Run timestamps: ML 2026-08-06 22:34 UTC · Honcho 2026-08-06 22:25 UTC

**Context for reading these numbers honestly:** Memory Lane's retrieval is deterministic FTS5 (BM25, zero embeddings, zero LLM). Honcho's is semantic. LongMemEval questions are paraphrased, so exact-match struggles and semantic shines — but after the FTS5 upgrade (commit 6366ba8), ML's recall@5 moved from a 0.1% baseline to exceed Honcho under identical conditions (baseline history in `BASELINE_REPORT.md`; latest controlled numbers in the table above, regenerated from the freshest logged runs each time this report is generated).

---

## 2. Memory Lane capability proofs (Lanes B–E) — Honcho: N/A, no claim

These lanes test capabilities Honcho does not claim to have; per protocol we report ML's result and Honcho's factual N/A rather than manufacturing a loss.

| Lane | Capability | Result | Evidence file |
|---|---|---|---|
| B | Integrity / tamper-evidence (50 mutations, forged, deleted) | PASS_WITH_DOCUMENTED_GAP | `lane-b-2026-08-06T22-34-45-784Z.json` |
| C/D/E | Resume 20/20 · Portability 10/10 · Compaction 10/10 | see file | `lane-cde-2026-08-06T22-34-47-432Z.json` |
| — | Honcho tamper-evidence | **N/A — no mechanism exists** (factual, not a loss) | — |

---

## 3. Lane F — LLM QA over retrieved memory (Memory Lane, two backends)

Same retrieval (FTS5), identical hard multi-session temporal questions. Shows the answerer-model effect — the store retrieves; the model answers.

| Backend | Judge acc | Substring acc | Cost/q | Source |
|---|---|---|---|---|
| Local qwen2.5:3b | 0% | 30% | $0 | `results/LLM_BACKEND_COMPARISON.md` (10-q pilot) |
| Main model (DeepSeek v4-flash via Merge) | 40% | 60% | ~$0.00004 | `results/LLM_BACKEND_COMPARISON.md` (10-q pilot) |

Caveat (in the source doc): 10 questions is a pilot, not significance. Dual scoring exists because small local judges are unreliable ('no' to correct answers).

---

## 4. External numbers — vendor self-reports & independent evals

**NOT comparable to Section 1.** Different datasets, models, scoring, and setups. Sourced from the competitor research file (`E:/MAYA_BULK/competitor-study/agent-memory-competitor-research.md` — internal notes) whose primary sources are public: vendor blogs, arXiv, and third-party evaluations, including Particula's independent comparison (particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026), agentmarketcap.ai landscape posts (2026-04-08 / 2026-04-10), vectorize.io/articles/mem0-vs-zep, and kanopylabs.com/blog/mem0-vs-zep-vs-langmem-ai-memory. All claims below are traceable to those public sources.

| System | Claim | Label | Notes |
|---|---|---|---|
| Honcho | LongMem S 90.4% (92.6% w/ Gemini 3 Pro) · LoCoMo 89.9% | [VENDOR] | evals.honcho.dev, May 2026; no independent replication yet |
| Honcho | Haiku 4.5 alone 62.6% vs oracle 89.2% | [VENDOR] | their memory layer beats oracle |
| Mem0 | LoCoMo 71.4→92.5 · LongMemEval 67.8→94.4 · BEAM 64.1@1M | [VENDOR] | vendor blog, Jul 2026 |
| Mem0 | LongMemEval 49.0% (GPT-4o) | [INDEPENDENT] | Particula comparison — 45-pt gap vs vendor claim |
| Zep/Graphiti | LongMemEval 63.8% (GPT-4o) · DMR 94.8% | [INDEPENDENT] | vs Mem0's 49.0% in same eval |
| Zep/Graphiti | LongMemEval_S 71.2% vs 60.2% full-context | [VENDOR] | graph extraction benefits |
| Letta/MemGPT | gpt-4o-mini + filesystem agent 74.0% LoCoMo | [INDEPENDENT] | above Mem0's 68.5% graph variant — their own thesis |
| LangMem | No published LongMemEval score | [NONE] | as of May 2026 |

**The meta-finding worth stating plainly:** vendor self-reports in this category diverge from independent evals by up to 45 points (Mem0 94.4% vs 49.0%). Treat all vendor numbers skeptically — including our own; that is why Section 1 numbers are logged traces, not prose.

---

## 5. Capability matrix — code-level findings (all 5 studied)

From `E:/MAYA_BULK/competitor-study/COMPETITOR_STUDY.md` (repos cloned + read, 2026-08-04). ✅ = present, ❌ = absent, ⚠️ = partial/optional.

| Capability | ML | Honcho | Mem0 | Graphiti | Letta | LangMem |
|---|---|---|---|---|---|---|
| Semantic retrieval | ❌ (exact FTS5) | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Temporal grounding | ⚠️ (facts section) | ✅ | ✅ | ✅ (bi-temporal edges) | ❌ | ❌ |
| Entity linking | ❌ | ✅ | ✅ | ✅ (graph nodes) | ❌ | ⚠️ |
| Knowledge-update handling | ⚠️ (append+dedup) | ✅ | ✅ (ADD-only) | ✅ (edge invalidation) | ⚠️ | ✅ (schema merge) |
| Tamper-evidence / chain | ✅ (SHA-256 chain) | ❌ | ❌ | ❌ | ⚠️ (git) | ❌ |
| Resume / named blocks | ✅ | ❌ | ❌ | ❌ | ⚠️ (filesystem) | ❌ |
| Compaction | ✅ (6→1) | ❌ | ❌ | ❌ | ⚠️ (archival) | ❌ |
| Offline / zero-dep | ✅ | ❌ (cloud) | ❌ (cloud/vector) | ❌ (Neo4j) | ❌ (Postgres) | ❌ (LangGraph) |
| Structured extraction | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ (trustcall schema) |
| Background derivation | ❌ | ✅ | ✅ | ✅ | ❌ | ⚠️ |
| Zero recurring cost | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

Read as: ML is the **integrity + locality + zero-cost** store; the others are **semantic + derived** memory. They are different categories sharing one fair lane (retrieval).

---

## 6. What we will NOT claim (per protocol §0)

- ❌ "Memory Lane beats the top 5" — we only claim measured results on our controlled lane vs Honcho, plus code-level capability findings.
- ❌ "Memory Lane is better than Mem0 at retrieval" — Mem0 was not run on our harness; its 94.4% claim and 49.0% independent eval are external, not ours.
- ❌ Any semantic-recall number for ML — it has none, and the report says so.
- ❌ Any number without a trace — every Section 1/2/3 figure points to a logged file.
- ❌ "Honcho loses" — Honcho won semantic retrieval before our FTS5 upgrade and is a different category; we report what we measured, both directions.

## 7. Reproducibility (for peers)

```bash
# clone + dataset
git clone https://github.com/MAYA-Platform/MAYA-Memory-Lane
huggingface-cli download xiaowu0162/longmemeval-cleaned

# run the controlled suite (Lane A both systems + Lanes B-E)
python run_all_lanes.py --all        # ~30-40 min, writes results/ + logs/
# regenerate this report from the fresh logs
python harness/generate_sbs_report.py
```

Every controlled figure regenerates from the latest run JSONs. The protocol (`BENCHMARK_PROTOCOL.md`) pre-registered the method before any numbers existed.
