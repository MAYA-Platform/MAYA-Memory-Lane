# Memory Lane V3 development foundation

This branch extends the Jev-only baseline. It does not deploy a service or migrate an existing library automatically. Sealed records remain canonical; temporal and enrichment projections are disposable. Node.js 22 or newer is required.

## Retrieval contract

`answerQuestion(library, question, options)` retains `direct | jev | none` and returns original source text. Evidence adds `source_hash` and `spans[]` with `{source_block_id, source_hash, start, end, offset_unit: "utf16", text}`. Reproduce a span with `raw.slice(start, end)` after verifying the block hash. These are JavaScript character offsets, not UTF-8 byte offsets.

Tier 0 handles an unambiguous literal passage lookup without a decision call. A natural-language question, scattered term overlap, or conflicting candidates cannot take that shortcut. Tier 1 makes one bounded Jev batch, then checks source identity and hashes again. Tier 2 assembles multiple independently verifiable records or runs a temporal query. A candidate bundle is explicitly labeled `candidate_bundle`; it is not a verified composite conclusion.

Jev sees at most 12 candidate passages of 200 characters each and a minimized query of at most 500 characters. The answer returns the same selected source passage used for semantic scoring. Failure, timeout, unusable scores and insufficient support abstain. Basic text conflict checks are deliberately conservative; structured temporal queries provide the stronger authority and supersession model.

The support floor is derived from versioned, labeled **synthetic** fixtures in `lib/retrieval-policy.js`. It is provisional. It has not been calibrated on live provider outputs or a private evaluation set. Query-time relevance is never temporal verification or authorization.

## Operator-owned access policy

Place `access-policy.json` in the library root. Keep it outside version control and protect its filesystem permissions. Version 1 contains:

```json
{
  "version": 1,
  "legacyNamespace": "founder",
  "namespaces": {
    "founder": { "externalJev": false },
    "company": { "externalJev": false },
    "agent": { "externalJev": false },
    "client-a": { "externalJev": false }
  },
  "principals": {
    "operator": {
      "token_sha256": "<SHA-256 of a strong independently generated bearer token>",
      "read": ["founder", "company", "agent"],
      "write": ["founder", "agent"]
    }
  },
  "authorities": {}
}
```

Namespace names are arbitrary scoped identifiers. New records seal `namespace` into frontmatter. Old records retain their bytes and belong to the configured `legacyNamespace`; mixed legacy libraries need an explicit ownership review before sharing. A record is excluded if its computed hash disagrees with the manifest. Authorization filters records **before** building lexical/graph indexes or calling Jev.

Policy-enabled HTTP calls require `Authorization: Bearer <token>`. CLI and MCP bridges use the secret `MEMORY_LANE_ACCESS_TOKEN`. The operator can explicitly grant `admin: true` with read access to every configured namespace for legacy library-wide routes. Ordinary principals can use scoped search, answer, ingestion and V3 routes. Policy is reloaded on each HTTP request and checked again before returning an awaited result. Policy corruption or removal after activation fails closed. Do not remove the policy and restart into legacy mode.

Without a policy, the preexisting single-owner, loopback read API remains available. It is not a multi-tenant security boundary. Legacy writes now enforce the existing write token by default; explicit `MEMORY_LANE_WRITE_AUTH=off` retains the old compatibility mode. New session writers always require policy authentication and a namespace write grant.

## HTTP API

`POST /api/v3/query` accepts one of these authenticated request bodies:

```json
{ "query": "release ticket ZX-582" }
```

```json
{ "query": "Orchid", "bundle": true, "limit": 10,
  "before": "2026-10-14T00:00:00Z", "requiredEntities": ["Hermes", "Forge"] }
```

```json
{ "entity": "orchid-migration", "predicate": "status",
  "asOf": "2026-10-13T23:59:59Z", "knownAt": "2026-10-13T23:59:59Z" }
```

Entity IDs and absolute timestamps are supplied by the caller. Automatic entity disambiguation and relative date interpretation such as “last Tuesday” are not implemented. `knownAt` limits what had been observed; `asOf` limits effective time. Omit them for current time. Temporal results include current state, source-backed history, conflicts and unresolved IDs. Authorization is false without attested approval or when conflicting evidence exists.

`node tools/memory-lane-cli.mjs query '<request JSON>'` exposes the same planner to local integrations. Existing CLI and MCP tool names remain available and respect policy when configured.

`POST /api/v3/session` accepts:

```json
{ "namespace": "agent", "sessionId": "client-session-id",
  "timestamp": "2026-10-16T12:00:00Z", "runtime": "hermes",
  "sketch": "Short sanitized first-message sketch" }
```

The caller sends activity on each user message. The service returns 202 for best-effort queued work. The first event produces `SESSION_OPEN`; inactivity of at least five hours produces `WAKE`. A subsequent request with `closeBlockId` links the session to an existing hash-checked closeout in the same namespace. Session IDs are hashed. Sketches are bounded and minimized. Anchors are excluded from policy-scoped substantive retrieval.

Queues persist retry state, cap pending work, and record failures. Repeated writes deduplicate through canonical append. A durable permission receipt precedes writes. The implementation defers work with `setImmediate`; synchronous canonical I/O can still occupy the event loop afterward. This is not a worker-based ingestion system. Existing production feeders and Hermes lifecycle hooks have not been reconfigured; clients must explicitly wire the authenticated endpoint during cutover.

## Temporal projection schema

Each sealed assertion is an exact JSON line:

```text
@temporal {"entity_id":"orchid-migration","predicate":"status","state":"verified","value":"complete","effective_at":"2026-10-13T12:00:00Z","supersedes":["previous-source-block-id"]}
```

Ordinary prose is never automatically converted to operational truth. Version 1 events include stable event ID, entity, subject, predicate, value, state, source block/lib ID, source hash/type, observed/effective/superseded timestamps, supersedes, authority, verification status, verifier, confidence, namespace, lineage and original span. `confidence: null` means unmeasured, not zero confidence. The source manifest fingerprint versions the projection.

Authority comes from the operator's `authorities[<exact source hash>]` entry containing `authority_level`, `verified_by`, and optionally `source_type`. These attestations are trust configuration, not a model-generated index. A source cannot grant itself authority. A self-described verified completion without attestation is a claimed completion. A verified completion can advance a proposal; speculative later work cannot replace it. Accepted replacements otherwise require explicit supersession and sufficient authority. Conflicts remain visible. Authorization states require attestation and fail closed.

`observed_at` uses the sealed source timestamp, not a cryptographic timestamp service. Operators must attest source clocks and verifier identity appropriately. Automatic attestation and signature verification are outside this version.

## Bounds and caching

The existing graph stays in-process SQLite. Traversal remains at most two hops, with 2,000 candidate edges, 60 bridge entities, 400 neighbor lookups and at most 20 returned bundle sources. Stats expose actual walk counts. Index construction still scans the authorized corpus; bounded traversal does not make cold indexing constant time.

The LRU holds at most 128 results by default. Keys include request, source fingerprint, library root, complete policy, principal, model and retrieval version. Source hash checks occur before a cache hit, so tampering invalidates results. New records and policy changes invalidate results. Failed/abstaining model requests are not cached. No speculative paid prefetch runs.

Append operations acquire a per-library exclusive writer lock. Competing writers get `writer_busy` rather than overwriting an allocated ID. Crash recovery and stale lock removal require operator inspection; no timeout silently steals a live writer's lock. Readers and existing third-party writers must still honor the canonical format and locking contract.
