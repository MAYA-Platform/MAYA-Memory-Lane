# Memory Lane — Hermes MemoryProvider plugin

A drop-in `MemoryProvider` that wires Memory Lane (local-first, zero-dependency,
chain-verified memory) into Hermes as a first-class memory backend — appearing
in the same settings menu as Honcho, Mem0, and Supermemory.

## What it is

Memory Lane is a MIT-licensed memory library that runs entirely offline on
consumer hardware:

- **SQLite FTS5** retrieval (61% recall@5 on LongMemEval — above hosted Honcho
  at 40%, and competitive with Mem0's dense+hosted lane while staying local).
- **SHA-256 chain-verified blocks** — every memory block is linked to its
  predecessor and verified, so corruption is detectable (Bitcoin-style
  integrity, but no tokens/mining/consensus).
- **Zero dependencies** — no API key, no cloud, no account. Your memory never
  leaves the machine.

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
| `ml_answer` | Natural-language question → exact or synthesized answer |

**Auto-resume** — `prefetch()` pulls the most recent blocks once at session
start and injects their content as context, so a fresh session begins already
knowing where the last one left off.

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

## Config (env vars, all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `MEMORY_LANE_LIBRARY` | `~/.memory-lane` | Library directory |
| `MEMORY_LANE_CLI` | `<repo>/tools/memory-lane-cli.mjs` | Node bridge script |

## Requirements

- Node.js (for the FTS5 bridge) — no other dependencies, no API key, no network.
