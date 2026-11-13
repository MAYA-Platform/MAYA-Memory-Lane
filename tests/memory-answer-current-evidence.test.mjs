import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

test('fallback uses current readable evidence after ranking', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['first', 'second']) appendBlock(root, { title, body: 'uniqueword original evidence', lineage: title });
  const library = loadLibrary(root);
  const matches = search(library, 'uniqueword').matches;
  const first = library.blocks.find(b => b.lib_id === matches[0].lib_id);
  const second = library.blocks.find(b => b.lib_id === matches[1].lib_id);
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.MERGE_API_KEY;
  const oldMemoryKey = process.env.MEMORY_LANE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic';
  process.env.MEMORY_LANE_API_KEY = 'synthetic';
  globalThis.fetch = async (_url, options) => {
    if (!JSON.parse(options.body).questions) throw new Error('synthetic provider failure');
    fs.unlinkSync(first.filePath);
    fs.writeFileSync(second.filePath, '# Updated\nFresh replacement without search term.\n');
    const keys = Object.keys(JSON.parse(options.body).questions);
    return {ok: true, json: async () => ({answers: Object.fromEntries(keys.map((k, i) => [k, {score: 2-i}]))})};
  };
  t.after(() => {globalThis.fetch = originalFetch; if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey; if (oldMemoryKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldMemoryKey;});
  const answer = await answerQuestion(library, 'uniqueword');
  assert.equal(answer.source, second.block_id);
  assert.match(answer.answer, /Fresh replacement/);
  assert.equal(answer.evidence.length, 1);
  assert.equal(answer.evidence[0].manifest_hash_status, 'mismatch');
  assert.match(answer.note, /synthesis failed/);
});

test('no surviving blocks returns no answer or synthesis call', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-evidence-empty-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks: []}));
  for (const title of ['a', 'b']) appendBlock(root, {title, body: 'uniqueword evidence', lineage: title});
  const library = loadLibrary(root);
  const oldFetch = globalThis.fetch, oldKey = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic';
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    for (const b of library.blocks) fs.unlinkSync(b.filePath);
    const keys = Object.keys(JSON.parse(options.body).questions);
    return {ok: true, json: async () => ({answers: Object.fromEntries(keys.map(k => [k, {score: 2}]))})};
  };
  t.after(() => {globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;});
  const result = await answerQuestion(library, 'uniqueword');
  assert.equal(result.mode, 'none');
  assert.deepEqual(result.evidence, []);
  assert.equal(calls, 1);
});
