# Historical Lane A metric correction

The historical side-by-side report's claim of identical official scoring is
incorrect. Memory Lane's runner uses a first-hit logarithmic score; several
competitor runners use a reciprocal-rank formula. Neither is the official
LongMemEval NDCG, and the two formulas cannot be compared directly.

The [official evaluator](https://github.com/xiaowu0162/LongMemEval/blob/main/src/retrieval/eval_utils.py)
computes normalized discounted cumulative gain over multiple relevant corpus
items. Its implementation gives the first and second positions weight 1 and
the third position weight 1/log2(3). Its recall-all is binary per question.
The [official aggregation script](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py)
excludes question IDs containing `_abs`. The recorded traces do not establish
the full corpus relevance vector needed to reproduce official NDCG. Do not
interpret the historical first-hit scores, or this audit, as official NDCG.

`python benchmarks/harness/recompute_lane_a.py <log.jsonl> [more logs...]`
recalculates the same explicitly named, **custom** first-hit logarithmic score
and binary all-gold recall across supplied traces. It excludes `_abs`, retains
duplicate positions, emits file hashes, and does not call providers. It does
not change historical logs. The historical report generator is disabled until
its misleading scoring and comparability claims are corrected.

These recalculations do not establish a fair leaderboard. For example, the
Honcho trace maps messages to sessions without deduplication, while other
adapters handle duplicates differently; the global corpus construction also
does not establish the official per-question haystack protocol. Ingest and
query errors require separate accounting.

For a new comparison, preserve the original dataset and its hash; isolate each
question's haystack; define a common retrieval unit, cutoff and failure policy;
save the full corpus and rankings needed by the pinned official evaluator; and
independently verify its scores before publishing. Compare any Laya reranking
against the same candidates, without provider calls or access to personal data
in this historical audit.
