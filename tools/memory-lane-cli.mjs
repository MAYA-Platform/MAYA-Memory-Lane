#!/usr/bin/env node
/**
 * Memory Lane — JSON CLI bridge for the Hermes MemoryProvider plugin.
 *
 * Exposes the Memory Lane core lib (FTS5 search, resume, recent, answer) as a
 * tiny line-dispatched CLI the Python MemoryProvider shells out to. Keeps the
 * exact same retrieval path as the MCP server (61% recall FTS5 + chain-verified
 * blocks) without the Python provider needing to reimplement the on-disk format
 * or the BM25 index.
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
import { loadLibrary, search, resolveResume, readBlock } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = process.env.MEMORY_LANE_LIBRARY || 'E:/MAYA_BULK/memory-lane-live';
const EXCERPT_CHARS = 320;

function excerptBlock(lib, block) {
  try {
    const full = readBlock(lib, block.lib_id);
    if (!full || !full.present || !full.body) return '';
    const body = full.body;
    const section = /## (Current State|Established Claims|Decisions)\s*\n([\s\S]*?)(?=\n## |\n# |$)/i.exec(body);
    const text = section ? section[2].trim() : body.replace(/^#.*$/gm, '').trim();
    if (!text) return '';
    if (text.length <= EXCERPT_CHARS) return text;
    const cut = text.slice(0, EXCERPT_CHARS);
    return cut.slice(0, cut.lastIndexOf(' ')) + '…';
  } catch {
    return '';
  }
}

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
        excerpt: excerptBlock(lib, b),
      })),
    });
    return;
  }

  if (cmd === 'search') {
    const query = rest[0] || '';
    const limit = Math.max(1, Math.min(Number(rest[1]) || 5, 25));
    if (!query) { out({ ok: false, error: 'query required' }); process.exit(1); }
    const r = search(lib, query, { limit });
    out({
      ok: true,
      count: r.count,
      matches: (r.matches || []).map((m) => ({
        block_id: m.block_id,
        excerpt: (m.excerpt || '').slice(0, EXCERPT_CHARS),
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
        excerpt: excerptBlock(lib, b),
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
