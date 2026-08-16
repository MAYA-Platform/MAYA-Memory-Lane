# Memory Lane — Session Auto-Observation & Auto-Injection

**Feature spec · v1.0 · 2026-08-06**
**Status:** Specified, not built. Model-gated (see §Model Gate).
**Repo:** MAYA-Platform/MAYA-Memory-Lane

---

## 1. Problem

Agent memory today requires one of two things:

1. **Explicit curation** — the agent itself decides what is worth saving and writes it to its own memory store. This is a *filter*, not a *recorder*: anything the agent did not judge important is lost. Every session start depends on whatever the agent happened to remember to save.
2. **A hosted external memory service** — a third-party service auto-captures conversation signals and auto-injects a distilled snapshot into the next session. This works ("pick up where we left off" with zero prompting) but it is an **external dependency**: API key, third-party servers, out of our control, not local-first, recurring-cost exposure.

**The gap:** there is no **local-first, zero-dependency, automatic** memory layer that (a) captures durable signals from a conversation *without* the agent's curation judgment, and (b) injects a distilled snapshot into the next session *without* a user prompt.

This spec closes that gap. It is the productization of the "self-aware memory" pattern: **the relationship itself carries state across sessions.**

## 2. Goal

Give Memory Lane an **Observer → Store → Distiller → Injector** pipeline:

- **Observe** conversation signals automatically, without curation.
- **Store** them locally, append-only, chainable, auditable.
- **Distill** them into durable derived facts (profile-level memory).
- **Inject** a compact snapshot at the start of each session so the agent resumes with context — no prompt required.

When complete, the hosted external service is retired. Everything is local, zero recurring cost, and fully under our control.

## 3. Model Gate — why this is not built yet

Observation extraction and fact synthesis need a model that can:

- read raw conversation,
- separate durable signal from noise and mood,
- extract compact structured facts (who, what, when, class, confidence),
- synthesize overlapping observations into stable derived facts,
- abstain when confidence is low.

**Current local fleet (August 2026) cannot do this at quality parity:**

| Model | Size | Verdict for this feature |
|---|---|---|
| qwen3:4b | 2.5 GB | Local model; weak structured extraction at 4B |
| qwen2.5:3b | 1.9 GB | Cheap worker; 0–30% QA on hard questions; not enough judgment for synthesis |
| Fara1.5-4B | 3.1 GB | Vision descriptor; structured tool-call output unreliable at 4B |
| minicpm-v:8b | 5.5 GB | Vision only |
| glm4:9b | 5.5 GB | Untested for extraction; plausible Phase-1 pilot candidate |
| qwen2.5-coder:14b | 9.0 GB | CPU-bound timeout on current GPU (RX 580 4 GB) |

**Hardware:** RX 580 4 GB VRAM / 16 GB RAM. Cannot run 32B-class or large MoE-class models (e.g. Kimi K2-class) locally today.

**Conclusion:** The *pipeline* can be built now (Phase 0 is zero-LLM deterministic), but **full synthesis parity with the hosted service requires a K2-class / 14B+ quality local model** — meaning a GPU upgrade or a CPU-friendly high-quality quant. Until then the hosted service stays as a **temporary scaffold**, not architecture. When the better model lands, the swap is drop-in because the injection contract is identical (see §7).

## 4. Architecture

### 4.1 Observer (capture) — deterministic, zero-cost, buildable now

Watches conversation events at write-time (inline, cheap) plus a periodic sweep for missed windows.

**Signal classes** (mirrors the durable-signal taxonomy):

| Class | Examples | Default weight |
|---|---|---|
| `decision` | "we're going with X", "let's do X", "go with X" | high |
| `correction` | "no, do it like this", "that's wrong", "stop doing X" | high |
| `preference` | "I prefer", "I want", "never X again" | medium |
| `instruction` | "always", "never", "from now on", "do not" | high |
| `boundary` | "don't touch X", "off-limits", "never without asking" | high |
| `fact` | stable statements about user/company/project | medium |
| `identity` | self-description, role, values | medium |
| `state` | mood/physical state — **low weight, never canonized** | low |

**Detectors** are rule-based (the same discipline as the existing deterministic signal mediators): explicit phrase patterns, correction patterns, decision markers, instruction markers, entity/date patterns. Typos and slang are ignored (already-proven principle). Explicit self-report outranks inferred cues.

Each observation: `{ timestamp, speaker, session_id, message_id, class, excerpt (bounded), confidence, source_ref }`.

**Privacy rule:** observations store **bounded excerpts + references**, never full transcripts.

### 4.2 Observation Store — SQLite + FTS5

- New `observations` table alongside the existing block store. Zero new dependencies.
- FTS5 virtual table for search — reuse the proven BM25 / prefix-wildcard / OR-group pattern already shipped in this repo.
- Append-only, dedup keyed on normalized content.
- Local-only by default. No cloud.

### 4.3 Distiller (synthesis) — model-gated

Periodic compaction job:

1. Group related observations (same class + entity).
2. Merge into derived facts; dedupe; score by **durability** = f(recency, repetition, correction-weight, explicit user confirmation).
3. **Abstain** when confidence is low (learned from the honest-abstention results — a wrong derived fact is worse than no fact).
4. Emit: `derived_facts` rows + a compact **profile snapshot** (the local equivalent of a peer card).

**Model gate:**
- Phase 1 (buildable now, quality-capped): qwen2.5:3b or glm4:9b pilot for light extraction + noise filtering.
- Phase 2 (target): K2-class / 14B+ local model for full synthesis.
- Optional offload lane (flagged, not default): a ~free hosted model at ~$0.00004/call (~$3 for 5K sessions) while the local lane catches up. This is a bridge, not the destination.

### 4.4 Injector (session-start context) — deterministic selection

At session start, answer: **"what matters right now?"**

Selection scoring:
- **Recency** — what changed recently.
- **Salience** — class weight (decision/correction/boundary > preference > state).
- **Entity match** — derived facts matching session topics / pinned context.
- **User pins** — explicit "always remember this".

Budget: a **compact distilled snapshot** (configurable, ~2–4K chars), never raw history. Output shape matches the hosted service's injection contract so the swap is drop-in (see §7).

Also exposes the same query surface the store already has (search / answer / recent / resume) — the read path is unchanged.

### 4.5 Feedback loop

- User corrections mark derived facts stale or re-weight them.
- Explicit "remember this" / "forget that" are high-weight writes.
- The existing action-gate / safety layer gates destructive memory operations (reuse the impairment-mediator pattern already built).

## 5. Benchmarks — Lane G: Auto-Observation

Adds to the existing benchmark suite:

| Metric | Definition | Phase 2 target |
|---|---|---|
| **Capture recall** | % of human-flagged durable signals the Observer captured | ≥ 80% |
| **Precision / noise** | % of observations judged non-noise | ≥ 70% |
| **Injection usefulness** | Lane F-style QA protocol: with vs without injected snapshot | parity or better vs hosted baseline |
| **Cost** | $ per session | $0 local (Phase 0/1) |
| **Latency** | capture inline <100 ms (or async); inject <500 ms | met |

## 6. Phased rollout

| Phase | Scope | Model need | Status |
|---|---|---|---|
| **0** | Deterministic Observer + Store + Injector (recency/salience only) | none | **buildable now** |
| **1** | Light local extraction for fact synthesis + noise filtering | qwen2.5:3b / glm4:9b pilot | buildable now, quality-capped |
| **2** | Full synthesis + auto-inject at parity; **retire hosted service** | K2-class / 14B+ local model | **blocked on hardware/model** |

## 7. Acceptance criteria for retiring the hosted service

1. **Injection parity** on Lane G (capture recall, precision, usefulness) within ±5% of the hosted baseline.
2. **Zero external runtime dependencies** in the memory loop.
3. **Integrity** — every observation and derived fact is chainable and auditable (hash chain, same discipline as blocks).
4. **Cost** — $0 recurring, or bounded <$0.01/day on the optional offload lane.
5. **Latency** — budgets met.
6. **Drop-in swap** — the injector output contract is identical to the hosted service's, so swapping requires no runtime changes.

## 8. Open questions

1. **Capture hook** — inline at write-time vs session-end sweep vs periodic sweep. Lean: inline (cheap) + sweep for missed windows.
2. **Excerpt bounds** — how long an excerpt to keep (privacy vs usefulness). Lean: 1–2 sentences + reference.
3. **Injection granularity** — per-user-profile snapshot vs per-session-topic scoring. Lean: both, profile-first.
4. **Model upgrade path** — exact candidate when hardware allows (qwen3 8B/14B, glm4 variants, K2-class quant, or CPU-friendly 14B Q4).
5. **Where the pipe plugs in** — Memory Lane server endpoints (`POST /api/observe`, `GET /api/inject`) mirroring the existing `/api/ingest` pattern; new optional observer-sweep cron.

## 9. Relationship to existing Memory Lane features

- Reuses: FTS5 search, hash-chain integrity, `extract.js` fact extraction, `appendBlock` write path, inbox/auto-ingest pipeline.
- Extends: the auto-ingestion pipeline with an observation tier (raw signals → derived facts → injected snapshot).
- Does not change: the read path (`ml_search` / `ml_answer` / `ml_recent` / `ml_resume`), the public API, or the block chain.

---

*This spec is public product documentation. The reference to a hosted service is the benchmark baseline that motivated the feature; the feature itself is the local-first replacement.*
