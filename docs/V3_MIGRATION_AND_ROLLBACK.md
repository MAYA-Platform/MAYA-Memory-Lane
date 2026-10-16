# V3 migration, backfill and rollback

Production cutover and bulk paid backfill require founder approval. None was performed during development.

## Development verification

```sh
npm test
node tools/secret_scan.mjs
node tools/benchmark-v3.mjs --output benchmarks/v3-current.json
```

For the before measurement, check out commit `2a569c88b83168c73a32472cc7e7332f46562a57` into a separate directory and run the **new** benchmark script with `--module-root <baseline-checkout> --output benchmarks/v3-baseline.json`. Both runs use identical synthetic data, 100 measured warm-library calls per workload, and a stubbed 5 ms decision transport. No private source or paid provider is required. Results vary by machine and load. The baseline fixture suite is independently reproduced at 124/124; seven original regression cases were demonstrated failing on that source before fixes.

## Projection dry run

Use a sandbox copy of a library, install an operator-reviewed access policy, and place the matching bearer token in a protected file outside version control:

```sh
node tools/v3-project.mjs --library <sandbox> --token-file <protected-token-file>
node tools/v3-project.mjs --library <sandbox> --token-file <protected-token-file> --backfill 1
```

The first command reports temporal projection scope. The second reports candidate count, batch count and a clearly labeled historical per-question cost estimate. Neither writes a projection or calls a provider. Canonical block hashes are checked. Empty or invalid events are reported rather than invented.

`--execute` without `--backfill` writes a disposable, principal-specific temporal projection under `projections/v3`. Normal retrieval rebuilds from canonical data and does not trust a cached file blindly.

After explicit founder approval of the dry-run scope and estimated expense, an operator may run:

```sh
node tools/v3-project.mjs --library <sandbox> --token-file <protected-token-file> --backfill 1 --execute --approved-cost-usd <approved-budget>
```

This executes **one** bounded scoring batch and saves a source-hash-bound checkpoint. Repeat deliberately to resume. A timeout or partial batch preserves the cursor; completed spans are not duplicated. Invalid checkpoints or changed source hashes are rejected. The approved amount checks the estimate, not a provider-enforced billing cap; provider costs can differ. Do not loop over the founder library without a separate approved scope and spend plan.

Enriched facts are stored independently of sealed records. Feeding those checkpoints into new ranking/index policies is deferred pending a measured retrieval benefit; the initial planner continues using canonical source text.

## Founder-gated cutover

1. Back up the live canonical library, service configuration, policy, token files, and code revision. Record and verify its actual block count and chain verdict; development tests do not verify the reported 2,964-block live library.
2. Reproduce tests and benchmark on the deployment runtime. Review the PR and confirm all live feeders are compatible with enforced write auth and the exclusive writer lock.
3. Review legacy namespace ownership. Create policy entries for owner/company/agents/clients and strong independent tokens. Keep external decisions disabled by default. Configure the serving process so the access policy cannot silently disappear on restart.
4. Run dry-run projections on a sandbox copy. Add only reviewed source-hash attestations. Do not treat unstructured historic claims as verified events.
5. Wire lifecycle callers to authenticated `/api/v3/session` for each user message and optional closeout references. Test against a sandbox first. The production Hermes plugin and four feeder deployments were not altered by development.
6. Validate live Jev outputs on a separately approved, minimized labeled corpus. Replace provisional offline calibration only after measuring precision, recall, abstention, latency and cost. This step is not covered by the simulated transport benchmark.
7. Obtain explicit founder approval before changing the running deployment. Then cut over deliberately, verify health/auth/chain/search, and inspect scoped receipts.

## Rollback

Stop the V3 service and its cooperating writers. Restore the previous executable revision and service configuration from the recorded backup, with an explicit review of write authentication: the baseline defaults to shadow mode. Preserve the access policy and tokens securely; do not publish them. Disable new lifecycle callers. Derivative `projections/v3` files may be rebuilt or discarded after backup. Preserve audit/failure receipts as operational evidence.

Existing sealed records require no down migration. New namespace/anchor frontmatter remains valid markdown to old readers; old readers may surface anchors and do not enforce V3 namespace policy. Do not expose an old unscoped reader to client credentials. New anchors are ordinary chain-linked records: never delete or rewrite them to roll back code.

For `writer_busy`, verify that no writer still owns `.append.lock` before manually clearing a stale lock. Never steal it based only on elapsed time. After any interrupted append, inspect manifest, shelf manifest, source hashes and chain links before resuming writes. No automated repair rewrites canonical history.
