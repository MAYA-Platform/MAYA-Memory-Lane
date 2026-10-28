# V3 team and feeder activation contract

This repository now provides one scoped V3 retrieval path for CLI, HTTP, MCP,
and the Hermes MemoryProvider. Session activity is posted to authenticated
`POST /api/v3/session`; session-start selection uses the bounded V3 recent
planner. This document describes how a team deployment adopts those paths.

## Scope and privacy boundary

This provider build exports session identifiers, timestamps, runtime name, namespace, and an optional verified sealed closeout id. It does **not** export first messages, user-message text, or end-of-session transcripts. The V3 endpoint supports a minimized `sketch`, but this Hermes integration deliberately leaves it empty until a separately reviewed, explicit per-namespace export-consent design exists. `MemoryProvider.on_session_end(messages)` receives the transcript; this callback ignores it rather than treating it as an ID.

Each feeder must use its own principal and approved namespace. A single shared legacy library without `access-policy.json` is not ready for multi-principal V3 activation. Do not flip the team's existing provider route to V3 against the 3,130-record unscoped library. First inventory the owned feeder/profile consumers, choose owner-approved namespace mapping, classify/migrate legacy blocks without guessing ownership, stage an operator-owned policy and unique principal tokens, then test in an isolated profile/service. In policy-enabled mode every read surface must be authenticated and scoped; never rely on legacy compatibility routes as tenant isolation.

## Scope and privacy boundary

The provider now exports session identifiers, timestamps, and runtime name only. It does not export first messages, user-message text, or end-of-session transcripts. The V3 endpoint supports a minimized `sketch`, but this Hermes integration deliberately leaves it empty until an explicit per-namespace export-consent design exists. Hermes calls `MemoryProvider.on_session_end(messages)` with the transcript; this callback ignores it rather than treating it as a closeout ID. Closeout linkage is deferred until Hermes can provide a separately verified sealed block ID.

Each feeder must use its own principal and approved namespace. A shared legacy library without `access-policy.json` is not ready for multi-principal V3 activation. Do not flip the team's provider route to V3 against the 3,130-record unscoped library. First inventory the owned feeder/profile consumers, choose owner-approved namespace mapping, classify/migrate legacy blocks without guessing ownership, stage an operator-owned policy and unique principal tokens, then test in an isolated profile/service. In policy-enabled mode every read surface must be authenticated and scoped; do not rely on legacy compatibility routes for tenant isolation.

## Required service configuration

The service library must have an operator-owned `access-policy.json`. Give each
runtime principal only the `read` and `write` namespaces it needs. Session
anchors require namespace write access. Set external Jev access separately for
each namespace; it remains disabled unless explicitly enabled.

For a Hermes profile, set these values in the profile's protected environment
or service secret store after deployment review:

```text
MEMORY_LANE_LIBRARY=<mounted-library>
MEMORY_LANE_ACCESS_TOKEN=<token-for-the-Hermes-principal>
MEMORY_LANE_NAMESPACE=<assigned-namespace>
MEMORY_LANE_SESSION_URL=https://<memory-lane-host>/api/v3/session
MEMORY_LANE_CLI=<path-to-this-repository>/tools/memory-lane-cli.mjs
```

Loopback HTTP is accepted for isolated local use. Remote session URLs must use
HTTPS. The plugin starts activity delivery only when URL, namespace, and token
are all present. It submits a bounded, redacted sketch and does not put message
bodies in the URL or logs. Session activity is best-effort and queued by the
service; delivery failure does not block chat. The plugin's `on_user_message`
hook must be supported by the installed Hermes runtime for ongoing activity
timestamps. `initialize` / `on_session_start` still report the session start.

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
| Hermes provider | `prefetch()` / `ml_recent` | `ml_query` | session-start, user-message, optional closeout hooks | URL, namespace, and token configured explicitly |
| Feeder 1–4 | call `/api/v3/recent` | call `/api/v3/query` | call `/api/v3/session` per message | inventory and test before activation |

The repository E2E suite verifies CLI, HTTP, MCP and the Hermes bridge contract
against temporary synthetic libraries. It does not prove that an installed
Hermes version dispatches `on_user_message`, that private feeder runtimes send
the specified payload, or that a live policy grants those principals. Those
checks require the four feeder revisions and an isolated deployment sandbox.

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
