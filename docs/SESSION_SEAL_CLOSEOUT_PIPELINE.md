# Memory Lane — Session Seal Closeout Pipeline

**Feature spec · v1.0 · 2026-08-15**
**Status:** Live in the operator runtime; this document is the public-safe
description of how a sealed session is closed out *before* it becomes a
Memory Lane block.
**Owner:** MAYA / Hermes · **Repo:** MAYA-Platform/MAYA-Memory-Lane

---

## 1. Why closeout matters

A session that ends is not done when the last message is sent. If the only
thing that happens is "the conversation stops," then:

- working artifacts from the session can sit uncommitted in unrelated repos,
- tests can be broken and nobody notices,
- the memory block gets written from a *partial* view of the work,
- the next session resumes from a snapshot that does not reflect reality.

The **Session Seal Closeout Pipeline** fixes that: before a session is sealed
into Memory Lane, a deterministic final-pass sweep runs across every active
repository the operator touches. The seal only happens after the closeout
verifies what changed, runs the relevant tests, and commits scoped artifacts
with a reference to the block being written.

This is the same discipline a careful engineer applies when closing a long
working session by hand. The pipeline automates it so no session is ever
sealed with a dirty, unverified, or unpushed footprint behind it.

## 2. Pipeline order (iron-clad: final pass BEFORE the block)

```
session ended (idle threshold)
        │
        ▼
1. DETECT      — detector confirms the session ended; produces a pending_seal
        │
        ▼
2. SWEEP       — closeout sweep across all active repos:
                 git status, last commit, origin presence, dirty files
        │
        ▼
3. VERIFY      — run test suites in repos that have them;
                 a failing test blocks that repo's push (manual review note)
        │
        ▼
4. COMMIT      — commit scoped verified artifacts in every dirty repo
                 with an origin; message references the block id
        │
        ▼
5. PUSH        — push every repo with an origin
                 (local-only stores are backed up off-site on their own cadence)
        │
        ▼
6. LOG + MEM   — append closeout entry to the sprint log;
                 durable facts via the memory layer
        │
        ▼
7. REVIEW      — local code review of the latest commit (model-backed,
                 receipt recorded; proceeds even if the review model is down)
        │
        ▼
8. SEAL        — build + validate the block, register it in the library,
                 append the sealed-session ledger
        │
        ▼
9. FEED        — push the block into the Memory Lane live library
```

Steps 2–7 are the closeout. Step 8–9 are the seal. The closeout always
precedes the seal; a block is never written over an unverified workspace.

## 3. The closeout sweep

The sweep is a single deterministic report over every active repo:

| Field | Meaning |
|---|---|
| `exists` / `is_git` | repo reachable and a git worktree |
| `dirty_count` / `dirty` | uncommitted or untracked files |
| `last_commit` | current HEAD |
| `has_origin` / `origin` | whether the repo can be pushed |
| `tests` (optional) | test command result when the repo defines one |

The operator reads the report and acts on it: dirty + has origin → commit
scoped artifacts + push (test-gated). Dirty + local-only → commit, no push.
Clean → nothing to do. Missing repo → flagged, never silently skipped.

## 4. Test gate

Repos with test suites run them before their changes are pushed:

- a **passing** suite → changes may be pushed,
- a **failing** suite → that repo's changes are NOT pushed; the failure is
  recorded in the block for manual review,
- a **timeout / missing toolchain** → recorded, treated as review-needed,
  never as a silent pass.

The test gate exists so a seal can never freeze a broken state into memory.

## 5. Relationship to the auto-observation pipeline

The Auto-Observation pipeline (`docs/AUTO_OBSERVATION_SPEC.md`) captures
*in-session* signal and injects it into the next session. The Seal Closeout
pipeline captures the *end-of-session* work state and verifies it before the
block is written. They are complementary:

- **Auto-Observation** → "what happened during the session"
- **Seal Closeout** → "what the session left behind, verified"

Together they make Memory Lane's blocks trustworthy: the block is not just a
summary written at the end of a session, it is a summary written **after** the
workspace was checked, tested, committed, and pushed.

## 6. Boundaries

- The closeout commits and pushes **scoped verified artifacts** — it is not a
  blanket `git add -A` of everything everywhere. Unreviewed or out-of-scope
  changes are left for a human.
- Local-only stores are not pushed; their off-site backup is a separate
  scheduled concern.
- A failing test is a review signal, not a destructive action.
- The pipeline never seals the active session (idle threshold enforced), never
  duplicates a sealed session (ledger + watermark), and never touches
  unrelated stores beyond the documented feed.

## 7. Why this is part of Memory Lane

Memory Lane's value is that its blocks are **real** — chain-linked, auditable,
and trustworthy. A block written over an unverified workspace inherits that
unverifiability. The seal closeout is what guarantees the memory layer only
records sessions whose work is accounted for. That is why the closeout is as
important as anything else in the pipeline: **memory that cannot be trusted
is not memory, it is noise.**
