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
  // C1 (Packet 11): boot verify is async — before the first worker pass the
  // chain is honestly UNVERIFIED (intact null), never a fake 'intact'.
  assert.equal(d.chain.intact, null);
  assert.equal(d.chain.status, 'unverified');
  assert.equal(d.chain.freshness, 'UNVERIFIED');
});

test('GET /api/health reports honest UNVERIFIED before the first background pass', async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  // C1: no synchronous boot verify anymore — the verdict arrives from the
  // background worker shortly after boot (see the async-landing test below).
  assert.equal(d.chain.intact, null);
  assert.equal(d.chain.status, 'unverified');
  assert.equal(d.chain.freshness, 'UNVERIFIED');
  assert.equal(d.chain.verifiedAt, null);
});

test('GET /api/ready exercises the library read path (beyond /api/health)', async () => {
  // /api/health never touches the library; /api/ready loads it and reads a
  // block file, so a 200 means the read path itself is serving.
  const r = await fetch(`${BASE}/api/ready`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.ready, true);
  assert.equal(d.mode, 'empty');
  assert.equal(d.totalBlocks, 0);
  assert.equal(d.probe_block, null);
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

test('after load-sample: /api/health chain reflects the active library', async () => {
  const r = await fetch(`${BASE}/api/health`);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.chain.intact, true);
  assert.equal(d.chain.total, 7);
  assert.equal(d.chain.okCount, 7);
  assert.equal(d.chain.hardIssues, 0);
});

test('after load-sample: blocks list returns all 7 sorted', async () => {
  const r = await fetch(`${BASE}/api/blocks`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.count, 7);
  const ids = d.blocks.map((b) => b.lib_id);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});

test('GET /api/ready reports sample mode with a probe block after load-sample', async () => {
  const r = await fetch(`${BASE}/api/ready`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ready, true);
  assert.equal(d.mode, 'sample');
  assert.equal(d.totalBlocks, 7);
  assert.equal(d.probe_block, 7);
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

test('GET /api/chain serves the cached verdict with freshness (async C1 contract)', async () => {
  // C1: /api/chain no longer verifies in-request. Right after boot there is
  // no cached verdict yet: the endpoint answers 202 PENDING and schedules a
  // background pass. Once the worker lands (a second or two on the 7-block
  // sample) the same endpoint serves the full verdict with a freshness tag.
  let r = await fetch(`${BASE}/api/chain`);
  if (r.status === 202) {
    const p = await r.json();
    assert.equal(p.pending, true);
    assert.equal(p.freshness, 'UNVERIFIED');
    // wait for the background worker to land its verdict
    const deadline = Date.now() + 10000;
    let landed = null;
    while (Date.now() < deadline && !landed) {
      await new Promise((res) => setTimeout(res, 250));
      const rr = await fetch(`${BASE}/api/chain`);
      if (rr.status === 200) landed = await rr.json();
    }
    assert.ok(landed, 'background verify did not land within 10s');
    r = { status: 200 };
    var d = landed;
  } else {
    var d = await r.json();
  }
  assert.equal(r.status, 200);
  assert.equal(d.ok, true);
  assert.equal(d.intact, true);
  assert.equal(d.total, 7);
  assert.equal(d.okCount, 7);
  assert.equal(d.freshness, 'CURRENT');
  assert.ok(d.verifiedAt, 'verifiedAt timestamp missing');
});

test('GET /api/search finds matches', async () => {
  const r = await fetch(`${BASE}/api/search?q=records`);
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

test('corrupted SANDBOX library: background verify surfaces the broken chain', async () => {
  // Copy the sample library into a temp dir and tamper with one block file
  // so its on-disk hash no longer matches the manifest. C1: the boot verdict
  // is honestly UNVERIFIED, then the background worker pass lands and
  // /api/health must surface the breakage — never silent, never fake-intact.
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-health-corrupt-'));
  fs.cpSync(path.join(ROOT, 'sample-library'), tmp, { recursive: true });
  // tamper the first block file found under shelves/ (no shelf-layout assumptions)
  const shelvesDir = path.join(tmp, 'shelves');
  const stack = [shelvesDir];
  let tampered = false;
  while (stack.length && !tampered) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.md')) {
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n// tampered\n');
        tampered = true;
        break;
      }
    }
  }
  assert.ok(tampered, 'no block file found to tamper in sample copy');
  const p3 = 8796;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(p3), MEMORY_LANE_LIBRARY: tmp },
    stdio: 'ignore'
  });
  const base3 = `http://127.0.0.1:${p3}`;
  const deadline = Date.now() + 8000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base3}/api/status`);
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    assert.ok(up, 'corrupted-library test server did not come up');
    // Phase 1: before the worker lands, the verdict is honestly UNVERIFIED.
    const early = await (await fetch(`${base3}/api/health`)).json();
    assert.equal(early.ok, true);
    if (!early.chain.verifiedAt) {
      assert.equal(early.chain.status, 'unverified');
    }
    // Phase 2: poll until the background worker lands its verdict (10s cap —
    // a 7-block pass takes ~1s even on slow disks).
    const landDeadline = Date.now() + 10000;
    let d = null;
    while (Date.now() < landDeadline && !d) {
      await new Promise((res) => setTimeout(res, 250));
      const r = await fetch(`${base3}/api/health`);
      const j = await r.json();
      if (j.chain.verifiedAt) d = j;
    }
    assert.ok(d, 'background verify did not land within 10s');
    assert.equal(d.chain.intact, false);
    assert.equal(d.chain.status, 'issues');
    assert.ok(d.chain.hardIssues >= 1);
    assert.ok(d.chain.issues >= 1);
  } finally {
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('boot seeds the chain verdict from a prior shadow state file (C1 restart contract)', async () => {
  // Fresh boot with MEMORY_LANE_SHADOW_STATE pointing at a valid state file:
  // /api/health serves the seeded verdict IMMEDIATELY (no 10s worker wait)
  // and reports it as CURRENT. This is the restart-fast-path from C1.
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-seed-'));
  const statePath = path.join(tmp, 'shadow_state.json');
  const state = {
    schema: 'ml.shadow_health/1',
    library: path.resolve(ROOT, 'sample-library'),
    at: Date.now() - 60 * 1000,
    at_iso: new Date(Date.now() - 60 * 1000).toISOString(),
    duration_ms: 12,
    manifest_blocks: 7,
    readable_blocks: 7,
    chain: { intact: true, status: 'intact', total: 7, okCount: 7, issues: 0, hardIssues: 0, unchecked: 0, verifiedRun: 7 },
    classification: { status: 'ok', missing: [], hash_issues: [], link_issues: [], divergence: null },
    error: null,
    stale_after_ms: 660000
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const p4 = 8797;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(p4), MEMORY_LANE_LIBRARY: path.join(ROOT, 'sample-library'), MEMORY_LANE_SHADOW_STATE: statePath },
    stdio: 'ignore'
  });
  const base4 = `http://127.0.0.1:${p4}`;
  try {
    const deadline = Date.now() + 8000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try { if ((await fetch(`${base4}/api/status`)).ok) up = true; } catch { /* not up yet */ }
      if (!up) await new Promise((res) => setTimeout(res, 150));
    }
    assert.ok(up, 'seeded-boot test server did not come up');
    const d = await (await fetch(`${base4}/api/health`)).json();
    assert.equal(d.ok, true);
    // Seeded on boot: verified BEFORE any background pass could land.
    assert.equal(d.chain.intact, true);
    assert.equal(d.chain.status, 'intact');
    assert.equal(d.chain.total, 7);
    assert.equal(d.chain.okCount, 7);
    assert.equal(d.chain.freshness, 'CURRENT');
    assert.ok(d.chain.verifiedAt, 'seeded verdict missing verifiedAt');
  } finally {
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
