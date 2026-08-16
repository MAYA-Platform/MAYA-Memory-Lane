import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadLibrary,
  verifyChain,
  search,
  parseBlockFile,
  appendBlock,
  createBlockText
} from '../lib/memoryLaneCore.js';
import { parseFactList } from '../lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EMPTY_MANIFEST = path.join(ROOT, 'empty-library', 'MANIFEST.json');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Create a fresh temp library from the bundled empty manifest. */
function makeTempLibrary() {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-write-'));
  fs.copyFileSync(EMPTY_MANIFEST, path.join(tmp, 'MANIFEST.json'));
  return tmp;
}

test('createBlockText produces parseable frontmatter with facts section', () => {
  const text = createBlockText({
    blockId: 'cb_auto_0001',
    displayName: 'Test memory',
    blockNumber: 1,
    title: 'Test memory',
    body: 'Some body text',
    facts: ['User likes dark mode', 'User drives a Honda'],
    source: 'test'
  });
  const { fields, body } = parseBlockFile(text);
  assert.equal(fields.block_id, 'cb_auto_0001');
  assert.equal(fields.status, 'active');
  assert.match(body, /Some body text/);
  assert.match(body, /## Extracted facts/);
  assert.match(body, /User likes dark mode/);
});

test('appendBlock on an empty library seals block 1 with no predecessor', () => {
  const tmp = makeTempLibrary();
  const r = appendBlock(tmp, { title: 'First', body: 'Hello world', lineage: 'auto' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.lib_id, 1);
  assert.equal(r.block_id, 'cb_auto_001');
  assert.equal(r.prev_block_id, null);
  assert.equal(r.shelf, 'shelf-001');
  assert.equal(r.filename, 'block-001.md');

  const lib = loadLibrary(tmp);
  assert.equal(lib.ok, true);
  assert.equal(lib.totalBlocks, 1);
  const chain = verifyChain(lib);
  assert.equal(chain.intact, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('appendBlock links the second block to the first via prev_sha256', () => {
  const tmp = makeTempLibrary();
  const first = appendBlock(tmp, { title: 'First', body: 'Alpha content', lineage: 'auto' });
  const second = appendBlock(tmp, { title: 'Second', body: 'Beta content', lineage: 'auto' });

  assert.equal(second.lib_id, 2);
  assert.equal(second.prev_block_id, 'cb_auto_001');
  assert.equal(second.prev_sha256, first.sha256);

  const lib = loadLibrary(tmp);
  assert.equal(lib.totalBlocks, 2);
  const chain = verifyChain(lib);
  assert.equal(chain.intact, true);
  assert.equal(chain.total, 2);
  assert.equal(chain.okCount, 2);
  // The recorded prev_sha256 on block 2 must match block 1's on-disk hash.
  const b2 = chain.blocks.find((b) => b.lib_id === 2);
  assert.equal(b2.status, 'ok');
  assert.equal(b2.prevCheck.status, 'ok');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('appendBlock allocates max+1, not count+1 (registrar bugfix regression)', () => {
  const tmp = makeTempLibrary();
  for (let i = 1; i <= 7; i++) {
    appendBlock(tmp, { title: `B${i}`, body: `content ${i}`, lineage: 'auto' });
  }
  // Simulate compaction: drop middle blocks (4,5) from the manifest but keep
  // total_blocks at 7 (it tracks the max lib_id). Now blocks array has 5
  // entries [1,2,3,6,7] but max lib_id is 7.
  const mfPath = path.join(tmp, 'MANIFEST.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.blocks = mf.blocks.filter((b) => b.lib_id !== 4 && b.lib_id !== 5);
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  // count+1 would be 6 — which ALREADY EXISTS. max+1 = 8 is collision-proof.
  const r = appendBlock(tmp, { title: 'After compaction', body: 'content 8', lineage: 'auto' });
  assert.equal(r.lib_id, 8);
  assert.equal(r.ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('appendBlock dedups identical content even with different timestamps', () => {
  const tmp = makeTempLibrary();
  const first = appendBlock(tmp, { title: 'Dup', body: 'Same body text', lineage: 'auto', timestamp: '2026-08-05T00:00:00Z' });
  const second = appendBlock(tmp, { title: 'Dup', body: 'Same body text', lineage: 'auto', timestamp: '2026-08-05T12:00:00Z' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.lib_id, first.lib_id);
  const lib = loadLibrary(tmp);
  assert.equal(lib.totalBlocks, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('appendBlock rolls shelves at 6 blocks per shelf', () => {
  const tmp = makeTempLibrary();
  let last;
  for (let i = 1; i <= 7; i++) {
    last = appendBlock(tmp, { title: `Block ${i}`, body: `content ${i}`, lineage: 'auto' });
  }
  assert.equal(last.lib_id, 7);
  assert.equal(last.shelf, 'shelf-002');
  assert.equal(last.filename, 'block-007.md');
  const lib = loadLibrary(tmp);
  assert.equal(lib.totalShelves, 2);
  const chain = verifyChain(lib);
  assert.equal(chain.intact, true);
  assert.equal(chain.total, 7);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('appendBlock writes a shelf-manifest.json per shelf', () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'One', body: 'shelf content', lineage: 'auto' });
  const smf = JSON.parse(fs.readFileSync(path.join(tmp, 'shelves', 'shelf-001', 'shelf-manifest.json'), 'utf8'));
  assert.equal(smf.shelf_id, 'shelf-001');
  assert.equal(smf.block_count, 1);
  assert.equal(smf.blocks.length, 1);
  assert.equal(smf.block_range, 'blocks 001-001');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('blocks sealed via appendBlock are searchable', () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, {
    title: 'Civic purchase',
    body: 'Alex leased a 2026 Honda Civic in matte black.',
    facts: ['User leased a 2026 Honda Civic in matte black'],
    lineage: 'auto'
  });
  const lib = loadLibrary(tmp);
  const r = search(lib, 'civic');
  assert.ok(r.count >= 1);
  assert.equal(r.matches[0].block_id, 'cb_auto_001');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseFactList strips numbering, bullets, and preamble', () => {
  const raw = `Here are the facts:
1. User owns a Honda
2) Prefers dark mode
- Likes coffee

Note: these are all true`;
  const facts = parseFactList(raw);
  assert.deepEqual(facts, ['User owns a Honda', 'Prefers dark mode', 'Likes coffee']);
});

// --- Server write endpoints ---
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let tmpLibrary;

test.before(async () => {
  tmpLibrary = makeTempLibrary();
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), MEMORY_LANE_LIBRARY: tmpLibrary },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(() => {
  if (server) server.kill();
  if (tmpLibrary) fs.rmSync(tmpLibrary, { recursive: true, force: true });
});

test('POST /api/blocks/write seals a block with explicit facts (no LLM)', async () => {
  const r = await fetch(`${BASE}/api/blocks/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Alex decided Memory Lane should be fully automatic.',
      title: 'Automation decision',
      facts: ['User decided Memory Lane should be fully automatic'],
      source: 'test'
    })
  });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.lib_id, 1);
  assert.equal(d.chain.intact, true);
  assert.equal(d.chain.total, 1);
});

test('POST /api/ingest seals a block with auto extraction when facts absent', async () => {
  // extract is async over the network; here we only assert the write path
  // seals correctly and extraction either succeeded or degraded gracefully.
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'A second memory about the launch timeline.', source: 'test' })
  });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.lib_id, 2);
  assert.equal(d.chain.intact, true);
  assert.equal(d.chain.total, 2);
  assert.ok(d.extraction !== undefined);
});

test('POST /api/ingest rejects empty text', async () => {
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' })
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('POST /api/ingest rejects invalid JSON body', async () => {
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(r.status, 400);
});
