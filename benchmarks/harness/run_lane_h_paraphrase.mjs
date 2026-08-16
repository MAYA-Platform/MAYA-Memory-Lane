#!/usr/bin/env node
/**
 * Memory Lane — Lane H: Paraphrase/Semantic Recall probe.
 *
 * The LongMemEval questions contain exact keywords, which FTS5 already
 * catches. The semantic lane's real value shows on *paraphrase* probes:
 * questions that mean the same thing but use different words than the
 * stored transcript ("the thing about my car GPS" vs "the GPS issue in
 * March"). This runner measures FTS5 vs FTS5+Vertex on exactly that gap.
 *
 * The probe is built from LongMemEval: for each question we synthesize a
 * paraphrase (different words, same meaning) and measure whether retrieval
 * still finds the gold session. FTS5 should drop; the semantic lane should
 * hold.
 *
 * Usage: EMBED_PROVIDER=vertex VERTEX_ACCESS_TOKEN=<token> node run_lane_h_paraphrase.mjs
 * Env: ML_LIB, ITEM_LIMIT, ML_CORE
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..');
const DATASET = process.env.DATASET || path.join(BENCH, 'datasets', 'longmemeval_oracle.json');
const PROBE = process.env.PROBE || path.join(BENCH, 'datasets', 'paraphrase_probe.json');
const LIB_DIR = process.env.ML_LIB || path.join(BENCH, 'libraries', 'ml-lane-a');
const LOG_DIR = path.join(BENCH, 'logs');
const RESULT_DIR = path.join(BENCH, 'results');
const LIMIT = parseInt(process.env.ITEM_LIMIT || '100', 10);

const ML_CORE = process.env.ML_CORE || path.resolve(__dirname, '../../lib/memoryLaneCore.js');
const { loadLibrary, search, verifyChain } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));
const { denseSearch, rrf } = await import('file:///' + ML_CORE.replace(/memoryLaneCore\.js$/, 'embeddings.js').replace(/\\/g, '/'));

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function ensureDirs() { for (const d of [LOG_DIR, RESULT_DIR]) fs.mkdirSync(d, { recursive: true }); }
function recallAtK(gold, retrieved, k) {
  const top = new Set(retrieved.slice(0, k));
  if (!gold.length) return 1.0;
  return gold.filter((g) => top.has(g)).length / gold.length;
}

async function main() {
  ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const probe = JSON.parse(fs.readFileSync(PROBE, 'utf-8')).slice(0, LIMIT);

  const lib = loadLibrary(LIB_DIR);
  if (!lib.ok) { console.error('[probe] library load failed:', lib.reason); process.exit(1); }
  const chain = verifyChain(lib);
  console.log(`[probe] chain verify: intact=${chain.intact} total=${chain.total} ok=${chain.okCount}`);

  const libToSession = {};
  for (const b of lib.blocks) {
    const f = path.join(LIB_DIR, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
    const m = fs.readFileSync(f, 'utf-8').match(/^session_id: (.+)$/m);
    if (m) libToSession[b.lib_id] = m[1].trim();
  }

  // Pre-build dense index
  let denseIdx = null;
  try {
    const { buildDenseIndex } = await import('file:///' + ML_CORE.replace(/memoryLaneCore\.js$/, 'embeddings.js').replace(/\\/g, '/'));
    denseIdx = await buildDenseIndex(lib, { verbose: false });
  } catch (e) {
    console.log('[probe] dense unavailable:', e.message);
  }
  console.log(`[probe] dense index: ${denseIdx ? denseIdx.embeddings.size + ' blocks' : 'DISABLED'}`);

  const results = [];
  let idx = 0;
  for (const p of probe) {
    idx++;
    const gold = p.answer_session_ids || [];
    const q = p.paraphrase || p.question;

    const fts = search(lib, q, { limit: 25 }).matches.map((m) => m.lib_id);
    let dense = [];
    if (denseIdx) {
      dense = (await denseSearch(lib, q, { limit: 25 })).map((h) => h.lib_id);
    }
    const fused = rrf([fts, dense], { k: 60 }).map((x) => x.lib_id);

    const ftsSessions = fts.map((lid) => libToSession[lid]).filter(Boolean);
    const fusedSessions = fused.map((lid) => libToSession[lid]).filter(Boolean);

    results.push({
      question_id: p.question_id,
      original_question: p.question,
      paraphrase: q,
      gold_sessions: gold,
      fts_recall_5: recallAtK(gold, ftsSessions, 5),
      hybrid_recall_5: recallAtK(gold, fusedSessions, 5),
    });
    if (idx % 25 === 0) console.log(`  [probe] ${idx}/${probe.length}`);
  }

  const agg = (fn) => results.reduce((a, e) => a + fn(e), 0) / results.length;
  const metrics = {
    run_id: runId,
    system: 'memory-lane-paraphrase-probe',
    instances: results.length,
    fts_recall_5: agg((e) => e.fts_recall_5),
    hybrid_recall_5: agg((e) => e.hybrid_recall_5),
    delta: agg((e) => e.hybrid_recall_5) - agg((e) => e.fts_recall_5),
    dense: denseIdx ? `fts5+rrf+vertex-${denseIdx.model}` : 'fts5-only',
    chain_intact: chain.intact,
  };
  fs.writeFileSync(path.join(LOG_DIR, `paraphrase-probe-${runId}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(RESULT_DIR, `paraphrase-probe-${runId}.json`), JSON.stringify(metrics, null, 2));
  console.log('\n=== MEMORY LANE PARAPHRASE PROBE ===');
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
