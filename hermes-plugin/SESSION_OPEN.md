# Session-open recall, 1.1.0

Requires Hermes `on_session_open` support (NousResearch/hermes-agent PR 151120).
The event alone does not inject memory. This consumer retrieves local recent
context at a human CLI/TUI/Desktop/ACP open, then the MemoryProvider consumes it
on the first turn, including when the turn runs in a separate managed process.

The cache is under the owning Hermes home's `cache/memory-lane-open` directory.
It is keyed by session and the existing scoped route fingerprint, including
credential identity without storing the bearer. Entries are single-use, at most
64 KiB each, expire logically after five minutes, and the next store prunes the
cache to eight entries. It is not a new permanent memory store. Existing recent
retrieval remains the fallback. No new model call, external decision call,
transcript export, freshness report, or closeout write happens at open time.

Memory-provider selection is checked again at callback time. Automation and
messaging opens do not run this callback. Profile ownership checks remain in
place. Safe mode and missing hook consumers remain governed by Hermes.

Install all three files from `memory-lane/` together. Preserve the prior plugin
directory for rollback. Older Hermes versions keep first-turn retrieval but do
not register the new hook. Do not enable Office or sealer services as part of
this change.

Validation: run `tests/test_session_open.py` with a Hermes test interpreter and
that Hermes checkout on `PYTHONPATH`. These tests create temporary homes and
synthetic recall. Separately verify native session-open delivery and first-turn
consumption before claiming a live deployment. A skipped Linux E2E test is not
proof of a Windows live session.
