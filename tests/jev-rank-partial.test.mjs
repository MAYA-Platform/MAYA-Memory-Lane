import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { jevRank, jevStats } from '../lib/jevrank.js';

async function withFakeJev(scores, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-main-rank-'));
  const oldKey = process.env.MERGE_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.MERGE_API_KEY = 'synthetic-key';
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
    await fn({ library, matches });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [label, scores] of [['missing', [2, undefined, 0]], ['out of range', [2, 3, 0]], ['not finite', [2, NaN, 0]]]) {
  test(`${label} Jev score preserves all lexical matches`, async () => {
    await withFakeJev(scores, async ({ library, matches }) => {
      const before = jevStats();
      const result = await jevRank(library, 'handoff', matches);
      const after = jevStats();
      assert.deepEqual(result.matches, matches);
      assert.equal(result.jev.applied, false);
      assert.equal(result.jev.reason, 'jev_incomplete_scores');
      assert.equal(result.jev.scored, 2);
      assert.equal(after.lastAppliedAt, before.lastAppliedAt);
      assert.equal(after.failures, before.failures + 1);
    });
  });
}

test('complete Jev scores still rank results', async () => {
  await withFakeJev([0, 1, 2], async ({ library, matches }) => {
    const result = await jevRank(library, 'handoff', matches);
    assert.equal(result.jev.applied, true);
    assert.deepEqual(result.matches.map(m => m.block_id), [...matches].reverse().map(m => m.block_id));
    assert.deepEqual(result.matches.map(m => m.jev_score), [2, 1, 0]);
  });
});
