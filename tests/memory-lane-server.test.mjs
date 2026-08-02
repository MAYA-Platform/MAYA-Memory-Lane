import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8799; // dedicated test port
const BASE = `http://127.0.0.1:${PORT}`;

let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // wait for the server to accept connections
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
  const check = await fetch(`${BASE}/api/status`).catch(() => null);
  if (!check || !check.ok) {
    throw new Error('test server did not come up');
  }
});

test.after(() => {
  if (server) server.kill();
});

test('GET / serves the Memory Lane UI', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Memory Lane/);
  assert.match(html, /Timeline Lane/);
  assert.match(html, /Chain Integrity/);
});

test('fresh boot is BLANK: 0 blocks, mode empty', async () => {
  const r = await fetch(`${BASE}/api/status`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'empty');
  assert.equal(d.stats.totalBlocks, 0);
  assert.equal(d.chain.total, 0);
  assert.equal(d.chain.intact, true);
});

test('blank boot library label is machine-agnostic (no drive path)', async () => {
  const r = await fetch(`${BASE}/api/status`);
  const d = await r.json();
  assert.equal(d.library, 'empty-library (bundled)');
  assert.doesNotMatch(d.library, /^[A-Za-z]:[\\/]/);
  assert.doesNotMatch(d.library, /[\\/]Users[\\/]/);
});

test('blank boot: blocks list is empty', async () => {
  const r = await fetch(`${BASE}/api/blocks`);
  const d = await r.json();
  assert.equal(d.count, 0);
  assert.deepEqual(d.blocks, []);
});

test('GET /api/mode reports empty on fresh boot', async () => {
  const r = await fetch(`${BASE}/api/mode`);
  const d = await r.json();
  assert.equal(d.mode, 'empty');
});

test('sample switching requires POST (GET returns 405)', async () => {
  const r = await fetch(`${BASE}/api/load-sample`);
  assert.equal(r.status, 405);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('POST /api/load-sample switches to the bundled sample', async () => {
  const r = await fetch(`${BASE}/api/load-sample`, { method: 'POST' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'sample');
  assert.equal(d.library, 'sample-library (bundled)');
});

test('after load-sample: status reports 7 blocks intact', async () => {
  const r = await fetch(`${BASE}/api/status`);
  const d = await r.json();
  assert.equal(d.mode, 'sample');
  assert.equal(d.stats.totalBlocks, 7);
  assert.equal(d.chain.intact, true);
  assert.equal(d.chain.okCount, 7);
});

test('after load-sample: blocks list returns all 7 sorted', async () => {
  const r = await fetch(`${BASE}/api/blocks`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.count, 7);
  const ids = d.blocks.map((b) => b.lib_id);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});

test('GET /api/blocks/:id returns a parsed block', async () => {
  const r = await fetch(`${BASE}/api/blocks/3`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.block_id, 'cb_sample_0003');
  assert.equal(d.present, true);
  assert.ok(d.fields.artifact_type === 'memory_block');
  assert.match(d.body, /Budget Pass/);
});

test('GET /api/blocks/999 returns 404', async () => {
  const r = await fetch(`${BASE}/api/blocks/999`);
  assert.equal(r.status, 404);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('GET /api/chain returns the full verification walk', async () => {
  const r = await fetch(`${BASE}/api/chain`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.intact, true);
  assert.equal(d.blocks.length, 7);
  assert.ok(d.blocks.every((b) => b.status === 'ok'));
});

test('GET /api/search finds matches', async () => {
  const r = await fetch(`${BASE}/api/search?q=consolidation`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.count >= 2);
});

test('GET /api/search with no matches returns empty', async () => {
  const r = await fetch(`${BASE}/api/search?q=zzzzqqqqxxx`);
  const d = await r.json();
  assert.equal(d.count, 0);
});

test('GET /api/resume resolves a block id', async () => {
  const r = await fetch(`${BASE}/api/resume?phrase=cb_sample_0004`);
  const d = await r.json();
  assert.equal(d.found, true);
  assert.deepEqual(d.matches, [4]);
});

test('GET /api/resume with unknown phrase returns not found', async () => {
  const r = await fetch(`${BASE}/api/resume?phrase=nope-123`);
  const d = await r.json();
  assert.equal(d.found, false);
});

test('GET /api/export returns a complete deterministic bundle', async () => {
  const r = await fetch(`${BASE}/api/export`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.blockCount, 7);
  assert.ok(d.blocks.every((b) => b.recorded_sha256 === b.computed_sha256));
});

test('POST /api/load-empty returns to a blank lane', async () => {
  const r = await fetch(`${BASE}/api/load-empty`, { method: 'POST' });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'empty');
  const s = await (await fetch(`${BASE}/api/status`)).json();
  assert.equal(s.stats.totalBlocks, 0);
});

test('sample switching disabled when MEMORY_LANE_LIBRARY is external (400)', async () => {
  // Spin a second server pinned to the sample as an "external" library.
  const p2 = 8797;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(p2), MEMORY_LANE_LIBRARY: path.join(ROOT, 'sample-library') },
    stdio: 'ignore'
  });
  const base2 = `http://127.0.0.1:${p2}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base2}/api/status`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    const mode = await (await fetch(`${base2}/api/mode`)).json();
    assert.equal(mode.mode, 'external');
    const r = await fetch(`${base2}/api/load-sample`, { method: 'POST' });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.equal(d.ok, false);
  } finally {
    srv.kill();
  }
});

test('unknown API route returns 404 JSON', async () => {
  const r = await fetch(`${BASE}/api/nope`);
  assert.equal(r.status, 404);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('static image route serves from public/images', async () => {
  const fs = await import('node:fs');
  const imgDir = path.join(ROOT, 'public', 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const png = path.join(imgDir, 'test.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const r = await fetch(`${BASE}/images/test.png`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);
  fs.rmSync(png, { force: true });
});
