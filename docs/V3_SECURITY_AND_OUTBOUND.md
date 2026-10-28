# V3 security and outbound-data review

Review scope: repository code and synthetic local fixtures, not the running production configuration or private library. The repository is public. No private work orders, doctrine contents, tokens, user records or local machine paths are included in this change.

## Data leaving the machine

The Jev-only architecture is local-first, not entirely offline when decisions are enabled. Query ranking POSTs to the configured decisions endpoint: model ID, a query capped at 500 characters, at most 12 candidate passages capped at 200 characters each, and typed score questions. Full source bodies and complete conversations are not sent by ranking.

Ingest durability scoring sends at most one coverage-selected batch of 30 candidate fragments by default. Its context is empty; candidate values remain bounded to 200 characters in state and 140 characters in the criteria. Explicit backfill also sends bounded batches and never runs automatically. The generic extraction helper caps batches at 100 candidates and context at 600 characters. No chat-completion/prose endpoint is introduced.

Email addresses, common credential assignments, bearer strings and a common personal identifier shape are redacted. This is minimization, not a comprehensive DLP classifier: names, business facts, financial amounts and unrecognized secrets may still appear. Keep `externalJev: false` for sensitive namespaces. A scoped request is denied external scoring if any namespace represented in its candidate corpus disallows it; this errs toward privacy at the cost of recall.

Raw queries were removed from new JevRank receipts in favor of a digest and a redacted placeholder. Receipts include model, count, outcome, timing, and reported or estimated cost. V3 audit events contain principal/namespace and source references, not source bodies or tokens. Existing historic logs are not rewritten or scrubbed by this branch. Extraction returns provider usage when available; no new live cost measurements were taken.

## Enforcement boundaries

- Filesystem access is the local ownership boundary. Protect library, policy, token and projection paths with OS permissions. V3 does not encrypt files or isolate an administrator with direct filesystem access.
- HTTP remains bound to loopback. Policy enables bearer authentication and namespace grants before retrieval. CLI/MCP require the same secret token when policy is present.
- All new anchor writers require explicit write permission, including after retries. Existing HTTP writes enforce token auth by default. Explicit legacy shadow mode is retained for compatibility and should not be used during V3 cutover.
- New records seal their namespace. Legacy records need a reviewed ownership mapping; no automatic client ownership guesses are made.
- Query caches include identity, permissions, source hashes and root. Policy reload and post-await checks cover revocation. A policy removed from a running service fails closed. After a restart an absent policy selects legacy single-owner mode, so deployment must keep the policy mounted and monitored.
- Temporal verification comes from operator attestations pinned to source hashes. Jev relevance cannot grant approval or verification. The projection reports conflicts and defaults authorization to false.
- Sealed-block writes remain on `appendBlock`, now guarded by an exclusive lock. This prevents cooperating V3 writers from racing; it is not a transaction across arbitrary third-party registrars or a guarantee of recovery from power loss.

## Evidence and residual work

Tests exercise HTTP, CLI and MCP namespace filtering, cache isolation, policy revocation/removal/corruption, source tampering, authentication failures, denied cross-namespace writes, and outbound minimization. Offline stubs capture actual generated payloads and verify decision-only schemas. No paid integration or private corpus was transmitted.

The reported live write-auth setting was not inspected or changed. Before cutover, review the running service account, bearer-token storage, feeder credentials, namespace ownership, attestation process, endpoint configuration, and external-call opt-ins. Revocation tests are not a claim that the existing live deployment already enforces these new policies.
