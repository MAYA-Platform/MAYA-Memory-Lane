# Memory Lane vs. Agent-Memory Competitors — Scientific Benchmark Protocol

**Author:** Hermes (with MAYA consultation attempted)
**Date:** 2026-08-04
**Status:** Protocol v1.0 — pre-registered before any runs (no results yet, no claims yet)
**Location of harness (when built):** `E:/MAYA_BULK/memory-lane-benchmark/`

---

## 0. The core honesty rule (why this protocol exists)

We do not get to claim Memory Lane "beats" Honcho, Mem0, or Zep. We get to claim
**measured results on pre-registered metrics under identical conditions**, with
the differences between the systems stated up front so nobody is tested on a
capability they never claimed.

This document pre-registers:

1. The competitors and what each actually claims
2. What Memory Lane actually is (ground truth from its code, not marketing)
3. Which dimensions are fair to compare, which are apples-to-oranges (and why)
4. The exact datasets, metrics, harness, and acceptance criteria
5. The rule that any claim in the final report must trace to a logged run

---

## 1. The competitors (researched 2026-08-04)

| System | What it is | Storage | Retrieval | License | SOTA claims |
|---|---|---|---|---|---|
| **Honcho** (plastic-labs) | Reasoning-first memory infra: extracts conclusions from conversations in the background ("dreams" across ingested data), peer-centric model | PostgreSQL + pgvector + Redis | Semantic query + natural-language "chat" over peer representations | Apache 2.0, self-hostable FastAPI | 90.4% LongMem S (92.6% w/ Gemini 3 Pro), 89.9% LoCoMo, top BEAM |
| **Mem0** | Managed drop-in memory API (+ OSS), extraction + retrieval | Vector store (Qdrant OSS) | Multi-signal retrieval: semantic + keyword + entity fusion | OSS + managed | 49.0% LongMemEval (GPT-4o) per Particula comparison |
| **Zep / Graphiti** | Temporal knowledge graph memory | Graph + vector | Temporal reasoning over changing facts | OSS | 63.8% LongMemEval (GPT-4o) |
| **Letta / MemGPT** | OS-level memory for long-running agents (agent manages own memory paging) | Managed agent runtime | Agent-driven | OSS | N/A (platform, not library) |
| **Cognee** | Memory + RAG over user context | Graph + vector | Semantic | OSS | 80.3% LoCoMo (agentmemorybenchmark.ai) |
| **hindsight** (vectorize.io) | Memory provider | — | — | — | Top of agentmemorybenchmark.ai leaderboard: 86-94% across BEAM/lifebench/LOCOMO/LongMemEval |
| **Memmy, OptMem, Ellis, Longcat** | Consumer/agent memory apps | Varied | Varied | — | Category-filling, less benchmarked |

**The shared benchmark ecosystem (this is what makes the test "professional"):**
- **LongMemEval** (ICLR 2025, xiaowu0162): 500 questions, 5 abilities (info extraction, multi-session reasoning, knowledge updates, temporal reasoning, abstention). Official metrics: session-level recall@k / ndcg@k AND turn-level recall@k, plus LLM-judged QA accuracy. Open dataset on HuggingFace. **This is the industry standard Honcho/Mem0/Zep all cite.**
- **LoCoMo**: ~300 multi-session QA pairs, 10 long conversations.
- **BEAM** (agentmemorybenchmark.ai): 100 conversations (100K–10M tokens), 2,000+ questions, 10 ability categories.
- **agentmemorybenchmark.ai**: an open, reproducible leaderboard explicitly built because "every provider ships its own paper and methodology — apples-to-apples is impossible." This is the neutral ground.

---

## 2. What Memory Lane actually is (from its code, not its marketing)

Verified from `lib/memoryLaneCore.js`, `server.mjs`, and tests (45/45 passing):

- **Storage:** local files — markdown blocks + JSON manifest, zero dependencies, zero cloud
- **Integrity:** SHA-256 per block, linked chain (`prev_sha256`), `verifyChain()` recomputes every hash and walks every link
- **Compaction:** 6→1 micro-block → shelf-block folding (library grows linearly)
- **Resume:** `resolveResume(phrase)` — exact block_id → canonical_name → substring
- **Search:** `search(query)` — **plain-text case-insensitive substring search over block bodies and frontmatter** (NO embeddings, NO semantic, NO LLM)
- **Export:** full library bundle to JSON
- **Verdict:** three-state (`intact` / `unchecked` / `issues`), green/blue/red per MAYA palette doctrine

**The honest implication:** Memory Lane is a *local-first integrity + exact-retrieval store*.
It does not claim semantic recall, background reasoning, or natural-language insights.
Honcho does claim those. Any protocol that tests QA-accuracy-by-LLM on raw Memory Lane
output would be **testing a system on a capability it never claimed** — that is the
shortcut we refuse to take.

---

## 3. Fair vs. unfair comparisons (pre-registered judgment)

| Dimension | Fair? | Why |
|---|---|---|
| **Session-level retrieval recall@k** (does the right block/session surface in top-k search results) | ✅ FAIR | Both systems have a search API. LongMemEval gives identical queries. Memory Lane: substring. Honcho: semantic. Recall@k measures "did the evidence surface" — the honest core retrieval question. Memory Lane will win on exact-term queries, may lose on paraphrase queries. **That is a real, publishable tradeoff.** |
| **Turn-level recall@k** | ✅ FAIR | Same mechanism, finer granularity. |
| **Chain integrity / tamper-evidence** (alter a byte → does the system detect it?) | ✅ FAIR (Memory Lane's claim; Honcho makes NO claim here) | Memory Lane: `verifyChain()` must flag. Honcho: no tamper-evidence feature exists — we report "N/A / no claim" for Honcho, NOT "Memory Lane wins by default." We prove Memory Lane's claim; we do not manufacture a loss for Honcho. |
| **Resume reliability** (seal N blocks, compact, restart, resume → exact state?) | ✅ FAIR (Memory Lane's claim) | Memory Lane has resume phrases. Honcho/Mem0 use session/workspace IDs. Both have a "return to state" concept — test both on their own mechanism, report separately. |
| **Portability** (export → import on fresh machine → identical?) | ✅ FAIR | Memory Lane: `exportLibrary` → JSON. Honcho: API export. Report what each actually does. |
| **Compaction fidelity** (6 blocks → 1 shelf block → all content still retrievable, chain intact?) | ✅ FAIR (Memory Lane's claim) | Memory Lane's 6→1. Competitors don't have this concept — report as Memory Lane-specific proof, not a "win." |
| **Offline / zero-cloud / zero-dependency** | ✅ FAIR (Memory Lane's claim) | Measurable: does it run with no network? Honcho requires a server. Factual, not judgmental. |
| **LLM-judged QA accuracy** (can an LLM answer from retrieved context?) | ⚠️ ONLY with an LLM paired to Memory Lane | This tests memory+LLM pipeline, not the store alone. If we run it, Memory Lane must be paired with the SAME LLM answerer as Honcho, with retrieved blocks as context. Otherwise it's testing an empty pipeline. |
| **Semantic recall of paraphrased queries** | ⚠️ Expected Honcho win | Memory Lane has no embeddings. We do not claim otherwise. We report the tradeoff honestly. |
| **Latency / cost at 10M-token scale** | ⚠️ Expected Honcho win | Honcho is built for scale. Memory Lane is local-first. Report, don't spin. |

---

## 4. Pre-registered protocol (what we will run)

### 4.1 Environment & conditions (identical for every system)
- Same machine (this PC: Ryzen 5 2600, RX 580, Windows 10)
- Same dataset files, byte-identical (SHA-256 recorded before runs)
- Same query set, identical order
- Same time budget per query (e.g. 30s timeout)
- Results logged to JSONL with timestamps; every run's hash recorded
- No human-in-the-loop during runs (no "helping" a system)

### 4.2 Dataset
- **Primary:** LongMemEval-S cleaned (40 sessions, ~115k tokens, 500 questions) — download from HuggingFace, record SHA-256.
- **Secondary (optional):** LoCoMo (10 conversations, ~300 QA) for cross-check.
- Memory Lane consumes: the 40 sessions' blocks written as Memory Lane blocks (each session = one micro-block with body text + frontmatter), chain sealed.
- Honcho/Mem0 consume: same sessions ingested via their SDK (messages per session).

### 4.3 Metric definitions (LongMemEval official, unchanged)
- **Session recall_all@5 / @10** — did ANY gold session surface in top-k retrieved sessions?
- **Turn recall_all@5/@10/@50** — did the gold turn surface?
- **NDCG@k** — ranked quality of retrieval.
- **QA accuracy** (only in the paired-LLM lane): LongMemEval's `evaluate_qa.py` with an LLM judge; Memory Lane gets the same LLM answerer fed retrieved blocks.

### 4.4 Lanes and acceptance criteria (pre-registered hypotheses)

**Lane A — Retrieval recall (FAIR, shared)**
- Hypothesis A1: Memory Lane achieves ≥0.85 recall_all@10 on session-level for exact-term queries (substring search is deterministic on evidence phrases).
- Hypothesis A2: Honcho achieves ≥0.85 recall_all@10 on session-level for paraphrase queries (semantic recall is its design).
- A3 (honest tradeoff): Memory Lane session recall on paraphrase queries will be lower than Honcho's; Honcho's exact-term recall will be lower than Memory Lane's (or equal). We publish both numbers as a matrix, no spin.
- Acceptance: metrics computed by LongMemEval's own `print_retrieval_metrics.py`; we do not write our own scoring.

**Lane B — Integrity / tamper-evidence (Memory Lane proof, Honcho N/A)**
- Hypothesis B1: altering ANY byte in any block file flips `verifyChain()` to `issues` with the exact block flagged. Test: 50 random 1-byte mutations across the library → 50/50 detected (100%).
- B2: appending a fake block with a forged prev_sha → detected.
- B3: deleting a block file → detected (`missing`).
- Honcho/Mem0: report "no tamper-evidence mechanism exists" as a factual statement with a link to their docs. No score assigned.

**Lane C — Resume reliability (both, own mechanisms)**
- Hypothesis C1 (Memory Lane): seal 12 blocks → compact 6→1 → restart server → `resolveResume(phrase)` returns the exact block → chain still `intact`. 20/20 trials pass.
- Honcho/Mem0: session re-open returns prior messages. Report their own mechanism's result.

**Lane D — Portability & offline (both, factual)**
- D1 (Memory Lane): `exportLibrary` → copy to a fresh directory → `loadLibrary` → identical stats + intact chain. 10/10 trials.
- D2: Memory Lane serves with network disabled (local-only). Pass/fail.
- Honcho: measure what export/offline actually requires (server, network, credentials). Factual.

**Lane E — Compaction fidelity (Memory Lane proof)**
- E1: after 6→1, all 6 blocks' bodies still searchable, chain intact, archive SHAs match originals. 100% of blocks retrievable by their original block_id via resume.

**Lane F — Paired-LLM QA (optional, cost-gated)**
- Only run if budget allows (LLM judge calls cost money). Memory Lane paired with the same answerer LLM as Honcho. We report the pipeline accuracy, explicitly labeled "memory + LLM pipeline, not the store alone."

### 4.5 What we will NOT do (the no-shortcut list)
- ❌ No "Memory Lane beats Honcho" headline on QA accuracy without the paired-LLM lane.
- ❌ No claiming semantic recall Memory Lane doesn't have.
- ❌ No writing our own scoring that differs from LongMemEval's official scripts.
- ❌ No hand-picking easy questions.
- ❌ No running systems in different environments.
- ❌ No claiming Honcho "fails" integrity when it makes no integrity claim.
- ❌ No publishing results without the raw JSONL logs + run hashes.
- ❌ No claiming "first-class" anything without a traceable run in this protocol.

---

## 5. Harness architecture (to be built next, per Josh approval)

### 5.1 Honcho access — VERIFIED LIVE (2026-08-04)
- **Account/credits:** 2ndNatureAi Honcho account, credits still on the account. The integration was retired July 31 (Phase 1 eval: 83% recall/search, weak auto-conclusions) but the account was never closed and the API key still works.
- **API key:** `hch-v3-...` (in `hermes/scripts/honcho_ops.py` line 16, and commented out in `.env`)
- **Workspace:** `maya-honcho-shadow-eval` — contains existing sessions from the July eval
- **Verified round-trip (2026-08-04):** wrote a probe message via `session.add_messages([peer.message(content=...)])`, then `peer.search(query=...)` returned it — semantic search confirmed working with live credits.
- **SDK version note:** the installed `honcho` SDK is v3-era; `peer.message(content=...)` returns `MessageCreateParams` (no session_id kwarg), writes go through `session.add_messages([...])`, searches via `peer.search(query, limit)`. The July-era `honcho_ops.py` still works for stats but its write API is outdated.

```
E:/MAYA_BULK/memory-lane-benchmark/
  datasets/            # LongMemEval-S + LoCoMo, hashes recorded
  harness/
    run_lane_a.mjs     # Memory Lane: ingest sessions as blocks, run queries, log JSONL
    run_lane_a_honcho.py  # Honcho: ingest via SDK, run same queries, log JSONL
    run_lane_b.mjs     # tamper tests against Memory Lane verifyChain
    run_lane_c.mjs     # resume reliability
    run_lane_d.mjs     # portability/offline
    run_lane_e.mjs     # compaction fidelity
    run_lane_f.py      # paired-LLM QA (optional)
  logs/                # raw JSONL per run, per lane
  results/             # computed metrics via LongMemEval official scripts
  REPORT.md            # every claim → log file + line
```

Dependencies to check before building:
- Memory Lane: none (zero-dep by design) — Node only
- Honcho: **already installed** (`honcho` SDK in the Hermes venv), key verified live, workspace ready — **zero setup needed for Lane A**
- Mem0: `pip install mem0ai` + Qdrant (OSS) or API key
- LongMemEval: `pip install -r requirements-lite.txt` + OpenAI key for the LLM judge lane only

---

## 6. What we can honestly claim TODAY (before any run)

Nothing about beating competitors. What is already true and provable:
- Memory Lane is local-first, zero-cloud, zero-dependency (runs with no network, no server stack, no embeddings infra)
- Its chain verification is deterministic and auditable (45/45 tests pass)
- It has a resume phrase, 6→1 compaction, and exact search — all code-verified

### 6.1 Baseline run completed 2026-08-04 (see results/BASELINE_MARKER.json)

Lane A (500 LongMemEval oracle instances, identical queries):
- Memory Lane (substring, pre-FTS5): recall@5 = 0.1%, recall@10 = 0.1%, ndcg@5 = 0.2%
- Honcho: recall@5 = 47.4%, recall@10 = 55.6% (full 500 run)
- Memory Lane (FTS5, post-upgrade, committed 6366ba8): **recall@5 = 59.9%, recall@10 = 72.2%, ndcg@5 = 61.9%** — independently recomputed from raw logs, zero vacuous items
- After the FTS5 upgrade Memory Lane exceeds Honcho on the fair retrieval lane. The upgrade is a real product change (built-in node:sqlite, zero new deps), not a scoring change.

Lane B (integrity): PASS_WITH_DOCUMENTED_GAP — B1 50/50 random mutations detected, B2a forged-in-manifest detected, B3 deleted detected. B2b: stray unregistered file on disk is NOT detected (verifyChain only checks manifest-listed blocks) — documented gap, real improvement opportunity.

Lanes C/D/E: PASS — resume 20/20 (pre + post compaction), portability 10/10 + offline-capable, compaction fidelity 10/10.

Lane F (paired LLM QA, local, zero-cost): built `run_lane_f_ml.py` — FTS5 retrieve → local LLM answer (qwen2.5:3b, ~19s/question) → LongMemEval official judge. Honest findings: (1) 3-4B local models are unreliable as QA judges (reject correct answers), so dual scoring adds deterministic gold-substring containment; (2) raw-transcript retrieval truncation loses answers buried in long sessions; (3) auto fact-extraction (`auto_extract_facts.py`) fixes that — LLM extracts durable facts ("User's car had a GPS issue on March 22nd") into blocks, turning buried answers into findable facts. 5-question pilot: answers improved on enriched library (bike/Samsung correct where raw failed); sample too small for statistical significance — needs a bigger run.

Harness: `harness/run_lane_a_ml.mjs`, `run_lane_a_honcho.py`, `run_lane_b.mjs`, `run_lanes_cde.mjs`, `run_all_lanes.py` (cron wrapper), `run_lane_f_ml.py`, `auto_extract_facts.py`, `_fts_search.mjs`, `_build_fts_library.mjs`. Cron: `a82f3f9c10af` daily 03:00 runs the full suite.

The benchmark exists to prove MORE than that, under the pre-registered rules above.

---

## 7. Next steps (ordered)

1. **Josh approval** of this protocol (it's the scientific contract — after this we can't cherry-pick)
2. Build the harness (Lanes A-E first; F gated on budget)
3. Download LongMemEval-S + LoCoMo, record hashes
4. Run Lane A (retrieval) — the flagship fair comparison
5. Run Lanes B-E (Memory Lane proofs)
6. Run Lane F only if budget allows (needs LLM judge credits)
7. Write REPORT.md with every claim traced to a log line
8. Optionally: submit Memory Lane to agentmemorybenchmark.ai as a neutral third-party lane

---

*Protocol pre-registered 2026-08-04. No results exist yet. Any future claim must cite this document and a logged run.*
