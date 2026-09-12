# Graph Layer Report — HippoRAG-patterns-lite

**Date:** 2026-09-12 · **Harness:** LongMemEval oracle, 500 instances, 948-block library · **Commit:** 7ab64ce

## What shipped

A deterministic, zero-LLM knowledge-graph lane over the block library:

1. **Extraction** (`lib/graph.js`): subject-relation-object triples pulled from block text with a fixed relation lexicon (~140 triggers), possessive copula split ("emily sister is katie" -> `emily|has_sister|katie`), and conjunction carry-over ("Alex leased a Civic and loves hiking" -> two edges, both subject=alex). Same block in, same triples out.
2. **Index**: in-memory SQLite `fact_edges` table plus an `edge_tokens` inverted index, WeakMap-cached per library exactly like the FTS5 index. Files stay the source of truth; the graph is a disposable projection.
3. **Walk**: bounded 2-hop retrieval — query tokens match edges (1-hop, IDF-weighted, saturated tokens skipped), matched edges expose bridge entities, bridge entities' other edges get a dampened 0.4 boost (2-hop). Hard caps: 2000 candidate edges, 60 bridge entities, 400 neighbor lookups.
4. **Fusion** (`search()`): two conservative moves.
   - **Cross-boost**: within the lexical top-10, blocks the graph also ranks in its top-10 move to the front (stable order preserved). The candidate set never changes.
   - **Append**: graph-only hits go after all lexical matches, filling thin result sets.

## Before/after (official harness, same library, same dataset)

| Metric | Before | After | Delta |
|---|---|---|---|
| session_recall_all_5 | 61.08% | **62.93%** | +1.85 pts |
| session_recall_all_10 | 73.22% | 73.22% | unchanged |
| session_ndcg_any_5 | 62.03% | 62.11% | +0.08 pts |

Chain integrity: intact (948/948) in both runs.

## Experiment trail (why cross-boost and not RRF)

Full simulation harness: `fusion_sim.mjs` (this directory).

- **Naive RRF fusion**: 61.08% -> 54.62% @5. The graph is noisier than BM25 on raw transcripts; co-equal fusion lets graph noise demote good lexical hits.
- **IDF weighting + saturation filter** (tokens in >5% of edges skipped, e.g. "like" at df=5581/57780): graph-alone recall@5 37.80% -> 46.42% with degree-norm + multi-token conjunction bonus. Real signal, still below lexical.
- **Interleave policies** (graph hits into positions 1-5): all lost 4-8 pts. Lexical ranks 4-5 beat graph rank 1-3.
- **Mid-promotion** (graph hits into positions 6-8, targeting recall@10): 68.59% @10 — lost 4.6 pts. Lexical ranks 6-10 also beat graph top-3.
- **Cross-boost** (reorder, don't replace): +1.85 pts @5, zero @10 loss. The graph's value is confirming which lexical hits matter, not nominating new ones on this corpus.

## Live deployment

- Live library server (port 8770) restarted on the new core: 31,675 edges extracted from 1,234 live blocks, 2.85s one-time graph build (cached per process).
- MCP bridge (`tools/memory-lane-mcp.mjs`) imports the same core — ml_search/ml_answer consumers get the graph lane on next process restart.

## Honest limits

- Cross-boost helps @5 because the graph confirms entity-centric blocks; it does not currently lift @10 because displaced lexical 6-10 hits are, on average, as good as graph nominees.
- The relation lexicon is English-centric and verb-oriented. Blocks without SVO-shaped sentences contribute no edges.
- Walk constants (saturation 5%/50-floor, neighbor boost 0.4, caps) are calibrated on this one dataset; treat them as defaults, not laws.
