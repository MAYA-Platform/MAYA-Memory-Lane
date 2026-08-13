#!/usr/bin/env node
/**
 * Lane B — Integrity / Tamper-Evidence (Memory Lane proof).
 *
 * Pre-registered hypotheses (protocol §4.4 Lane B):
 *   B1: altering ANY byte in any block file flips verifyChain() to 'issues'
 *       with the exact block flagged. 50 random 1-byte mutations -> 50/50.
 *   B2: appending a fake block with a forged prev_sha -> detected.
 *   B3: deleting a block file -> detected ('missing').
 *
 * Honcho/Mem0: no tamper-evidence mechanism exists — reported as factual
 * N/A, no score assigned (protocol rule: we don't manufacture losses).
 *
 * Output: results/lane-b-<run>.json + logs/lane-b-<run>.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, '..');
const LIB_DIR = path.join(BENCH, 'libraries', 'ml-lane-b');
const LOG_DIR = path.join(BENCH, 'logs');
const RESULT_DIR = path.join(BENCH, 'results');
const ML_CORE = process.env.ML_CORE || 'E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
const { loadLibrary, verifyChain } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));

function sha256Bytes(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

function ensureDirs() { for (const d of [LOG_DIR, RESULT_DIR]) fs.mkdirSync(d, { recursive: true }); }

function buildTestLibrary() {
  // 20 blocks, chained, real content
  const shelf = 'shelf-001';
  const shelfDir = path.join(LIB_DIR, 'shelves', shelf);
  fs.rmSync(LIB_DIR, { recursive: true, force: true });
  fs.mkdirSync(shelfDir, { recursive: true });
  const blocks = [];
  for (let i = 1; i <= 20; i++) {
    const id = `cb_tamper_${String(i).padStart(4, '0')}`;
    const prev = blocks[i - 2] || null;
    const text = `---\nartifact_type: memory_block\nblock_id: ${id}\nlib_id: ${i}\nblock_number: ${i}\nstatus: active\nlineage: tamper-test\nshelf: ${shelf}\nprevious_block: ${prev ? prev.block_id : 'none'}\nprevious_sha: ${prev ? prev.sha256 : 'none'}\n---\n\nTest block ${i}. The quick brown fox jumps over the lazy dog. This is durable content that must be verified.\n`;
    const sha = sha256Bytes(Buffer.from(text, 'utf8'));
    fs.writeFileSync(path.join(shelfDir, `block-${String(i).padStart(3, '0')}.md`), text);
    blocks.push({ lib_id: i, block_id: id, shelf, sha256: sha, prev_block_id: prev ? prev.block_id : null, prev_sha256: prev ? prev.sha256 : null });
  }
  const manifest = { version: 'benchmark-v1', total_blocks: blocks.length, blocks };
  fs.writeFileSync(path.join(LIB_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return blocks;
}

function blockFilePath(libId) {
  return path.join(LIB_DIR, 'shelves', 'shelf-001', `block-${String(libId).padStart(3, '0')}.md`);
}

function randomByteMutation(filePath) {
  const buf = fs.readFileSync(filePath);
  const pos = Math.floor(Math.random() * buf.length);
  buf[pos] = (buf[pos] + 1 + Math.floor(Math.random() * 254)) % 256; // guaranteed change
  fs.writeFileSync(filePath, buf);
  return { pos, byte: buf[pos] };
}

function runTamperTest() {
  const log = [];
  // B1: 50 random 1-byte mutations, restore between each
  const b1 = [];
  for (let i = 0; i < 50; i++) {
    const target = 1 + Math.floor(Math.random() * 20); // blocks 1-20
    const file = blockFilePath(target);
    const original = fs.readFileSync(file);
    const { pos, byte } = randomByteMutation(file);
    const lib = loadLibrary(LIB_DIR);
    const chain = verifyChain(lib);
    const detected = chain.status === 'issues';
    const flagged = chain.blocks.find((b) => b.lib_id === target && b.status !== 'ok');
    b1.push({ trial: i + 1, target, pos, detected, flagged: !!flagged, flaggedLib: flagged ? flagged.lib_id : null });
    log.push({ test: 'B1', trial: i + 1, target, detected, flagged: !!flagged });
    fs.writeFileSync(file, original); // restore
  }
  const b1Detected = b1.filter((t) => t.detected).length;

  // B2a: forged block IN the manifest with a wrong recorded hash
  // (manifest says block 21 exists with sha X, but the file content differs)
  const b2 = [];
  const fakeId = 'cb_tamper_FORGED';
  const fakeText = `---\nartifact_type: memory_block\nblock_id: ${fakeId}\nlib_id: 21\nblock_number: 21\nstatus: active\nlineage: tamper-test\nshelf: shelf-001\nprevious_block: cb_tamper_0020\nprevious_sha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n---\n\nFORGED BLOCK CONTENT\n`;
  fs.writeFileSync(blockFilePath(21), fakeText);
  // add to manifest with a WRONG sha (tamper)
  const manifestPath = path.join(LIB_DIR, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.blocks.push({
    lib_id: 21, block_id: fakeId, canonical_name: fakeId, lineage: 'tamper-test',
    shelf: 'shelf-001', status: 'active',
    sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    prev_block_id: 'cb_tamper_0020', prev_sha256: 'deadbeef'
  });
  manifest.total_blocks = 21;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const lib2 = loadLibrary(LIB_DIR);
  const chain2 = verifyChain(lib2);
  const b2Detected = chain2.status === 'issues';
  const forgedFlagged = chain2.blocks.find((b) => b.lib_id === 21 && b.status !== 'ok');
  b2.push({ detected: b2Detected, reason: chain2.status, forgedFlagged: !!forgedFlagged });
  log.push({ test: 'B2a', detected: b2Detected, reason: chain2.status, forgedFlagged: !!forgedFlagged });
  fs.rmSync(blockFilePath(21));
  // restore manifest
  const m2 = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  m2.blocks = m2.blocks.filter((b) => b.lib_id !== 21);
  m2.total_blocks = 20;
  fs.writeFileSync(manifestPath, JSON.stringify(m2, null, 2));

  // B2b: stray block file on disk NOT in the manifest (documented gap)
  const b2b = [];
  fs.writeFileSync(blockFilePath(99), '---\nartifact_type: memory_block\nblock_id: cb_tamper_STRAY\nlib_id: 99\nstatus: active\n---\n\nSTRAY UNREGISTERED BLOCK\n');
  const lib2b = loadLibrary(LIB_DIR);
  const chain2b = verifyChain(lib2b);
  const b2bDetected = chain2b.status === 'issues';
  b2b.push({ detected: b2bDetected, reason: chain2b.status });
  log.push({ test: 'B2b-stray-file', detected: b2bDetected, reason: chain2b.status,
             note: 'verifyChain only checks manifest-listed blocks; unregistered files on disk are invisible to it' });
  fs.rmSync(blockFilePath(99));

  // B3: delete a block file
  const b3 = [];
  const delFile = blockFilePath(10);
  const orig = fs.readFileSync(delFile);
  fs.rmSync(delFile);
  const lib3 = loadLibrary(LIB_DIR);
  const chain3 = verifyChain(lib3);
  const b3Detected = chain3.status === 'issues';
  const missingFlag = chain3.blocks.find((b) => b.lib_id === 10 && !b.present);
  b3.push({ detected: b3Detected, missingFlagged: !!missingFlag });
  log.push({ test: 'B3', detected: b3Detected, missingFlagged: !!missingFlag });
  fs.writeFileSync(delFile, orig);

  return { b1, b1Detected, b2, b2Detected, b2b, b3, b3Detected, log };
}

async function main() {
  ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  buildTestLibrary();

  // baseline: intact before tamper
  const lib = loadLibrary(LIB_DIR);
  const baseChain = verifyChain(lib);
  console.log(`[baseline] chain intact=${baseChain.intact} ok=${baseChain.okCount}/${baseChain.total}`);

  const { b1, b1Detected, b2, b2Detected, b2b, b3, b3Detected, log } = runTamperTest();
  const b2bDetected = b2b[0]?.detected ?? false;

  const result = {
    run_id: runId,
    system: 'memory-lane',
    lane: 'B-integrity',
    baseline_chain_intact: baseChain.intact,
    baseline_ok_count: baseChain.okCount,
    B1_random_byte_mutations: { trials: b1.length, detected: b1Detected, detection_rate: b1Detected / b1.length },
    B2a_forged_block_in_manifest: { detected: b2Detected, detail: b2[0]?.reason, forged_flagged: b2[0]?.forgedFlagged },
    B2b_stray_unregistered_file: { detected: b2bDetected, detail: b2b[0]?.reason, note: 'verifyChain only checks manifest-listed blocks; unregistered files on disk are invisible (documented gap)' },
    B3_deleted_block: { detected: b3Detected, missing_flagged: b3[0]?.missingFlagged },
    honcho_comparison: 'N/A — Honcho has no tamper-evidence mechanism (factual, no score assigned)',
    verdict: (b1Detected === b1.length && b2Detected && b2bDetected === false && b3Detected) ? 'PASS_WITH_DOCUMENTED_GAP' : (b1Detected === b1.length && b2Detected && b3Detected) ? 'PASS' : 'FAIL',
  };

  fs.writeFileSync(path.join(LOG_DIR, `lane-b-${runId}.jsonl`), log.map((l) => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(RESULT_DIR, `lane-b-${runId}.json`), JSON.stringify(result, null, 2));
  console.log('\n=== LANE B (INTEGRITY) RESULT ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
