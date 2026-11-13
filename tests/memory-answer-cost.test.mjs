import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

function fixture(t, extra = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-answer-cost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'First', body: 'uniqueflower record', lineage: 'first' });
  if (extra) appendBlock(root, { title: 'Second', body: 'uniqueflower another record', lineage: 'second' });
  return loadLibrary(root);
}

function isolate(t) {
  const keys = ['MEMORY_LANE_API_KEY', 'MEMORY_LANE_MODEL', 'MEMORY_LANE_BASE_URL', 'MERGE_API_KEY'];
  const values = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const fetch = globalThis.fetch;
  for (const k of keys) delete process.env[k];
  t.after(() => {
    globalThis.fetch = fetch;
    for (const k of keys) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
  });
}

test('direct answer with no external call costs zero', async t => {
  isolate(t);
  globalThis.fetch = async () => { throw Error('unexpected provider call'); };
  const result = await answerQuestion(fixture(t), 'uniqueflower');
  assert.equal(result.mode, 'direct');
  assert.equal(result.cost, 0);
});

test('a direct answer after an attempted Jev call has unknown total cost', async t => {
  isolate(t);
  const lib = fixture(t, true);
  process.env.MERGE_API_KEY = 'synthetic-only';
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const questions = Object.keys(JSON.parse(options.body).questions);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(questions.map(k => [k, { score: 2 }])) }) };
  };
  const result = await answerQuestion(lib, 'uniqueflower');
  assert.equal(result.mode, 'direct');
  assert.ok(calls > 0);
  assert.equal(result.cost, null);
});

test('synthesis success, invalid citations, failure and source drift have unknown total cost', async t => {
  for (const scenario of ['success', 'invalid', 'failure', 'source drift']) {
    await t.test(scenario, async t => {
      isolate(t);
      const lib = fixture(t);
      process.env.MEMORY_LANE_API_KEY = 'synthetic-only';
      process.env.MEMORY_LANE_MODEL = 'synthetic-unpriced-model';
      globalThis.fetch = async () => {
        if (scenario === 'failure') throw Error('fixture provider failure');
        if (scenario === 'source drift') fs.appendFileSync(lib.blocks[0].filePath, '\nchanged');
        const citations = scenario === 'invalid' ? ['unknown'] : [lib.blocks[0].block_id];
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Synthetic', citations }) } }],
          usage: { total_tokens: 100 } }) };
      };
      const result = await answerQuestion(lib, 'uniqueflower penguin');
      assert.equal(result.cost, null);
      assert.equal(result.mode, scenario === 'success' ? 'synthesized' : scenario === 'source drift' ? 'none' : 'direct');
    });
  }
});
