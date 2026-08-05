# MAYA Memory Lane

**Your memory, on a chain, in your pocket.**

Memory Lane is a local-first, tamper-evident memory library. Every session leaves a sealed record with a SHA-256 fingerprint, every six records fold into one shelf block, and each shelf block carries the fingerprint of the one before it. The result is a chain of linked records you own, organized into shelves and volumes on your own machine, verified in seconds, and resumed with a single phrase.

**You own the memory. The chain keeps it honest.**

Memory Lane is a public-beta web interface over a plain-file library. No cloud, no account, no telemetry. The files are the source of truth and the interface is a window over them. If the interface disappears, the library is still right there on disk.

> Memory Lane is a controlled public beta. All data stays local to the machine that runs it. It is not a hosted service and carries no production SLA.

![Memory Lane](docs/images/memory-lane-public.png)

*Shown with the bundled sample loaded via the "Load sample library" button. A fresh clone opens blank, your lane is empty until you seal records. The sample is fabricated demo data that never touches your machine.*

## What it does

- **Linked memory records**, every session becomes a sealed block with a SHA-256 fingerprint, and every block carries the fingerprint of the block before it. Change anything and the break is visible
- **Automatic ingestion**, drop a transcript into the inbox (or POST it to the API) and Memory Lane extracts durable facts, seals a chain-linked block, and files it — no human step in between
- **6→1 compaction**, six session records fold into one shelf block, so the library grows one shelf per six sessions instead of one file per session
- **Chain verification**, recomputes every fingerprint and walks the links, then tells you plainly what you need to know: intact, unverifiable, or needs attention
- **Resume phrase as your key**, one string crosses sessions. The library holds everything else
- **Full-text search**, plain-text search across every record body, boosted by extracted facts
- **Deterministic export**, a byte-stable JSON bundle of the whole library, one click
- **Zero dependencies**, Node's built-in runtime and test runner, no npm install required
- **Files are truth**, the library is a folder of markdown + JSON manifests. Delete the index, rebuild everything from the chain

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm test
npm start
```

Open `http://127.0.0.1:8766/`.

No dependency installation is required. The package uses Node's built-in runtime and test runner.

**First run is blank on purpose.** A fresh clone shows an empty memory lane, not demo data. Click **Load sample library** in the interface to explore the bundled 7-block demo (fabricated data, clearly labeled), then **Start fresh** to return to empty. Your records never appear in anyone else's clone.

## Pointing at your own library

The server reads whatever library you point it at:

```bash
MEMORY_LANE_LIBRARY=/path/to/your/library node server.mjs
```

A library is a directory containing a `MANIFEST.json` and a `shelves/` tree of block files. The bundled `empty-library/` is the blank default, and `sample-library/` shows the exact format (regenerate it any time with `npm run make-sample`). Any library following that format, with shelves, manifests, fingerprints, and previous-block links, loads straight into the interface.

## How the chain works

Every session ends as a **micro block**, a sealed record with a SHA-256 fingerprint. Every six sessions, those micro blocks are consolidated into one **shelf block**, numbered, timestamped, and chained to the shelf block before it by carrying its fingerprint. Blocks are filed into **shelves** (six per shelf), grouped into **volumes**, and tracked in a **manifest**.

Verification recomputes every fingerprint and walks the links. Three states, deliberately simple:

- **Intact**, every fingerprint matches and every link verifies
- **Unverifiable**, a link exists but no recorded fingerprint exists to compare (neutral, not corruption)
- **Needs attention**, a fingerprint mismatches or a referenced block is missing

That's the whole trust model. You can prove your memory hasn't been altered, and if it has, the break tells you exactly where.

## Automatic ingestion

Memory Lane runs itself. Three surfaces, same chain underneath:

**1. Inbox watcher (drop a file, walk away).** Point the watcher at a folder and it seals everything that lands there:

```bash
python tools/inbox-watch.py --inbox /path/to/inbox --library /path/to/library --once
```

New `.md`, `.txt`, `.json`, or `.log` files are extracted, sealed as chain-linked blocks, and archived to `inbox/processed/<date>/`. Run it on a timer (`npm run watch` loops every 60s, or wire it as a cron job) and the library grows itself. Nothing new in the folder means nothing happens — silent, free.

**2. API (any agent can push a memory).** The server accepts new memories over HTTP:

```bash
curl -X POST http://127.0.0.1:8766/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"text":"Josh leased a 2026 Honda Civic in matte black.","source":"telegram"}'
```

Auto-extraction runs unless you pass explicit `facts` (or `"extract": false`). The response includes the new `lib_id`, `block_id`, and a fresh chain verdict.

**3. CLI (scripts and cron).** Same pipeline from the command line:

```bash
node tools/ingest.mjs transcript.md --source hermes
cat notes.txt | node tools/ingest.mjs --title "Evening notes"
```

**How extraction works.** The recommended model is **deepseek v4 flash** through a Merge Gateway key (`MEMORY_LANE_API_KEY` / `MEMORY_LANE_BASE_URL` / `MEMORY_LANE_MODEL`), falling back to local Ollama when no key is set. The model turns a raw transcript into a `## Extracted facts` section inside the block, and full-text search indexes those facts so natural-language queries land. Extraction is best-effort by design: if the model is unreachable, the raw text is still sealed and searchable — a memory is never lost to a model hiccup. Re-ingesting identical content is detected and skipped, so watchers and retries never duplicate a block.

## API

| Endpoint | Description |
|---|---|
| `GET /` | The Memory Lane interface |
| `GET /api/status` | Library stats + chain verdict |
| `GET /api/blocks` | Block list (manifest order) |
| `GET /api/blocks/:libId` | One block (frontmatter + body) |
| `GET /api/chain` | Full chain verification walk |
| `GET /api/search?q=` | Search across block bodies |
| `GET /api/resume?phrase=` | Resolve a resume phrase |
| `GET /api/export` | Deterministic JSON export |
| `POST /api/ingest` | Seal a new memory (auto fact extraction) |
| `POST /api/blocks/write` | Seal a new memory with explicit facts (no LLM) |

## Repository layout

```text
lib/memoryLaneCore.js        library core: load, verify, search, resume, export, append
lib/extract.js               fact extraction: deepseek v4 flash via Merge, Ollama fallback
public/memory-lane.html      the interface (single file, zero deps)
server.mjs                   zero-dependency HTTP server (read + write endpoints)
empty-library/               the blank first-run library (0 records, default)
tools/ingest.mjs             CLI ingestion: file, --text, or stdin
tools/inbox-watch.py         inbox watcher: auto-seal files in a drop folder
tools/make-sample-library.mjs  deterministic sample library generator
sample-library/              the bundled demo library (7 blocks, regenerable)
tests/                       52 tests across core + server + ingest
```

## Support & reporting issues

Every MAYA product is a public beta. Expect rough edges and rapid iteration.

Found a bug or a sharp edge? Open an issue on this repository. For anything sensitive, use GitHub's **Private vulnerability reporting** (see [SECURITY.md](SECURITY.md)). Never put credentials or private data in a public issue.

If you want your own AI agent to investigate before you report, paste this prompt into your agent:

````text
Investigate a bug report for the MAYA Memory Lane repository. Reproduce
the issue locally if you can, then draft a bug report with: a concise
summary, steps to reproduce, expected behavior, actual behavior, environment
details (OS, Node version), and any relevant logs. Redact all credentials,
API keys, and personal data before showing me the draft. Do not post
anything anywhere without my explicit approval.
````

## License

2ndNatureAi Public Beta Evaluation License 1.0, see [LICENSE.txt](LICENSE.txt).

---

*Powered by 2ndNatureAi*
