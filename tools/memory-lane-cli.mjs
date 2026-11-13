#!/usr/bin/env node
/**
 * Memory Lane — JSON CLI bridge for the Hermes MemoryProvider plugin.
 *
 * Exposes the Memory Lane core lib (FTS5 search, resume, recent, answer) as a
 * tiny line-dispatched CLI the Python MemoryProvider shells out to. It shares
 * the MCP server’s FTS5 search over local blocks.
 *
 * Usage:
 *   node memory-lane-cli.mjs recent <n>
 *   node memory-lane-cli.mjs search <query> [limit]
 *   node memory-lane-cli.mjs resume <phrase>
 *   node memory-lane-cli.mjs answer <question>
 *
 * Prints a single JSON object to stdout. Exit 0 on success, 1 on error.
 * Library path from MEMORY_LANE_LIBRARY env, else the live library.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, searchAsync, resolveResume } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';
import { excerptBlock } from '../lib/bridgeExcerpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = process.env.MEMORY_LANE_LIBRARY || path.resolve(__dirname, '../empty-library');
const EXCERPT_CHARS = 320;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const lib = loadLibrary(LIBRARY);
  if (!lib.ok) {
    out({ ok: false, error: `library not found at ${LIBRARY}` });
    process.exit(1);
  }

  if (cmd === 'recent') {
    const limit = Math.max(1, Math.min(Number(rest[0]) || 5, 25));
    const recent = lib.blocks.slice(-limit).reverse();
    out({
      ok: true,
      blocks: recent.map((b) => ({
        block_id: b.block_id,
        lib_id: b.lib_id,
        title: b.canonical_name || b.block_id,
        ...excerptBlock(lib, b),
      })),
    });
    return;
  }

  if (cmd === 'search') {
    const query = rest[0] || '';
    const limit = Math.max(1, Math.min(Number(rest[1]) || 5, 25));
    if (!query) { out({ ok: false, error: 'query required' }); process.exit(1); }
    const r = await searchAsync(lib, query, { limit });
    out({
      ok: true,
      count: r.count,
      matches: (r.matches || []).map((m) => ({
        block_id: m.block_id,
        excerpt: (m.excerpt || '').slice(0, EXCERPT_CHARS),
        manifest_hash_status: m.manifest_hash_status,
      })),
    });
    return;
  }

  if (cmd === 'resume') {
    const phrase = rest[0] || '';
    if (!phrase) { out({ ok: false, error: 'phrase required' }); process.exit(1); }
    const r = resolveResume(lib, phrase);
    out({
      ok: true,
      found: r.found,
      blocks: r.found ? r.blocks.map((b) => ({
        block_id: b.block_id,
        lib_id: b.lib_id,
        title: b.canonical_name || b.block_id,
        ...excerptBlock(lib, b),
      })) : [],
    });
    return;
  }

  if (cmd === 'answer') {
    const question = rest.join(' ');
    if (!question) { out({ ok: false, error: 'question required' }); process.exit(1); }
    const r = await answerQuestion(lib, question);
    out({
      ok: true,
      mode: r.mode,
      answer: r.answer,
      source: r.source || null,
      evidence: r.evidence || [],
      ...(r.reason ? { reason: r.reason } : {}),
      ...('cost' in r ? { cost: r.cost } : {}),
      ...(r.citations ? { citations: r.citations } : {}),
      ...(r.citation_note ? { citation_note: r.citation_note } : {}),
      ...(r.note ? { note: r.note } : {}),
    });
    return;
  }

  out({ ok: false, error: `unknown command: ${cmd || '(none)'}` });
  process.exit(1);
}

main().catch((e) => {
  out({ ok: false, error: String(e && e.message || e) });
  process.exit(1);
});
