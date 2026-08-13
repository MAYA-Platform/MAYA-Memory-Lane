#!/usr/bin/env node
/**
 * U2 (2026-08-04): Lane A — Hybrid retrieval (FTS5 + dense bge-m3 + RRF).
 *
 * Mirrors run_lane_a_ml.mjs but fuses two retrieval branches:
 *   1. FTS5 BM25 (sparse, from memoryLaneCore.search)
 *   2. bge-m3 dense cosine (from lib/embeddings.js, optional)
 * via Reciprocal Rank Fusion (Graphiti pattern, k=60).
 *
 * When Ollama is unavailable, falls back to FTS5-only (same as the base run)
 * so results are comparable.
 *
 * Usage: node run_lane_a_hybrid.mjs
 * Env: ML_LIB (library dir), ITEM_LIMIT, ML_CORE, EMBED_MODEL
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..');
const DATASET = process.env.DATASET || path.join(BENCH, 'datasets', 'longmemeval_oracle.json');
const LIB_DIR = process.env.ML_LIB || path.join(BENCH, 'libraries', 'ml-lane-a');
const LOG_DIR = path.join(BENCH, 'logs');
const RESULT_DIR = path.join(BENCH, 'results');
const LIMIT = parseInt(process.env.ITEM_LIMIT || '500', 10);

const ML_CORE = process.env.ML_CORE || 'E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
const { loadLibrary, search, verifyChain } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));
const { denseSearch, rrf } = await import('file:///' + ML_CORE.replace(/memoryLaneCore\.js$/, 'embeddings.js').replace(/\\/g, '/'));

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function ensureDirs() { for (const d of [LOG_DIR, RESULT_DIR]) fs.mkdirSync(d, { recursive: true }); }

function recallAtK(gold, retrieved, k) {
  const top = new Set(retrieved.slice(0, k));
  if (!gold.length) return 1.0;
  return gold.filter((g) => top.has(g)).length / gold.length;
}

function ndcgAnyAtK(gold, retrieved, k) {
  const goldSet = new Set(gold);
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (goldSet.has(retrieved[i])) return 1 / Math.log2(i + 2);
  }
  return 0;
}

// Build the library (mirror of the base runner's ingest)
function ingest(dataset) {
  fs.rmSync(LIB_DIR, { recursive: true, force: true });
  const shelfDir = path.join(LIB_DIR, 'shelves', 'shelf-001');
  fs.mkdirSync(shelfDir, { recursive: true });
  const blocks = [];
  let libId = 1;
  for (const inst of dataset) {
    for (let si = 0; si < inst.haystack_sessions.length; si++) {
      const sess = inst.haystack_sessions[si];
      const sessId = inst.haystack_session_ids[si];
      const body = sess.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
      const blockId = `cb_lme_${inst.question_id.replace(/[^a-z0-9]/gi, '_')}_${si}`;
      const prev = blocks.length ? blocks[blocks.length - 1] : null;
      const text = `---\nartifact_type: memory_block\nblock_id: ${blockId}\nlib_id: ${libId}\nblock_number: ${libId}\nstatus: active\nlineage: longmemeval\nshelf: shelf-001\nsession_id: ${sessId}\nprevious_block: ${prev ? prev.block_id : 'none'}\nprevious_sha: ${prev ? prev.sha256 : 'none'}\n---\n\n${body}\n`;
      const h = sha256(Buffer.from(text, 'utf8'));
      fs.writeFileSync(path.join(shelfDir, `block-${String(libId).padStart(3, '0')}.md`), text, { encoding: 'utf8' });
      blocks.push({ lib_id: libId, block_id: blockId, shelf: 'shelf-001', sha256: h, prev_block_id: prev ? prev.block_id : null, prev_sha256: prev ? prev.sha256 : null });
      libId++;
    }
  }
  fs.writeFileSync(path.join(LIB_DIR, 'MANIFEST.json'), JSON.stringify({ version: 'benchmark-v1', total_blocks: blocks.length, blocks }, null, 2), { encoding: 'utf8' });
  return blocks;
}

async function main() {
  ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf-8')).slice(0, LIMIT);

  let blocks;
  if (process.env.ML_LIB && fs.existsSync(path.join(LIB_DIR, 'MANIFEST.json'))) {
    console.log(`[ingest] SKIP — using existing library at ${LIB_DIR}`);
    const existing = loadLibrary(LIB_DIR);
    blocks = existing.ok ? existing.blocks : null;
  } else {
    console.log(`[ingest] ${dataset.length} instances -> Memory Lane library`);
    blocks = ingest(dataset);
    console.log(`[ingest] ${blocks.length} blocks written to ${LIB_DIR}`);
  }
  if (!blocks) { console.error('[ingest] no blocks'); process.exit(1); }

  const lib = loadLibrary(LIB_DIR);
  const chain = verifyChain(lib);
  console.log(`[ingest] chain verify: intact=${chain.intact} total=${chain.total} ok=${chain.okCount}`);

  // session <-> lib map
  const libToSession = {};
  for (const b of lib.blocks) {
    const f = path.join(LIB_DIR, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
    const m = fs.readFileSync(f, 'utf-8').match(/^session_id: (.+)$/m);
    if (m) libToSession[b.lib_id] = m[1].trim();
  }

  // Pre-build dense index once (U4)
  console.log('[hybrid] building dense index (bge-m3)...');
  const denseStart = Date.now();
  let denseIdx = null;
  try {
    const { buildDenseIndex } = await import('file:///' + ML_CORE.replace(/memoryLaneCore\.js$/, 'embeddings.js').replace(/\\/g, '/'));
    denseIdx = await buildDenseIndex(lib, { verbose: true });
  } catch (e) {
    console.log('[hybrid] dense unavailable:', e.message);
  }
  console.log(`[hybrid] dense index ${denseIdx ? `ready (${denseIdx.embeddings.size} blocks)` : 'DISABLED (FTS5 only)'} in ${Date.now() - denseStart}ms`);

  const results = [];
  let idx = 0;
  for (const inst of dataset) {
    idx++;
    const gold = inst.answer_session_ids || [];
    const q = inst.question;

    // Branch 1: FTS5
    const fts = search(lib, q, { limit: 25 }).matches.map((m) => m.lib_id);

    // Branch 2: dense (may be empty)
    let dense = [];
    if (denseIdx) {
      dense = (await denseSearch(lib, q, { limit: 25 })).map((h) => h.lib_id);
    }

    // Fuse via RRF
    const fused = rrf([fts, dense], { k: 60 }).map((x) => x.lib_id);
    const retrievedSessions = fused.map((lid) => libToSession[lid]).filter(Boolean);

    results.push({
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: q,
      gold_sessions: gold,
      retrieved_sessions: retrievedSessions,
      session_recall_all_5: recallAtK(gold, retrievedSessions, 5),
      session_recall_all_10: recallAtK(gold, retrievedSessions, 10),
      session_ndcg_any_5: ndcgAnyAtK(gold, retrievedSessions, 5),
      session_ndcg_any_10: ndcgAnyAtK(gold, retrievedSessions, 10),
    });
    if (idx % 100 === 0) console.log(`  [run] ${idx}/${dataset.length}`);
  }

  const agg = (fn) => results.reduce((a, e) => a + fn(e), 0) / results.length;
  const metrics = {
    run_id: runId,
    system: 'memory-lane-hybrid',
    dataset: path.basename(DATASET),
    instances: results.length,
    dataset_sha256: sha256(fs.readFileSync(DATASET)),
    library_sha256: sha256(fs.readFileSync(path.join(LIB_DIR, 'MANIFEST.json'))),
    hybrid: denseIdx ? 'fts5+rrf+dense' : 'fts5-only (dense unavailable)',
    session_recall_all_5: agg((e) => e.session_recall_all_5),
    session_recall_all_10: agg((e) => e.session_recall_all_10),
    session_ndcg_any_5: agg((e) => e.session_ndcg_any_5),
    session_ndcg_any_10: agg((e) => e.session_ndcg_any_10),
    chain_intact: chain.intact,
    chain_ok_count: chain.okCount,
  };
  fs.writeFileSync(path.join(LOG_DIR, `hybrid-lane-a-${runId}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(RESULT_DIR, `hybrid-lane-a-${runId}.json`), JSON.stringify(metrics, null, 2));
  console.log('\n=== MEMORY LANE HYBRID LANE A METRICS ===');
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
