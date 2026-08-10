#!/usr/bin/env node
/**
 * run_observer_dataset.mjs — Run the deterministic Observer over a dataset.
 *
 * For each LongMemEval instance, observes every haystack session message and
 * appends durable-signal observations to the target library's
 * observations.jsonl ledger. This is the Observer stage of the
 * Auto-Observation pipeline, run in batch for the Lane G benchmark.
 *
 * Usage: node run_observer_dataset.mjs [--items N] [--dataset PATH] [--lib DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..');
const DATASET = process.env.DATASET || path.join(BENCH, 'datasets', 'longmemeval_oracle.json');
const LIB_DIR = process.env.ML_LIB || path.join(BENCH, 'libraries', 'ml-lane-a');
const LIMIT = parseInt(process.env.ITEM_LIMIT || '500', 10);

const ML_CORE = process.env.ML_CORE || 'E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
const OBS = 'E:/MAYA_BULK/memory-lane-public-repo/lib/observations.js';
const { loadLibrary } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));
const { observeMessage, readObservations, writeObservationLedger } = await import('file:///' + OBS.replace(/\\/g, '/'));

const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf-8')).slice(0, LIMIT);
const lib = loadLibrary(LIB_DIR);
if (!lib.ok) { console.error('library load failed:', lib.reason); process.exit(1); }

// Reset ledger for a clean observer run
const obsFile = path.join(LIB_DIR, 'observations.jsonl');
if (fs.existsSync(obsFile)) fs.rmSync(obsFile);
fs.writeFileSync(obsFile, '');

let captured = 0;
let observed = 0;
for (const inst of dataset) {
  for (let si = 0; si < inst.haystack_sessions.length; si++) {
    const sess = inst.haystack_sessions[si];
    const sessId = inst.haystack_session_ids[si];
    for (let mi = 0; mi < sess.length; mi++) {
      const turn = sess[mi];
      const obs = observeMessage(lib, {
        speaker: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.content,
        session_id: sessId,
        message_id: `${inst.question_id}_${si}_${mi}`,
        timestamp: inst.haystack_dates?.[si] || undefined,
        source_ref: `${inst.question_id}:sess${si}`,
      });
      observed++;
      if (obs) captured++;
    }
  }
}

const stats = readObservations(lib).length;
writeObservationLedger(lib);
console.log(`[observer] messages scanned: ${observed}, signals captured: ${captured}, ledger entries: ${stats}`);
console.log(`[observer] ledger written to ${LIB_DIR}/observations.jsonl`);
