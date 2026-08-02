import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadLibrary,
  readBlock,
  verifyChain,
  search,
  resolveResume,
  exportLibrary,
  libraryStats,
  parseBlockFile
} from '../lib/memoryLaneCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '..', 'sample-library');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('loadLibrary reads the sample library manifest', () => {
  const lib = loadLibrary(SAMPLE);
  assert.equal(lib.ok, true);
  assert.equal(lib.totalBlocks, 7);
  assert.equal(lib.blocks.length, 7);
  assert.equal(lib.totalShelves, 2);
});

test('loadLibrary fails cleanly on a non-library path', () => {
  const lib = loadLibrary(path.join(__dirname, '..', 'tests'));
  assert.equal(lib.ok, false);
  assert.match(lib.reason, /MANIFEST\.json not found/);
});

test('loadLibrary fails cleanly when manifest has no blocks array', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-badmanifest-'));
  fs.writeFileSync(path.join(tmp, 'MANIFEST.json'), JSON.stringify({ library: 'x' }));
  const lib = loadLibrary(tmp);
  assert.equal(lib.ok, false);
  assert.match(lib.reason, /blocks array/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseBlockFile splits frontmatter and body', () => {
  const { fields, body } = parseBlockFile('---\nblock_id: test_1\nstatus: active\n---\n\n# Heading\n\nBody text');
  assert.equal(fields.block_id, 'test_1');
  assert.equal(fields.status, 'active');
  assert.match(body, /# Heading/);
});

test('readBlock returns frontmatter, body, and computed sha', () => {
  const lib = loadLibrary(SAMPLE);
  const block = readBlock(lib, 1);
  assert.equal(block.present, true);
  assert.equal(block.block_id, 'cb_sample_0001');
  assert.ok(block.fields.artifact_type === 'memory_block');
  assert.match(block.body, /Sample Micro Block/);
  assert.equal(block.sha256.length, 64);
});

test('readBlock returns null for unknown lib_id', () => {
  const lib = loadLibrary(SAMPLE);
  assert.equal(readBlock(lib, 999), null);
});

test('verifyChain reports the sample chain intact 7/7', () => {
  const lib = loadLibrary(SAMPLE);
  const chain = verifyChain(lib);
  assert.equal(chain.intact, true);
  assert.equal(chain.okCount, 7);
  assert.equal(chain.total, 7);
  assert.equal(chain.status, 'intact');
  assert.equal(chain.issues, 0);
});

test('verifyChain catches a tampered block file', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-tamper-'));
  const block1 = path.join(SAMPLE, 'shelves', 'shelf-001', 'block-001.md');
  const target = path.join(tmp, 'shelves', 'shelf-001');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(block1, path.join(target, 'block-001.md'));
  // write a minimal manifest pointing at the tampered shelf
  const lib = loadLibrary(SAMPLE);
  const block = readBlock(lib, 1);
  fs.writeFileSync(path.join(target, 'block-001.md'), block.raw + '\n// tampered\n');
  const fakeManifest = {
    library: 'x', version: '1', schema_version: '1',
    created: '2026-01-01T00:00:00Z', updated: 1, total_blocks: 1, total_shelves: 1,
    volumes: [], shelves: ['shelf-001'],
    blocks: [{
      lib_id: 1, canonical_name: 'cb_tamper_0001', shelf: 'shelf-001', position: 1,
      block_id: 'cb_tamper_0001', lineage: 'cb_tamper', volume: 'volume-other',
      status: 'active', revision_version: '0.1', sha256: block.sha256,
      prev_block_id: null, prev_sha256: null, supersedes_id: null, superseded_by_id: null,
      filename: 'block-001.md'
    }],
    lineages: {}
  };
  fs.writeFileSync(path.join(tmp, 'MANIFEST.json'), JSON.stringify(fakeManifest));
  const tampered = loadLibrary(tmp);
  const chain = verifyChain(tampered);
  assert.equal(chain.intact, false);
  assert.equal(chain.blocks[0].status, 'hash_mismatch');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('verifyChain resolves string prev_block_id links', () => {
  const lib = loadLibrary(SAMPLE);
  const chain = verifyChain(lib);
  // block 4's prev is cb_sample_0003 — a string id, not a number
  const b4 = chain.blocks.find((b) => b.lib_id === 4);
  assert.equal(b4.prevBlockId, 'cb_sample_0003');
  assert.equal(b4.status, 'ok');
});

test('search finds matches across block bodies', () => {
  const lib = loadLibrary(SAMPLE);
  const r = search(lib, 'consolidation');
  assert.ok(r.count >= 2);
  assert.ok(r.matches.every((m) => m.lib_id && m.block_id));
});

test('search returns zero matches for gibberish', () => {
  const lib = loadLibrary(SAMPLE);
  const r = search(lib, 'zzzzqqqqxxx');
  assert.equal(r.count, 0);
  assert.deepEqual(r.matches, []);
});

test('search with empty query returns zero matches', () => {
  const lib = loadLibrary(SAMPLE);
  const r = search(lib, '   ');
  assert.equal(r.count, 0);
});

test('search excerpts contain the query', () => {
  const lib = loadLibrary(SAMPLE);
  const r = search(lib, 'fingerprint');
  assert.ok(r.count > 0);
  assert.ok(r.matches[0].excerpt.toLowerCase().includes('fingerprint'));
});

test('resolveResume finds exact block_id', () => {
  const lib = loadLibrary(SAMPLE);
  const r = resolveResume(lib, 'cb_sample_0004');
  assert.equal(r.found, true);
  assert.deepEqual(r.matches, [4]);
});

test('resolveResume matches the consolidated block', () => {
  const lib = loadLibrary(SAMPLE);
  const r = resolveResume(lib, 'cb_sample_consolidated_0001_0006');
  assert.equal(r.found, true);
  assert.deepEqual(r.matches, [7]);
});

test('resolveResume is case-insensitive on substrings', () => {
  const lib = loadLibrary(SAMPLE);
  const r = resolveResume(lib, 'SAMPLE_0002');
  assert.equal(r.found, true);
  assert.ok(r.matches.includes(2));
});

test('resolveResume returns not found for unknown phrase', () => {
  const lib = loadLibrary(SAMPLE);
  const r = resolveResume(lib, 'nothing-here-12345');
  assert.equal(r.found, false);
  assert.equal(r.matches.length, 0);
});

test('exportLibrary is deterministic and complete', () => {
  const lib = loadLibrary(SAMPLE);
  const a = exportLibrary(lib);
  const b = exportLibrary(lib);
  assert.deepEqual(a.blocks, b.blocks);
  assert.equal(a.blockCount, 7);
  assert.ok(a.blocks.every((x) => x.recorded_sha256 && x.computed_sha256));
  assert.ok(a.blocks.every((x) => x.recorded_sha256 === x.computed_sha256));
});

test('sample blocks carry no internal stack vocabulary', () => {
  // Public demo data must not leak internal agent/provider identities.
  const lib = loadLibrary(SAMPLE);
  const exported = exportLibrary(lib);
  const blob = JSON.stringify(exported);
  for (const token of ['hermes', 'deepseek', 'merge_gateway', 'custom_merge', 'api.deepseek']) {
    assert.doesNotMatch(blob.toLowerCase(), new RegExp(token), `block data leaked "${token}"`);
  }
});

test('exportLibrary blocks are sorted by lib_id', () => {
  const lib = loadLibrary(SAMPLE);
  const out = exportLibrary(lib);
  const ids = out.blocks.map((b) => b.lib_id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
});

test('libraryStats reports block, shelf, lineage, chain counts', () => {
  const lib = loadLibrary(SAMPLE);
  const s = libraryStats(lib);
  assert.equal(s.totalBlocks, 7);
  assert.equal(s.totalShelves, 2);
  assert.equal(s.lineageCount, 1);
  assert.equal(s.chainIntact, true);
  assert.equal(s.firstBlock, 1);
  assert.equal(s.lastBlock, 7);
});

test('libraryStats reports issues when chain broken', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-stats-'));
  fs.mkdirSync(path.join(tmp, 'shelves', 'shelf-001'), { recursive: true });
  const src = path.join(SAMPLE, 'shelves', 'shelf-001', 'block-001.md');
  fs.copyFileSync(src, path.join(tmp, 'shelves', 'shelf-001', 'block-001.md'));
  fs.writeFileSync(path.join(tmp, 'MANIFEST.json'), JSON.stringify({
    library: 'x', version: '1', schema_version: '1',
    created: '2026-01-01T00:00:00Z', updated: 1, total_blocks: 1, total_shelves: 1,
    volumes: [], shelves: ['shelf-001'],
    blocks: [{
      lib_id: 1, canonical_name: 'cb_x', shelf: 'shelf-001', position: 1, block_id: 'cb_x',
      lineage: 'cb_x', volume: 'volume-other', status: 'active', revision_version: '0.1',
      sha256: 'deadbeef', prev_block_id: null, prev_sha256: null,
      supersedes_id: null, superseded_by_id: null, filename: 'block-001.md'
    }],
    lineages: {}
  }));
  const lib = loadLibrary(tmp);
  const s = libraryStats(lib);
  assert.equal(s.chainIntact, false);
  assert.equal(s.issues, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hash of a block file matches its manifest sha256', () => {
  const lib = loadLibrary(SAMPLE);
  for (const b of lib.blocks) {
    const text = fs.readFileSync(b.filePath, 'utf8');
    assert.equal(sha256(text), b.sha256, `lib ${b.lib_id} sha mismatch`);
  }
});

test('sample library is deterministic across regeneration', () => {
  // Regenerate into a temp dir and compare key hashes with the committed sample
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-gen-'));
  execFileSync(process.execPath, [
    path.resolve(__dirname, '..', 'tools', 'make-sample-library.mjs'),
    path.join(tmp, 'sample-library')
  ]);
  const origManifest = fs.readFileSync(path.join(SAMPLE, 'MANIFEST.json'), 'utf8');
  const newManifest = fs.readFileSync(path.join(tmp, 'sample-library', 'MANIFEST.json'), 'utf8');
  assert.equal(sha256(newManifest), sha256(origManifest));
  fs.rmSync(tmp, { recursive: true, force: true });
});
