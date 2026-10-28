# Memory Lane V3 Implementation Report

Date: 2026-10-16. Scope: isolated development and offline evaluation. Production was not deployed or restarted, and the live library was not modified.

## Status and commit references

- Baseline: `2a569c88b83168c73a32472cc7e7332f46562a57` on `audit/ci-20260923`.
- Branch: `codex/ml-v3-20261016`.
- Retrieval correctness commit: `db51192`.
- Temporal, governance, ingestion, tooling, benchmark and documentation commit: `92b2515ed9dbf75efc16def86089af92237214f0`.
- Final implementation hardening commit: `585dfbc8e6a0d4b9eca8d920a1003be90505e148`.
- `IMPLEMENTED`: the source features listed below are committed.
- `TESTED`: 172/172 offline tests passed on the original delivery head. The V3 team-integration follow-on has a separate focused E2E suite and V3 regressions; these later checks do not supersede the full-suite gate for the current candidate.
- `BENCHMARKED`: identical synthetic workloads compared against the specified baseline; results and limits below. No production accuracy or live-provider latency claim.
- `REVIEW_READY`: source, tests, evidence, API/security documentation and rollback procedure are prepared for a draft PR against the Jev-only baseline branch. The delivery message and PR contain the final delivery commit references and CI evidence.
- `DEPLOYED`: no.
- `FOUNDER_ACCEPTED`: no.

This is a reviewable V3 development foundation, not a claim that every operational step in the work order is complete. Production lifecycle wiring, private-corpus evaluation, live calibration and paid bulk backfill remain gated or deferred.

## Baseline and prior-work audit

The default branch still contained the older synthesis implementation. Development therefore started at the specified Jev-only SHA, not `main`. Both remote branches, commit history, open issues and open PRs were inspected; there were no open issues or PRs at audit time. The original suite reproduced 124/124 passing tests with network-capable decisions disabled. The test preload was strengthened because its existing local credential fallback was not hermetic for Jev.

The referenced operator doctrine and feeder repository listings were inspected read-only. The remote upgrade handoff lane was located. No freshness implementation was found in the inspected Memory Lane branch or feeder tree. The detailed October 14 freshness proposal was not retrieved; this branch does not assert that no implementation exists elsewhere. Private doctrine, handoff contents, credentials and memory bodies were not copied into this public repository.

The previously reported 2,964-block production chain, feeder operation and historical live costs were not independently reproduced. Local sample/synthetic chain checks passed. The running write-auth setting was not changed.

## Implemented features

| Phase | Delivered behavior | Practical boundary |
| --- | --- | --- |
| A: correctness | Literal passage fast path before Jev; semantic evidence qualification independent of all-word overlap; fractional support floor from labeled offline contracts; promoted candidates retain identity/lineage/hash; stale and tampered sources excluded; query-aware exact source spans; contradiction abstention | Live support calibration remains provisional; semantic retrieval still needs lexical/entity candidate recall |
| B: temporal | Versioned deterministic projection; exact source spans/hashes; trusted source attestations; historical/effective/observed time; explicit supersession; verification/authorization separation; conflicts and unresolved state | Requires explicit sealed `@temporal` assertions and operator attestations; ordinary prose is not automatically promoted |
| C: advanced retrieval | Existing two-hop graph retained; strict edge/bridge/lookup caps; cross-session evidence bundles; temporal boundary filtering; deduplication; missing-entity reporting | Bundles are candidate evidence, not verified composite reasoning; no invented event ordering or missing links |
| D: freshness | Authenticated namespace-scoped session endpoint; `SESSION_OPEN`, five-hour `WAKE`, closeout relationships; asynchronous enqueue; persisted bounded retries; idempotent append; failure and permission receipts; anchors excluded from scoped substantive search | Production clients/hooks not reconfigured; deferred synchronous I/O can still occupy the event loop after 202 |
| E: extraction | Section-aware paginated candidates; exact spans; long-fragment chunking; deduplication; deterministic entity/date hints; one coverage-selected ingest batch; resumable source-bound enrichment; dry-run scope/cost plan | Enrichment checkpoints are not yet consumed by a new ranking policy; automatic paid bulk processing is absent |
| F: planner/cache | Deterministic, ranked and evidence-assembly tiers; bounded LRU; keys include root, source fingerprint, request, principal, full policy, model and retrieval version; revocation/tamper/new-record invalidation | Cold scoped authorization/hash verification and index construction still scan source data; no speculative paid prefetch |
| G: governance | Sealed namespace on new records; read/write grants; per-namespace external decisions; redaction/minimization; outbound receipts; HTTP/CLI/MCP enforcement; post-await policy checks; legacy write auth defaults to enforced; exclusive append lock | Filesystem administrators remain trusted; old unscoped mode is preserved when no policy is configured; live policy and feeder migration require review |
| H: evaluation | Repeatable synthetic baseline comparison; regression suite; transport timeout tests; captured outbound-schema tests; security tests through real HTTP/CLI/MCP entry points | No paid integration run, private evaluation set, production-scale concurrency run or independent Jev accuracy measurement |

No generative answer path, local model, new database service, dependency or paid integration was introduced.

## Tests and acceptance evidence

Commands: `npm test`, `node tools/secret_scan.mjs`, `git diff --check`, and syntax checks on changed JavaScript entry points. Local runtime: Node.js 24.18.0 on Windows. Existing CI runs the suite on Node.js 22/Linux; its result is recorded in the PR delivery evidence, not assumed here.

| Mandatory fixture | Evidence |
| --- | --- |
| Exact-match success / zero calls | V3 retrieval fast-path fixture |
| Different vocabulary / paraphrase | Supported migration fixture and offline benchmark |
| Conflicting historical records | Answer conflict and temporal conflict fixtures |
| New speculation vs verified completion | Temporal authority fixture |
| Promotion outside lexical pool | Actual JevRank mapping with captured offline decision response |
| Late transcript answer | Source span/hash regression and benchmark |
| Multi-session evidence | Bounded bundle fixture and multi-session benchmark |
| Jev unavailable | Honest abstention fixture |
| Jev timeout | Stalled response-body abort fixture plus answer fallback |
| Interrupted enrichment | Failed batch cursor/resume fixture |
| Duplicate anchor retry | Replayed durable task yields one sealed record |
| Namespace access attempt | HTTP, CLI, MCP and cache fixtures |
| New-record cache invalidation | Scoped retrieval fixture |
| Empty/corrupted projection | Unknown result for invalid projections and malformed event rows |
| Source hash mismatch | Retrieval, temporal and cache fixtures |
| Permission revocation | Cache, anchor writer, HTTP policy removal/corruption fixtures |
| Historical as-of | Temporal effective/observed time fixtures |
| Low confidence / conflicts | Provisional fractional-score calibration and abstention fixtures |

Additional checks cover explicit namespace writes, dry-run maintenance against a real temporary library, long sentence retention, whole-transcript section sampling, source-preserving enrichment, closeout links, restart freshness, competing writer lock, and existing source chain verification. Test libraries are temporary and contain synthetic data only.

## Before/after measurements

Files: `benchmarks/v3-baseline.json`, `benchmarks/v3-current.json`; harness: `tools/benchmark-v3.mjs`. Both use the same six-record synthetic corpus, 100 measured iterations per workload, one unmeasured warm-up and a warm library object. A deterministic score-2 stub adds a simulated 5 ms transport delay. These are actual local end-to-end measurements under that fixture, not actual Jev response times. No real outbound provider call occurs.

| Workload | Baseline p50/p95/p99 ms | V3 p50/p95/p99 ms | Observed behavior |
| --- | --- | --- | --- |
| Exact passage | 15.568 / 29.220 / 32.236 | 3.448 / 4.986 / 5.222 | Simulated decision calls, including warm-up: 101 to 0; support retained |
| Paraphrase | 15.925 / 31.043 / 31.989 | 31.227 / 33.046 / 37.637 | Baseline abstained; V3 returned the expected original evidence under the stub |
| Buried late answer | 1.595 / 2.398 / 2.936 | 2.581 / 3.325 / 3.572 | Baseline returned the opening text; V3 returned the labeled supporting passage |
| No evidence | 3.790 / 5.175 / 5.716 | 5.094 / 6.451 / 6.810 | Both abstained 100/100; fixture false-positive rate 0 |
| Multi-session | 16.708 / 30.431 / 31.575 | 31.118 / 32.413 / 33.688 | Baseline abstained; V3 returned both labeled supporting records under the stub |

Recall@5 and Recall@10 were 1.0 for both builds on all four answerable synthetic workloads. This corpus demonstrates correctness repairs, not a general recall improvement. Late-passage evidence precision changed from 0 to 1.0. Paraphrase and multi-session baseline precision is undefined because it abstained; V3 fixture precision was 1.0. These checks validate source-selection plumbing with an intentionally deterministic scorer, not provider judgment quality.

Section sampling covered 3/8 input sections on the baseline and 8/8 with V3, with the ingest batch held at 30 candidates. Full paginated coverage is tested separately. V3 temporal fixtures returned the expected state on 3/3 labeled historical queries; the baseline has no temporal projection API, so its temporal accuracy is unmeasured rather than reported as zero.

## Current candidate benchmark

The original V3 comparison above is historical, from the Oct 16 implementation report. The Oct 28 PR follow-on re-ran the synthetic-only benchmark; its actual same-run metrics are preserved in `benchmarks/v3-current.json` (SHA-256 recorded in the release manifest). Do not compare the old table's V3 column to a later benchmark run; neither run measures live Jev quality.

Observed real provider cost during development: **$0**. Actual paid provider calls: **0**. Stub usage costs are zero by construction. Backfill estimates use the historical per-question estimate and are labeled estimates; no live cost/query was measured. Unknown attempted-call costs stay unknown in new failure receipts. Reported source probabilities/distributions are retained when available, without pretending that missing distributions exist.

## Files changed

- Retrieval/governance: `lib/answer.js`, `lib/evidence.js`, `lib/jevrank.js`, `lib/access.js`, `lib/retrieval.js`, `lib/retrieval-policy.js`, `lib/graph.js`.
- Canonical append/ingest: `lib/memoryLaneCore.js`, `lib/extract.js`, `lib/extraction-pages.js`, `lib/enrichment.js`, `lib/freshness.js`.
- Interfaces: `server.mjs`, `tools/memory-lane-cli.mjs`, `tools/memory-lane-mcp.mjs`, provider description/schema text in `hermes-plugin/memory-lane/__init__.py` and `plugin.yaml`.
- Maintenance/evaluation: `tools/v3-project.mjs`, `tools/benchmark-v3.mjs`, `tools/hermetic-env.mjs`, `package.json`, `.gitignore`, the two benchmark JSON files.
- Tests: five `tests/memory-lane-v3-*.test.mjs` suites and `tests/v3-fixtures.mjs`.
- Documentation: `docs/MEMORY_LANE_V3.md`, `docs/V3_SECURITY_AND_OUTBOUND.md`, `docs/V3_MIGRATION_AND_ROLLBACK.md`, this report, and README navigation.

## Deferred features, limitations and operational risks

1. Founder-labeled private-corpus evaluation and actual Jev integration/cost calibration. Offline synthetic scores are not empirical live confidence calibration. Provider changes require reevaluation.
2. Automatic natural-language temporal extraction, ambiguous entity resolution and relative-date interpretation. Callers use explicit entity IDs and absolute timestamps. This avoids turning unverified prose into operational truth.
3. Automatic installation of the session hook into the running Hermes/Office/feeders. The authenticated endpoint and tested queue are delivered; actual deployment wiring remains a cutover task. The detailed October 14 proposal still needs operational reconciliation.
4. A worker-based durable ingestion service. Current queued callbacks return immediately but use synchronous canonical I/O afterward; very large libraries and slow disks need separate load testing. A 202 receipt is not a guarantee that sealing already completed.
5. Automatic consumption of enrichment checkpoints by a new retrieval policy. The rebuildable, resumable backfill mechanism is delivered, but a new fact-ranking policy needs measured benefit first.
6. Cryptographic source attestation and trusted time infrastructure. Operator source-hash attestations and sealed source timestamps are the trust inputs. Self-reported verification never grants authority.
7. Power-loss transactions across block, shelf manifest and master manifest. Cooperating writers are locked; crash recovery and third-party writer compatibility still need operational review. A stale writer lock fails closed and requires inspection.
8. Legacy mixed-namespace ownership migration. Old sealed bytes remain untouched. Unlabeled records use the operator-selected legacy namespace. No source ownership is guessed.
9. Public/default-branch integration. The PR targets the existing Jev-only branch. Merging or replacing `main` requires a separate review because it diverges from that baseline.

## Rollback and remaining approvals

See `docs/V3_MIGRATION_AND_ROLLBACK.md` for the concrete dry-run, cutover and rollback commands/checks. Back up the live library/configuration, verify its actual chain, preserve tokens/policy and source attestations, and disable new lifecycle callers before rolling back executable code. Derivative indexes can be rebuilt or discarded; newly sealed anchors remain immutable history. Old readers do not enforce V3 policy, so rollback must not expose them to client scopes.

Remaining founder approval requirements: production deployment/restarts and feeder reconfiguration; any bulk paid backfill with an explicit reviewed scope/cost plan; acceptance of live calibration and production results. No deployment or founder acceptance is implied by a passing test suite or a draft PR.

## October 28 founder order follow-up

Requested base was verified as `c571fa5042bd7eda9560c85bdf4df18f158b24b0` on `origin/codex/ml-v3-20261016`; the shared worktree was clean and detached at inspection. The changes below are in the shared worktree but could not be committed: workspace policy makes `.git` read-only, and creating the requested local branch failed when Git could not create `.git/index.lock`. The base SHA therefore remains the last commit SHA; it is not a SHA for these working-tree changes.

Implemented in this checkout:

- Added one hash-checked V3 session-start selector with bounded recent candidates, freshness fallback, optional Jev selection under namespace policy, and explicit anchor exclusion.
- Wired V3 recent selection and scoped `ml_query` through CLI, authenticated HTTP (`POST /api/v3/recent`), MCP, and Hermes prefetch. Added Hermes session-start, user-message, and optional closeout callbacks; activity is disabled unless endpoint, namespace, and access token are explicitly configured.
- Added cross-entry-point E2E coverage and the team/feeder activation contract in `docs/V3_TEAM_AND_FEEDER_ACTIVATION.md`.
- Extended the secret scanner to include untracked non-ignored source files so new deliverables are covered before staging.

Verification from the shared checkout: `npm test` passed 175/175; `npm run benchmark:v3` passed all five synthetic workloads, temporal fixture 3/3, chain 6/6, and recorded zero real provider calls; `node tools/secret_scan.mjs` reported clean. Benchmark output used a deterministic Jev stub and is not live Jev calibration. The Hermes runtime itself and its `on_user_message` dispatch were not available for runtime verification.

Hard gates remain: the private labeled evaluation corpus and approved live Jev calibration environment were not present, so no private evaluation or paid provider call was run; the four feeder repositories and their identities were absent from this checkout, so only the shared endpoint contract and Hermes source integration were delivered; and the team's active profiles/service cannot be changed under the order's no-config/no-restart/no-deploy constraints. Team activation still requires review of the private corpus results, feeder revisions/namespaces, installed Hermes hook support, and explicit cutover authorization.

2ndNatureAi
