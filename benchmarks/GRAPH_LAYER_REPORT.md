# Graph Layer Report — HippoRAG-patterns-lite

**Date:** 2026-09-12 · **Harness:** LongMemEval oracle, 500 instances, 948-block library · **Commit:** 7ab64ce

## What shipped

A deterministic, zero-LLM knowledge-graph lane over the block library.

1. **Extraction** in `lib/graph.js`. Subject-relation-object triples pulled from block text with a fixed relation lexicon (~140 triggers), a possessive copula split ("emily sister is katie" becomes `emily|has_sister|katie`), and conjunction carry-over ("Alex leased a Civic and loves hiking" becomes two edges, both with subject=alex). Same block in, same triples out.
2. **Index.** In-memory SQLite `fact_edges` table plus an `edge_tokens` inverted index, WeakMap-cached per library exactly like the FTS5 index. Files stay the source of truth and the graph is a disposable projection.
3. **Walk.** Bounded 2-hop retrieval. Query tokens match edges (1-hop, IDF-weighted, saturated tokens skipped), matched edges expose bridge entities, and bridge entities' other edges get a dampened 0.4 boost (2-hop). Hard caps: 2000 candidate edges, 60 bridge entities, 400 neighbor lookups.
4. **Fusion** in `search()`, two conservative moves.
   - Cross-boost: within the lexical top-10, blocks the graph also ranks in its top-10 move to the front (stable order preserved). The candidate set never changes.
   - Append: graph-only hits go after all lexical matches, filling thin result sets.

## Before and after (official harness, same library, same dataset)

| Metric | Before | After | Delta |
|---|---|---|---|
| session_recall_all_5 | 61.08% | **62.93%** | +1.85 pts |
| session_recall_all_10 | 73.22% | 73.22% | unchanged |
| session_ndcg_any_5 | 62.03% | 62.11% | +0.08 pts |

Chain integrity stayed intact (948/948) in both runs.

## Experiment trail (why cross-boost and not RRF)

Full simulation harness in `fusion_sim.mjs` in this directory.

- Naive RRF fusion moved recall@5 from 61.08% down to 54.62%. The graph is noisier than BM25 on raw transcripts, and co-equal fusion lets graph noise demote good lexical hits.
- IDF weighting plus a saturation filter (tokens in more than 5% of edges are skipped, e.g. "like" at df=5581 of 57780) lifted graph-alone recall@5 from 37.80% to 46.42% with degree-norm and a multi-token conjunction bonus. Real signal, still below lexical.
- Interleave policies (graph hits into positions 1-5) all lost 4-8 pts. Lexical ranks 4-5 beat graph ranks 1-3.
- Mid-promotion (graph hits into positions 6-8, targeting recall@10) scored 68.59% @10, a 4.6 pt loss. Lexical ranks 6-10 also beat graph top-3.
- Cross-boost (reorder, don't replace) gained 1.85 pts @5 with zero @10 loss. The graph's value is confirming which lexical hits matter, not nominating new ones on this corpus.

## Live deployment

- The live library server (port 8770) restarted on the new core. It extracted 31,675 edges from 1,234 live blocks with a 2.85s one-time graph build, cached per process.
- The MCP bridge (`tools/memory-lane-mcp.mjs`) imports the same core, so ml_search and ml_answer consumers get the graph lane on their next process restart.

## Honest limits

- Cross-boost helps @5 because the graph confirms entity-centric blocks. It does not currently lift @10 because displaced lexical 6-10 hits are, on average, as good as graph nominees.
- The relation lexicon is English-centric and verb-oriented. Blocks without SVO-shaped sentences contribute no edges.
- Walk constants (saturation 5% with a 50-edge floor, neighbor boost 0.4, caps) are calibrated on this one dataset. Treat them as defaults, not laws.
