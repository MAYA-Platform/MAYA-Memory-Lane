# V3 team and feeder activation contract

This repository now provides one scoped V3 retrieval path for CLI, HTTP, MCP,
and the Hermes MemoryProvider. Session activity is posted to authenticated
`POST /api/v3/session`; session-start selection uses the bounded V3 recent
planner. This document describes how a team deployment adopts those paths.

## Scope and privacy boundary

The Hermes session-activity POST contains a session identifier, timestamp, runtime name, namespace, and an empty `sketch`. It does not send a first message or transcript to that endpoint. Session-start **prefetch is a separate read path**: when the authorized namespace has `externalJev: true`, its user-derived query (up to 500 characters) and at most 12 source excerpts (up to 200 characters each) can reach the configured Jev decisions endpoint after best-effort redaction. Keep `externalJev: false` for the first deterministic pilot; enable it only after that namespace's egress consent and live calibration are accepted. `on_session_end(messages)` ignores the transcript; closeout linkage needs a separately verified sealed block ID.

Each feeder must use its own principal and approved namespace. A shared legacy library without `access-policy.json` is not ready for multi-principal V3 activation. Do not flip the team's provider route to V3 against the 3,130-record unscoped library. First inventory the owned feeder/profile consumers, choose owner-approved namespace mapping, classify/migrate legacy blocks without guessing ownership, stage an operator-owned policy and unique principal tokens, then test in an isolated profile/service. In policy-enabled mode every read surface must be authenticated and scoped; do not rely on legacy compatibility routes for tenant isolation.

## Required service configuration

The service library must have an operator-owned `access-policy.json`. Give each
runtime principal only the `read` and `write` namespaces it needs. Session
anchors require namespace write access. Set external Jev access separately for
each namespace; it remains disabled unless explicitly enabled.

For a Hermes profile, bind these values to its own protected secret scope or
profile `memory_lane` configuration after deployment review. The bearer must
come from that profile's secret scope; namespace and session URL may be
profile config values. Never inject another profile's values into process globals:

```text
MEMORY_LANE_LIBRARY=<mounted-library>
MEMORY_LANE_ACCESS_TOKEN=<token-for-the-Hermes-principal>
MEMORY_LANE_NAMESPACE=<assigned-namespace>
MEMORY_LANE_SESSION_URL=https://<memory-lane-host>/api/v3/session
MEMORY_LANE_CLI=<path-to-this-repository>/tools/memory-lane-cli.mjs
```

Loopback HTTP is accepted for isolated local use. Remote session URLs must use
HTTPS. The plugin starts activity delivery only when URL, namespace, and token
are all present. Its `sketch` is empty; no message text or transcript is sent
to the session endpoint. A Jev-enabled prefetch can send the bounded query and
candidate excerpts described above.
Session activity is best-effort and queued by the service; delivery failure
does not block chat. The installed Hermes `MemoryManager` dispatches
`on_turn_start` before prefetch on each real turn. Initialization alone does
not create a session activity event.

## Feeder migration contract

Each feeder must send `POST /api/v3/session` on each user message using its own
principal and assigned namespace. The authenticated request body is:

```json
{
  "namespace": "agent",
  "sessionId": "runtime-session-id",
  "timestamp": "2026-10-28T16:00:00Z",
  "runtime": "feeder-name",
  "sketch": "Short sanitized first-message sketch"
}
```

On closeout, send `closeBlockId` only after the closeout is sealed in that same
namespace. The endpoint validates its source hash and ownership before writing
the relationship. Use the same scoped principal for V3 reads:

- `POST /api/v3/query` for evidence, bundles, and explicit temporal queries.
- `POST /api/v3/recent` for session-start context.
- `GET /api/search?q=...&rerank=jev` only when lexical search output is needed
  and the namespace allows external Jev decisions.

Do not call the legacy unscoped recent/export routes from a policy-enabled
feeder. Do not write freshness anchors directly into the library; the service
owns the queue, receipts, retries, deduplication, and append lock.

## Deployment inventory and acceptance matrix

The source checkout does not identify the four deployed feeder
repositories. Their identities are not inferable from this repo alone. Do not guess their names or infer their owner namespaces. For
each feeder, record the repository and revision, runtime principal, namespace,
message hook, closeout source, service URL, and a synthetic test receipt before
enabling it.

| Entry point | Session start / recent | V3 evidence and temporal query | Freshness activity | Namespace and Jev policy |
| --- | --- | --- | --- | --- |
| CLI | `recent [limit] [query]` | `query '<request JSON>'` | HTTP lifecycle endpoint via service adapter | policy-scoped; source checked |
| HTTP | `POST /api/v3/recent` | `POST /api/v3/query` | `POST /api/v3/session` | bearer principal; per-namespace Jev opt-in |
| MCP | `ml_recent`, `ml_query` | `ml_query` | host calls lifecycle endpoint | access token scopes reads/writes |
| Hermes provider | `prefetch()` / `ml_recent` | `ml_query` | `on_turn_start`; no closeout inferred from transcript | URL, namespace, and token configured explicitly |
| Feeder 1–4 | call `/api/v3/recent` | call `/api/v3/query` | call `/api/v3/session` per message | inventory and test before activation |

The repository E2E suite verifies CLI, HTTP, and MCP against temporary synthetic
libraries. With `HERMES_AGENT_SOURCE` and `HERMES_PYTHON` set, it also loads the
installed Hermes `MemoryManager` under two real profile secret scopes and fake
profile homes. It tests turn dispatch, `prefetch_all`, scoped CLI child values,
session switch, wrong/unscoped refusals, and metadata-only activity against an
isolated loopback receiver. A stubbed Jev test checks the separate consented
decisions payload and confirms zero calls when `externalJev` is false.
Private feeder runtimes and active team profile configurations remain unverified.

## Activation gates

Before enabling the team provider or feeders:

1. Install the reviewed plugin package and supported hooks in a test Hermes
   profile; verify start, message, switch, and closeout callbacks.
2. Inventory the four feeder repositories and migrate each callback to the V3
   endpoints, then run the acceptance matrix in a sandbox.
3. Evaluate a founder-labeled private corpus and calibrate Jev with the actual
   decisions provider, recording precision, recall, abstention, latency, and
   cost. Keep external decisions disabled for namespaces that have not passed.
4. Review policy ownership, receipts, token storage, library chain, and rollback
   plan. Only then update team profiles or restart a service.

No production service, active profile, feeder deployment, private corpus, or
paid provider call is changed by repository tests or this integration.

2ndNatureAi
