import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { jevRank } from '../lib/jevrank.js';

/**
 * JevRank persistent receipt ledger (F10 observability parity, 2026-09-23).
 *
 * Ledger-hygiene contract (same discipline as the jev_boundary_fixtures
 * suite): every test runs against a TEMP library, so the production ledger
 * (<real library>/health/jevrank_ledger.jsonl) can never receive a test
 * receipt — isolation is by construction, not by cleanup.
 *
 * No Jev key is required: the tests exercise the no-key failure path (a
 * real, receipted error row) and the defensive receipt-write path. The
 * success-row shape is covered by the live receipt landed on the real
 * server (see the task receipt), not by these offline tests.
 */

function makeTempLibrary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-jevrank-'));
  fs.writeFileSync(path.join(tmp, 'MANIFEST.json'), JSON.stringify({
    version: 1, total_blocks: 0, blocks: []
  }));
  return tmp;
}

function readLedger(libRoot) {
  const p = path.join(libRoot, 'health', 'jevrank_ledger.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('rerank with no key appends a failure receipt next to the temp library', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'alpha body one', lineage: 'lane-a' });
  appendBlock(tmp, { title: 'B', body: 'beta body two', lineage: 'lane-b' });
  const lib = loadLibrary(tmp);
  const savedKey = process.env.MERGE_API_KEY;
  const savedCfg = process.env.MEMORY_LANE_MERGE_CONFIG;
  const savedHome = process.env.LOCALAPPDATA;
  delete process.env.MERGE_API_KEY;
  // Redirect the operator-config fallback (LOCALAPPDATA/hermes/config.yaml)
  // to a file that cannot exist, so no real key resolves.
  process.env.MEMORY_LANE_MERGE_CONFIG = path.join(tmp, 'no-such-config.yaml');
  process.env.LOCALAPPDATA = tmp;

  try {
    const out = await jevRank(lib, 'body', resultMatches(lib, 'body'), { topN: 10 });
    assert.equal(out.jev.applied, false); // search unaffected
    assert.equal(out.matches.length >= 1, true); // results still returned

    const rows = readLedger(tmp);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].applied, false);
    assert.equal(typeof rows[0].error, 'string');
    assert.equal(rows[0].n_candidates > 0, true);
    assert.equal(rows[0].cost_usd, 0);
    assert.ok(rows[0].ts);
    assert.ok(rows[0].model);
    assert.ok(rows[0].query.length <= 120);
  } finally {
    if (savedKey !== undefined) process.env.MERGE_API_KEY = savedKey; else delete process.env.MERGE_API_KEY;
    if (savedCfg !== undefined) process.env.MEMORY_LANE_MERGE_CONFIG = savedCfg; else delete process.env.MEMORY_LANE_MERGE_CONFIG;
    if (savedHome !== undefined) process.env.LOCALAPPDATA = savedHome; else delete process.env.LOCALAPPDATA;
  }
});

test('receipt write failure never breaks search (defensive rule)', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'alpha body one', lineage: 'lane-a' });
  appendBlock(tmp, { title: 'B', body: 'beta body two', lineage: 'lane-b' });
  const lib = loadLibrary(tmp);
  const savedKey = process.env.MERGE_API_KEY;
  const savedCfg = process.env.MEMORY_LANE_MERGE_CONFIG;
  const savedHome = process.env.LOCALAPPDATA;
  delete process.env.MERGE_API_KEY;
  process.env.MEMORY_LANE_MERGE_CONFIG = path.join(tmp, 'no-such-config.yaml');
  process.env.LOCALAPPDATA = tmp;
  // Point the ledger at an impossible path: mkdir/append must fail and be
  // swallowed — search still returns results.
  process.env.MEMORY_LANE_JEVRANK_LEDGER = path.join(tmp, 'no-such-dir', 'x', 'ledger.jsonl');
  // Windows: a path segment reserved as a device name makes creation fail.
  if (process.platform === 'win32') {
    process.env.MEMORY_LANE_JEVRANK_LEDGER = path.join(tmp, 'con', 'ledger.jsonl');
  }

  try {
    const out = await jevRank(lib, 'body', resultMatches(lib, 'body'), { topN: 10 });
    assert.equal(out.jev.applied, false);
    assert.equal(out.matches.length >= 1, true); // the load-bearing assertion
  } finally {
    if (savedKey !== undefined) process.env.MERGE_API_KEY = savedKey; else delete process.env.MERGE_API_KEY;
    if (savedCfg !== undefined) process.env.MEMORY_LANE_MERGE_CONFIG = savedCfg; else delete process.env.MEMORY_LANE_MERGE_CONFIG;
    if (savedHome !== undefined) process.env.LOCALAPPDATA = savedHome; else delete process.env.LOCALAPPDATA;
    delete process.env.MEMORY_LANE_JEVRANK_LEDGER;
  }
});

test('rerank without an actual Jev call writes NO receipt', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'alpha body one', lineage: 'lane-a' });
  const lib = loadLibrary(tmp);
  const out = await jevRank(lib, 'body', resultMatches(lib, 'body'), { topN: 10 });
  assert.equal(out.jev.applied, false);
  assert.equal(readLedger(tmp).length, 0); // single candidate -> plain passthrough
});

test('MEMORY_LANE_JEVRANK_LEDGER redirect is honored (test isolation lane)', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'alpha body one', lineage: 'lane-a' });
  appendBlock(tmp, { title: 'B', body: 'beta body two', lineage: 'lane-b' });
  const lib = loadLibrary(tmp);
  const redirected = path.join(tmp, 'redirected-ledger.jsonl');
  const savedKey = process.env.MERGE_API_KEY;
  const savedCfg = process.env.MEMORY_LANE_MERGE_CONFIG;
  const savedHome = process.env.LOCALAPPDATA;
  delete process.env.MERGE_API_KEY;
  process.env.MEMORY_LANE_MERGE_CONFIG = path.join(tmp, 'no-such-config.yaml');
  process.env.LOCALAPPDATA = tmp;
  process.env.MEMORY_LANE_JEVRANK_LEDGER = redirected;

  try {
    await jevRank(lib, 'body', resultMatches(lib, 'body'), { topN: 10 });
    assert.equal(fs.existsSync(redirected), true);
    assert.equal(fs.existsSync(path.join(tmp, 'health', 'jevrank_ledger.jsonl')), false);
  } finally {
    if (savedKey !== undefined) process.env.MERGE_API_KEY = savedKey; else delete process.env.MERGE_API_KEY;
    if (savedCfg !== undefined) process.env.MEMORY_LANE_MERGE_CONFIG = savedCfg; else delete process.env.MEMORY_LANE_MERGE_CONFIG;
    if (savedHome !== undefined) process.env.LOCALAPPDATA = savedHome; else delete process.env.LOCALAPPDATA;
    delete process.env.MEMORY_LANE_JEVRANK_LEDGER;
  }
});

/** Real search() output — candidate-shaped exactly as server.mjs passes it. */
function resultMatches(lib, q) {
  return search(lib, q).matches;
}
