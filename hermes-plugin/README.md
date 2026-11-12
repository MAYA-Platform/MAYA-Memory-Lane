# Memory Lane — Hermes MemoryProvider plugin

A drop-in `MemoryProvider` that wires Memory Lane (local-first, zero-dependency,
chain-verified memory) into Hermes as a first-class memory backend — appearing
in the same settings menu as Honcho, Mem0, and Supermemory.

## What it is

Memory Lane is a MIT-licensed memory library with a local storage and
verification path:

- **SQLite FTS5** retrieval (61% recall@5 on LongMemEval — above hosted Honcho
  at 40%, and competitive with Mem0's dense+hosted lane while staying local).
- **SHA-256 chain-verified blocks** — every memory block is linked to its
  predecessor and verified, so corruption is detectable (Bitcoin-style
  integrity, but no tokens/mining/consensus).
- **Local legacy mode** — the v1 path needs no hosted account. A V3 namespace
  may explicitly allow bounded query and excerpt egress for Jev decisions.

## How it works

The provider shells out to a tiny Node CLI bridge
(`tools/memory-lane-cli.mjs`) over the existing core library, so it inherits
the exact FTS5 retrieval + chain-verification path — no reimplementation.

**Read side (the differentiator)** — four tools, same names as the MCP server:

| Tool | Purpose |
|------|---------|
| `ml_recent` | Digest of recent blocks (with content excerpts) — session start |
| `ml_search` | Full-text search across all blocks |
| `ml_resume` | Resolve a resume phrase / `cb_...` block id |
| `ml_answer` | Natural-language question → exact or Jev-selected source passages; no generated prose |
| `ml_query` | V3 scoped evidence, bundle, or temporal query |

**Auto-resume** — `prefetch()` uses the V3 recent selector once at session
start, verifies source hashes, excludes freshness anchors, and injects a small
set of recent source excerpts. Jev can reorder that set only when the caller's
namespace explicitly permits external Jev decisions.

The provider exposes session lifecycle callbacks. To send activity to an
isolated V3 service, configure `MEMORY_LANE_SESSION_URL` (full
`/api/v3/session` URL), `MEMORY_LANE_NAMESPACE`, and the principal's
`MEMORY_LANE_ACCESS_TOKEN` in the owning Hermes profile scope or config as
described below. Remote
URLs must use HTTPS; loopback HTTP is allowed for local development.
The installed Hermes `on_turn_start` callback reports session activity with
an empty sketch. A separate Jev-enabled prefetch may send a bounded,
redacted user-derived query and source excerpts when the namespace permits it.
The bearer and read path are resolved from the owning profile's secret scope;
namespace and session URL can also come from its profile config.
Without a profile-scoped V3 bearer, policy-scoped retrieval and session writes
are refused. The single-owner legacy path keeps its compatibility behavior.

**Write side** — durable writes are handled by the Session Auto-Sealer
(session → continuity block → ingest), so the provider is deliberately
read-focused to avoid double-sealing.

## Install

```bash
# Copy into the user-plugin directory (appears in Settings → Plugins → Memory provider)
mkdir -p "$HERMES_HOME/plugins/memory-lane"
cp hermes-plugin/memory-lane/* "$HERMES_HOME/plugins/memory-lane/"

# Or symlink
ln -s "$PWD/hermes-plugin/memory-lane" "$HERMES_HOME/plugins/memory-lane"
```

Then set `memory.provider: memory-lane` in `config.yaml`, or select it in the
Desktop app's Plugins panel (it appears alongside Honcho / Mem0 / Supermemory).
For a copied plugin, set `MEMORY_LANE_CLI` to the checkout's
`tools/memory-lane-cli.mjs`; the bridge imports the sibling `lib/` directory,
so copying only the plugin folder is not a standalone installation. A symlink
to this repository discovers the bridge automatically.

## Config (env vars, all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `MEMORY_LANE_LIBRARY` | `~/.memory-lane` | Library directory |
| `MEMORY_LANE_CLI` | `<repo>/tools/memory-lane-cli.mjs` | Node bridge script |
| `MEMORY_LANE_SESSION_URL` | unset | Authenticated V3 session activity endpoint |
| `MEMORY_LANE_NAMESPACE` | unset | Namespace granted to this Hermes principal |
| `MEMORY_LANE_ACCESS_TOKEN` | unset | Existing principal token, also used by the CLI bridge |

## Requirements

- Node.js (for the FTS5 bridge) — no other dependencies, no API key, no network.
