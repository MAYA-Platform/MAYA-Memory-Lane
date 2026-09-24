#!/usr/bin/env node
/**
 * shadow_health.mjs — Memory Lane shadow integrity worker (sandbox prototype).
 *
 * NON-BLOCKING by construction: runs as its OWN process, never inside the
 * server's event loop. Every cycle: presence sweep (manifest vs readable
 * count) + full verifyChain, then atomically writes a shadow state file.
 * The server never runs this; it only READS the state file.
 *
 * Usage:
 *   node shadow_health.mjs --library <lib> --state <out.json> --once
 *   node shadow_health.mjs --library <lib> --state <out.json> --interval 300000
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, verifyChain } from 'file:///E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const LIB = path.resolve(arg('library', ''));
const STATE = path.resolve(arg('state', ''));
const INTERVAL = Number(arg('interval', '300000')); // default 5 min
const ONCE = args.includes('--once');
const STALE_AFTER = Number(arg('stale-after-ms', String(INTERVAL * 2 + 60000)));

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORE = 'file:///E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
if (!fs.existsSync(fileURLToPath(CORE))) {
  console.error(`shadow_health: memoryLaneCore.js not found at ${CORE}`);
  process.exit(2);
}

function classify(verdict, manifestCount, readableCount) {
  // Three-state, polarity-explicit: healthy / degraded / unhealthy.
  const missing = verdict.blocks.filter((b) => !b.present).map((b) => ({
    lib_id: b.lib_id, block_id: b.block_id, shelf: b.shelf
  }));
  const hashIssues = verdict.blocks.filter((b) => b.status === 'hash_mismatch').map((b) => ({
    lib_id: b.lib_id, block_id: b.block_id
  }));
  const linkIssues = verdict.blocks.filter((b) => b.status === 'link_issue').map((b) => ({
    lib_id: b.lib_id, block_id: b.block_id
  }));
  const divergence = manifestCount !== readableCount;
  let status = 'healthy';
  if (missing.length || hashIssues.length || linkIssues.length || divergence) status = 'degraded';
  if (hashIssues.length || linkIssues.length) status = 'unhealthy'; // corruption outranks absence
  return { status, missing, hash_issues: hashIssues, link_issues: linkIssues, divergence };
}

function runCycle() {
  const t0 = Date.now();
  const state = {
    schema: 'ml.shadow_health/1',
    library: LIB,
    at: null, at_iso: null,
    duration_ms: null,
    manifest_blocks: null, readable_blocks: null,
    chain: null, classification: null,
    error: null,
    stale_after_ms: STALE_AFTER
  };
  try {
    const lib = loadLibrary(LIB);
    if (!lib.ok) {
      state.error = `loadLibrary failed: ${lib.reason}`;
      state.at = Date.now(); state.at_iso = new Date().toISOString();
      state.classification = { status: 'unhealthy', missing: [], hash_issues: [], link_issues: [], divergence: false };
      writeState(state);
      return state;
    }
    // Presence sweep: manifest count vs files actually readable.
    let readable = 0;
    const missingSweep = [];
    for (const b of lib.blocks) {
      try {
        if (fs.existsSync(b.filePath) && fs.statSync(b.filePath).size > 0) readable += 1;
        else missingSweep.push({ lib_id: b.lib_id, block_id: b.block_id, shelf: b.shelf });
      } catch { missingSweep.push({ lib_id: b.lib_id, block_id: b.block_id, shelf: b.shelf }); }
    }
    const verdict = verifyChain(lib);
    state.manifest_blocks = lib.blocks.length;
    state.readable_blocks = readable;
    state.chain = {
      intact: verdict.intact, status: verdict.status, total: verdict.total,
      okCount: verdict.okCount, issues: verdict.issues,
      hardIssues: verdict.hardIssues, unchecked: verdict.unchecked,
      verifiedRun: verdict.verifiedRun
    };
    const cls = classify(verdict, lib.blocks.length, readable);
    if (missingSweep.length && !cls.missing.length) cls.missing = missingSweep; // sweep catches what verify skips
    state.classification = cls;
  } catch (e) {
    state.error = String(e && e.message ? e.message : e);
    state.classification = { status: 'unhealthy', missing: [], hash_issues: [], link_issues: [], divergence: false };
  }
  state.duration_ms = Date.now() - t0;
  state.at = Date.now();
  state.at_iso = new Date().toISOString();
  writeState(state);
  return state;
}

/** Atomic write: tmp file + rename, so readers never see a partial state. */
function writeState(state) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE);
}

function cycleAndMaybeLoop() {
  const s = runCycle();
  const c = s.classification || {};
  console.log(`[shadow] ${s.at_iso} status=${c.status} manifest=${s.manifest_blocks} readable=${s.readable_blocks} ` +
    `chain=${s.chain ? s.chain.status : 'n/a'} dur=${s.duration_ms}ms` +
    (s.error ? ` ERROR=${s.error.slice(0, 120)}` : ''));
  if (!ONCE) setTimeout(cycleAndMaybeLoop, INTERVAL);
  return s;
}

if (!LIB || !STATE) {
  console.error('usage: node shadow_health.mjs --library <lib> --state <out.json> [--once|--interval ms]');
  process.exit(2);
}
cycleAndMaybeLoop();
