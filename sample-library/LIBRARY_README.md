# Sample Library

This is a small, deterministic demo library for Memory Lane.
It contains 6 micro-blocks and 1 consolidated shelf block (the 6→1 compaction model).
Every block carries a SHA-256 fingerprint and a link to the block before it.

Regenerate with:

```bash
node tools/make-sample-library.mjs
```
