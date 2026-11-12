import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { jevRank, jevStats } from '../lib/jevrank.js';
import { recentSelection } from '../lib/retrieval.js';

async function withFakeJev(scores, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-partial-rank-'));
  const oldKey = process.env.MERGE_API_KEY;
  const oldLedger = process.env.MEMORY_LANE_JEVRANK_LEDGER;
  const oldFetch = globalThis.fetch;
  process.env.MERGE_API_KEY = 'synthetic-key';
  process.env.MEMORY_LANE_JEVRANK_LEDGER = path.join(root, 'ledger.jsonl');
  globalThis.fetch = async (_url, options) => {
    const questions = Object.keys(JSON.parse(options.body).questions);
    assert.equal(questions.length, 3);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(
      scores.map((score, i) => [questions[i], { score }]).filter(([, a]) => a.score !== undefined)
    ), usage: { cost: 0.001 } }) };
  };
  try {
    fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ version: 1, total_blocks: 0, blocks: [] }));
    for (const title of ['Alpha', 'Beta', 'Gamma']) appendBlock(root, { title, body: `${title} handoff status`, lineage: title });
    const library = loadLibrary(root);
    const matches = search(library, 'handoff').matches;
    assert.equal(matches.length, 3);
    await fn({ library, matches, root });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;
    if (oldLedger === undefined) delete process.env.MEMORY_LANE_JEVRANK_LEDGER; else process.env.MEMORY_LANE_JEVRANK_LEDGER = oldLedger;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('incomplete Jev scoring retains every lexical match and emits a degraded receipt', async () => {
  await withFakeJev([2, undefined, 0], async ({ library, matches, root }) => {
    const before = jevStats();
    const result = await jevRank(library, 'handoff', matches);
    const after = jevStats();
    assert.equal(after.lastAppliedAt, before.lastAppliedAt);
    assert.equal(after.failures, before.failures + 1);
    assert.deepEqual(result.matches, matches);
    assert.equal(result.jev.applied, false);
    assert.equal(result.jev.reason, 'jev_incomplete_scores');
    assert.equal(result.jev.scored, 2);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8'));
    assert.equal(receipt.applied, false);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error, 'jev_incomplete_scores');
    assert.equal(receipt.scored, 2);
    assert.equal(receipt.cost_usd, 0.001);
  });
});

test('complete Jev scoring still reorders verified results', async () => {
  await withFakeJev([0, 1, 2], async ({ library, matches }) => {
    const result = await jevRank(library, 'handoff', matches);
    assert.equal(result.jev.applied, true);
    assert.deepEqual(result.matches.map(m => m.block_id), [...matches].reverse().map(m => m.block_id));
    assert.deepEqual(result.matches.map(m => m.jev_score), [2, 1, 0]);
  });
});


test('session-open retrieval falls back to the original freshness order on partial scoring', async () => {
  await withFakeJev([2, undefined, 0], async ({ library }) => {
    const baseline = await recentSelection(library, { limit: 2 });
    const result = await recentSelection(library, { limit: 2, rank: jevRank, available: () => true });
    assert.equal(result.selection, 'freshness');
    assert.equal(result.jev.reason, 'jev_incomplete_scores');
    assert.deepEqual(result.blocks, baseline.blocks);
  });
});
