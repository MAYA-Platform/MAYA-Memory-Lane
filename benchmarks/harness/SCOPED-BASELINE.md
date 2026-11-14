# Scoped LongMemEval baseline

This experimental runner uses one Memory Lane Continuity Block library per question, built only from that question's public LongMemEval haystack. It uses user-turn text, transforms answer session IDs without a positive user annotation to `noans`, and derives gold from the transformed IDs. It calls the actual `appendBlock`, `loadLibrary`, `verifyChain`, and `search` APIs; no model or provider is invoked. It preserves each created library in a fresh output directory.

The scorer transcribes binary all-gold recall and multi-hit DCG from [LongMemEval eval_utils.py at 9e0b455](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py). The report separately gives the standalone metric printer's denominator (exclude `_abs`) and the retrieval runner's denominator (also exclude questions with no answer-bearing user turn). This is not a run of the official Python scorer; parity beyond the tested unique-session cases remains unproven. The printed IDs are public benchmark evidence, not a privacy boundary.

Pass a verified local dataset file and a new output parent directory. The CLI checks the exact pinned dataset SHA-256 before execution and writes a new UUID directory without replacing previous results. The oracle and cleaned-S files are different datasets and their scores must not be directly compared. Sample usage:

```sh
node benchmarks/harness/scoped_baseline_launcher.mjs /path/to/longmemeval_oracle.json /path/to/outputs
node benchmarks/harness/scoped_baseline_s.mjs /path/to/longmemeval_s_cleaned.json /path/to/outputs
node benchmarks/harness/scoped_baseline_s_pilot.mjs /path/to/longmemeval_s_cleaned.json /path/to/outputs
```

The pilot predeclares 20 non-abstention questions by alphabetical question-type round-robin in original dataset order; no outcomes influence selection. It records per-question counts, IDs and scores. Precision@5/@10 is a separate non-official measure: gold session hits divided by the actual number returned up to k; zero-return questions produce null and are omitted from the macro-precision mean, with that denominator reported. Retrieval p50 and nearest-rank p95 cover non-abstention successful questions; elapsed times include search and ID mapping, not ingestion. Failed items disable aggregate scores and latency summaries. The same per-question IDs and candidates could support a later paired experiment, but this pilot does not run Laya or measure its impact.

The S pilot's supervisor checks for 4 GiB free before launch, samples a 2 GiB floor, requests termination at 180 seconds, and sets a 1 GiB V8 heap limit. These are not hard total-memory or process-tree limits; fast spikes, direct `--worker` invocation and abrupt supervisor death can bypass protection. A failed termination is reported as unconfirmed. Full JSON is read into memory. The smaller S smoke uses a 90-second deadline; oracle smoke uses lower 3 GiB/1.5 GiB thresholds and a 30-second deadline. Use only in an appropriately isolated environment.

## Exploratory 20-case run

One reviewed cleaned-S pilot used source candidate `dbb76a2` with Memory Lane core SHA-256 `7bf54d73adf0af14a992437bf07f4ac20db0d4c0e947275ce470b3ad1ede5f07`, dataset SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, and the pinned scorer revision above. The source candidate predates this portable-path cleanup; the core file is identical. The saved local receipt is not included here. Twenty questions completed without reported errors; 17 had an eligible user target under the retrieval runner's denominator, while all 20 were included under the standalone printer's denominator.

Under the 17-question runner denominator, all-gold recall was 14/17 at 5 and 15/17 at 10; macro precision using actual returned counts was 35.29% and 22.86%, respectively. Retrieval p50 was 49.85 ms and p95 was 56.98 ms across 20 questions on that machine and workload. These small, fixed-order, non-representative results are exploratory, not population estimates, vendor comparisons, a measure of answer quality, or proof of Laya performance. They do not establish latency on other hardware or under other workloads. The receipt contains core and dataset hashes, but not full dependency versions or authenticated provenance.

Synthetic checks: `node --test benchmarks/harness/scoped_baseline.test.mjs benchmarks/harness/scoped_baseline_launcher.test.mjs benchmarks/harness/scoped_baseline_s.test.mjs`.
