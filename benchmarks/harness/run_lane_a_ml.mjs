#!/usr/bin/env node
/**
 * Memory Lane — Lane A: Retrieval Recall benchmark runner.
 *
 * Ingests LongMemEval instances into a Memory Lane library (one micro-block
 * per haystack session, bodies = full session transcript), then runs each
 * question as a search query and measures session-level recall@k against the
 * gold answer_session_ids.
 *
 * Metrics computed exactly like LongMemEval's print_retrieval_metrics.py:
 *   - recall_all@k  : fraction of gold sessions present in top-k retrieved
 *   - ndcg_any@k    : rank-aware (does ANY gold session rank high)
 *
 * Output: JSONL log per run in ../logs/, metrics in ../results/.
 * No LLM involved — pure retrieval. Zero shortcuts.
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

// import the Memory Lane core from the public repo
const ML_CORE = process.env.ML_CORE || 'E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
const { loadLibrary, search, verifyChain } = await import(pathToFileURL(ML_CORE).href);

function pathToFileURL(p) { return { href: 'file:///' + p.replace(/\\/g, '/') }; }

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function ensureDirs() {
  for (const d of [LIB_DIR, LOG_DIR, RESULT_DIR]) fs.mkdirSync(d, { recursive: true });
}

function writeManifest(blocks) {
  // Memory Lane manifest format: blocks array with lib_id, block_id, sha256, prev...
  const manifest = {
    version: 'benchmark-v1',
    total_blocks: blocks.length,
    blocks: blocks.map((b) => ({
      lib_id: b.lib_id,
      block_id: b.block_id,
      canonical_name: b.block_id,
      lineage: 'longmemeval',
      shelf: b.shelf,
      status: 'active',
      sha256: b.sha256,
      prev_block_id: b.prev_block_id || null,
      prev_sha256: b.prev_sha256 || null,
    })),
  };
  fs.writeFileSync(path.join(LIB_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
}

function ingest(dataset) {
  // Build one Memory Lane library: each haystack session = one block.
  const blocks = [];
  let libId = 1;
  const shelf = 'shelf-001';
  const shelfDir = path.join(LIB_DIR, 'shelves', shelf);
  fs.mkdirSync(shelfDir, { recursive: true });

  for (const inst of dataset) {
    for (let si = 0; si < inst.haystack_sessions.length; si++) {
      const sess = inst.haystack_sessions[si];
      const sessId = inst.haystack_session_ids[si];
      const date = inst.haystack_dates[si] || '';
      // Transcript text = all turns joined
      const body = sess.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
      const blockId = `cb_lme_${inst.question_id.replace(/[^a-z0-9]/gi, '_')}_${si}`;
      const prev = blocks.length ? blocks[blocks.length - 1] : null;
      const frontmatter = `---\nartifact_type: memory_block\nblock_id: ${blockId}\nlib_id: ${libId}\nblock_number: ${libId}\nstatus: active\nlineage: longmemeval\nshelf: ${shelf}\nsession_id: ${sessId}\ndate: ${date}\nprevious_block: ${prev ? prev.block_id : 'none'}\nprevious_sha: ${prev ? prev.sha256 : 'none'}\n---\n\n`;
      const text = frontmatter + body;
      const sha = sha256(text);
      const fname = `block-${String(libId).padStart(3, '0')}.md`;
      fs.writeFileSync(path.join(shelfDir, fname), text);
      blocks.push({ lib_id: libId, block_id: blockId, shelf, sha256: sha, prev_block_id: prev ? prev.block_id : null, prev_sha256: prev ? prev.sha256 : null });
      libId++;
    }
  }
  writeManifest(blocks);
  return blocks;
}

function recallAtK(goldSessions, retrievedSessionIds, k) {
  const topK = new Set(retrievedSessionIds.slice(0, k));
  if (goldSessions.length === 0) return 1; // vacuously
  const hit = goldSessions.filter((g) => topK.has(g)).length;
  return hit / goldSessions.length;
}

function ndcgAnyAtK(goldSessions, retrievedSessionIds, k) {
  const topK = retrievedSessionIds.slice(0, k);
  const goldSet = new Set(goldSessions);
  // binary gain: 1 if ANY gold session at rank i
  for (let i = 0; i < topK.length; i++) {
    if (goldSet.has(topK[i])) {
      // DCG = 1/log2(i+2); IDCG = 1/log2(1+1)=1
      return 1 / Math.log2(i + 2);
    }
  }
  return 0;
}

async function main() {
  ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf-8')).slice(0, LIMIT);

  // If ML_LIB points at an existing library (e.g. fact-enriched), skip ingest.
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
  if (!blocks) { console.error('[ingest] no blocks available'); process.exit(1); }

  // verify chain integrity of the built library
  const lib = loadLibrary(LIB_DIR);
  if (!lib.ok) { console.error('[ingest] library load failed:', lib.reason); process.exit(1); }
  const chain = verifyChain(lib);
  console.log(`[ingest] chain verify: intact=${chain.intact} total=${chain.total} ok=${chain.okCount}`);

  // build session_id -> lib_id map for retrieval (search returns blocks; map to session)
  const sessionToLib = {};
  const libToSession = {};
  for (const b of lib.blocks) {
    // read the block to get session_id from frontmatter
    const block = lib.blocks.find((x) => x.lib_id === b.lib_id);
    // need raw text: read file
    const f = path.join(LIB_DIR, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
    const raw = fs.readFileSync(f, 'utf-8');
    const m = raw.match(/^session_id: (.+)$/m);
    if (m) {
      const sid = m[1].trim();
      sessionToLib[sid] = b.lib_id;
      libToSession[b.lib_id] = sid;
    }
  }

  const results = [];
  let idx = 0;
  for (const inst of dataset) {
    idx++;
    const gold = inst.answer_session_ids || [];
    const q = inst.question;
    // Memory Lane search: plain-text substring. Use the question as query.
    const res = search(lib, q, { limit: 25 });
    // map retrieved lib_ids back to session ids
    const retrievedSessions = res.matches.map((m) => libToSession[m.lib_id]).filter(Boolean);
    const entry = {
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: q,
      gold_sessions: gold,
      retrieved_sessions: retrievedSessions,
      session_recall_all_5: recallAtK(gold, retrievedSessions, 5),
      session_recall_all_10: recallAtK(gold, retrievedSessions, 10),
      session_ndcg_any_5: ndcgAnyAtK(gold, retrievedSessions, 5),
      session_ndcg_any_10: ndcgAnyAtK(gold, retrievedSessions, 10),
    };
    results.push(entry);
    if (idx % 100 === 0) console.log(`  [run] ${idx}/${dataset.length}`);
  }

  // Aggregate exactly like LongMemEval's print_retrieval_metrics.py
  const agg = (fn) => results.reduce((a, e) => a + fn(e), 0) / results.length;
  const metrics = {
    run_id: runId,
    system: 'memory-lane',
    dataset: path.basename(DATASET),
    instances: results.length,
    dataset_sha256: sha256(fs.readFileSync(DATASET)),
    library_sha256: sha256(fs.readFileSync(path.join(LIB_DIR, 'MANIFEST.json'))),
    session_recall_all_5: agg((e) => e.session_recall_all_5),
    session_recall_all_10: agg((e) => e.session_recall_all_10),
    session_ndcg_any_5: agg((e) => e.session_ndcg_any_5),
    session_ndcg_any_10: agg((e) => e.session_ndcg_any_10),
    chain_intact: chain.intact,
    chain_ok_count: chain.okCount,
  };

  fs.writeFileSync(path.join(LOG_DIR, `ml-lane-a-${runId}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(RESULT_DIR, `ml-lane-a-${runId}.json`), JSON.stringify(metrics, null, 2));
  console.log('\n=== MEMORY LANE LANE A METRICS ===');
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
