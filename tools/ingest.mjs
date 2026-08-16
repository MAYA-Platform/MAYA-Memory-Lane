#!/usr/bin/env node
/**
 * Memory Lane — ingest CLI (v3, 2026-08-05).
 *
 * Seal a transcript or memory into a Memory Lane library from the command
 * line. This is the automation surface: the inbox watcher, an agent session
 * closeout, and any agent cron all funnel through this one command.
 *
 * Usage:
 *   node tools/ingest.mjs <file>              # .md / .txt / .json transcript
 *   node tools/ingest.mjs --text "..."        # inline text
 *   cat transcript.md | node tools/ingest.mjs # stdin
 *
 * Options:
 *   --title <str>     block title (default: first line of text)
 *   --source <str>    provenance tag (telegram, inbox, cli, api...)
 *   --lineage <str>   lineage name (default: auto)
 *   --facts "a|b|c"   explicit facts, skips LLM extraction
 *   --no-extract      seal raw text without LLM fact extraction
 *   --library <dir>   target library (default: MEMORY_LANE_LIBRARY env or
 *                      ../empty-library relative to this repo)
 *   --quiet           machine-readable: print only the JSON result
 *
 * Exit codes: 0 = sealed (or skipped as duplicate), 1 = error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, verifyChain } from '../lib/memoryLaneCore.js';
import { ingestTranscript } from '../lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LIBRARY = process.env.MEMORY_LANE_LIBRARY
  ? path.resolve(process.env.MEMORY_LANE_LIBRARY)
  : path.join(REPO_ROOT, 'empty-library');

function parseArgs(argv) {
  const opts = { files: [], text: null, title: null, source: null, lineage: 'auto', facts: null, extract: true, library: DEFAULT_LIBRARY, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--title') opts.title = next();
    else if (a === '--source') opts.source = next();
    else if (a === '--lineage') opts.lineage = next();
    else if (a === '--facts') opts.facts = next();
    else if (a === '--text') opts.text = next();
    else if (a === '--no-extract') opts.extract = false;
    else if (a === '--library') opts.library = next();
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else opts.files.push(a);
  }
  return opts;
}

function printHelp() {
  console.log(`Memory Lane ingest CLI

Usage:
  node tools/ingest.mjs <file>              seal a transcript file
  node tools/ingest.mjs --text "..."        seal inline text
  cat transcript.md | node tools/ingest.mjs seal from stdin

Options:
  --title <str>     block title (default: first line)
  --source <str>    provenance tag (telegram, inbox, cli, api)
  --lineage <str>   lineage name (default: auto)
  --facts "a|b|c"   explicit facts, skips LLM extraction
  --no-extract      seal raw text without LLM fact extraction
  --library <dir>   target library (default: MEMORY_LANE_LIBRARY or empty-library)
  --quiet           print only the JSON result
  --help            this help`);
}

/** Read transcript text from file / stdin / --text. */
async function readInput(opts) {
  if (opts.files.length > 0) {
    const p = path.resolve(opts.files[0]);
    if (!fs.existsSync(p)) return { error: `file not found: ${p}` };
    const raw = fs.readFileSync(p, 'utf8');
    // JSON transcripts: accept { text } or { transcript } or { content }.
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const text = obj.text || obj.transcript || obj.content || obj.body;
        if (typeof text === 'string' && text.trim()) {
          return { text: text.trim(), jsonMeta: { title: obj.title || null, source: obj.source || null, lineage: obj.lineage || null } };
        }
      } catch {
        // not JSON — treat as plain text
      }
    }
    return { text: raw.trim() };
  }
  if (opts.text !== null && opts.text !== undefined) {
    return { text: String(opts.text).trim() };
  }
  // stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { error: 'no input: pass a file, --text, or pipe stdin' };
  return { text };
}

function shortTitle(text) {
  const first = String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const clean = first.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ');
  return clean.slice(0, 72) || 'Memory block';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.quiet) console.log(`Memory Lane ingest → library: ${opts.library}`);

  if (!fs.existsSync(path.join(opts.library, 'MANIFEST.json'))) {
    console.error(`✗ not a Memory Lane library (no MANIFEST.json): ${opts.library}`);
    process.exitCode = 1;
    return;
  }

  const input = await readInput(opts);
  if (input.error) {
    console.error(`✗ ${input.error}`);
    process.exitCode = 1;
    return;
  }

  const text = input.text;
  const title = opts.title || (input.jsonMeta && input.jsonMeta.title) || shortTitle(text);
  const source = opts.source || (input.jsonMeta && input.jsonMeta.source) || null;
  const lineage = opts.lineage || (input.jsonMeta && input.jsonMeta.lineage) || 'auto';

  const facts = opts.facts ? opts.facts.split('|').map((f) => f.trim()).filter(Boolean) : null;
  const result = await ingestTranscript(opts.library, {
    title,
    body: text,
    source,
    lineage,
    extract: opts.extract && !facts,
    facts
  });

  if (!result.ok) {
    console.error(`✗ ${result.reason || 'append failed'}`);
    process.exitCode = 1;
    return;
  }

  const chain = verifyChain(loadLibrary(opts.library));
  const out = {
    ok: true,
    skipped: result.skipped || false,
    lib_id: result.lib_id,
    block_id: result.block_id,
    shelf: result.shelf,
    filename: result.filename,
    sha256: result.sha256,
    facts_count: result.extraction && result.extraction.facts ? result.extraction.facts.length : 0,
    extraction_ok: result.extraction ? result.extraction.ok : null,
    chain_intact: chain.intact,
    chain_status: chain.status
  };
  if (opts.quiet) {
    console.log(JSON.stringify(out));
  } else {
    console.log(`✓ sealed ${out.block_id} → ${out.shelf}/${out.filename}`);
    console.log(`  chain: ${out.chain_status} (${chain.okCount}/${chain.total} verified)${out.skipped ? ' — duplicate, skipped' : ''}`);
    if (result.extraction && result.extraction.facts && result.extraction.facts.length) {
      console.log(`  facts (${result.extraction.facts.length}):`);
      for (const f of result.extraction.facts.slice(0, 8)) console.log(`    - ${f}`);
      if (result.extraction.facts.length > 8) console.log(`    ... +${result.extraction.facts.length - 8} more`);
    } else if (result.extraction && result.extraction.error) {
      console.log(`  extraction: ${result.extraction.error} (raw text sealed anyway)`);
    }
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(`✗ ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
