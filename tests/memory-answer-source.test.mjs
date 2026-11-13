import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, readBlock, search } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

function fixture(t, count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-answer-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (let i = 0; i < count; i++) appendBlock(root, {
    title: `Record ${i}`, body: `uniquehandoff evidence from record ${i}.`, lineage: 'sharedtopic'
  });
  return loadLibrary(root);
}

async function fakeJev(run, callback) {
  const oldFetch = globalThis.fetch, oldKey = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic-key';
  globalThis.fetch = async (_url, options) => {
    const keys = Object.keys(JSON.parse(options.body).questions);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(
      keys.map((key, i) => [key, { score: run(i, keys.length) }])) }) };
  };
  try { return await callback(); }
  finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;
  }
}

test('if the first selected block disappears, direct answer cites the block actually read', async t => {
  const lib = fixture(t, 2);
  const initial = search(lib, 'uniquehandoff').matches;
  assert.equal(initial.length, 2);
  const first = lib.blocks.find(b => b.lib_id === initial[0].lib_id);
  const second = lib.blocks.find(b => b.lib_id === initial[1].lib_id);
  const expected = readBlock(lib, second.lib_id).body.trim().slice(0, 600);
  let deleted = false;
  const result = await fakeJev((i) => {
    if (!deleted) { fs.unlinkSync(first.filePath); deleted = true; }
    return i === 0 ? 2 : 1;
  }, () => answerQuestion(lib, 'uniquehandoff'));
  assert.equal(result.mode, 'direct');
  assert.equal(result.answer, expected);
  assert.equal(result.source, second.block_id);
  assert.ok(result.evidence.some(e => e.block_id === result.source));
});

test('a promoted item resolves its block ID to the actual readable record', async t => {
  const lib = fixture(t, 11);
  const initial = search(lib, 'uniquehandoff', { limit: 10 }).matches;
  assert.equal(initial.length, 10);
  const promoted = lib.blocks.find(b => !initial.some(m => m.block_id === b.block_id));
  const expected = readBlock(lib, promoted.lib_id).body.trim().slice(0, 600);
  let questionCount = 0;
  const result = await fakeJev((i, n) => {
    questionCount = n;
    return i === n - 1 ? 2 : 1;
  }, () => answerQuestion(lib, 'uniquehandoff'));
  assert.equal(questionCount, 6);
  assert.equal(result.mode, 'direct');
  assert.equal(result.answer, expected);
  assert.equal(result.source, promoted.block_id);
  assert.ok(result.evidence.some(e => e.block_id === result.source));
});

test('a Jev promotion changed during scoring is omitted from answer evidence', async t => {
  const lib = fixture(t, 11);
  const initial = search(lib, 'uniquehandoff', {limit: 10}).matches;
  const promoted = lib.blocks.find(b => !initial.some(m => m.block_id === b.block_id));
  let edited = false;
  const result = await fakeJev((i, n) => {
    if (!edited) {
      fs.writeFileSync(promoted.filePath, 'replacement without the query');
      edited = true;
    }
    return i === n - 1 ? 2 : 1;
  }, () => answerQuestion(lib, 'uniquehandoff'));
  assert.equal(edited, true);
  assert.equal(result.mode, 'direct');
  assert.notEqual(result.source, promoted.block_id);
  assert.ok(result.evidence.length > 0);
  assert.equal(result.evidence.some(e => e.block_id === promoted.block_id), false);
  assert.doesNotMatch(result.answer, /replacement without/);
});



test('an empty body falls back to the selected block excerpt, not an earlier missing block', async t => {
  const lib = fixture(t, 2);
  const original = search(lib, 'uniquehandoff').matches;
  const first = lib.blocks.find(b => b.lib_id === original[0].lib_id);
  const second = lib.blocks.find(b => b.lib_id === original[1].lib_id);
  fs.writeFileSync(second.filePath, '---\ntitle: uniquehandoff second\n---\n');
  const expected = search(lib, 'uniquehandoff').matches.find(m => m.lib_id === second.lib_id).excerpt;
  let deleted = false;
  const result = await fakeJev((i) => {
    if (!deleted) { fs.unlinkSync(first.filePath); deleted = true; }
    return i === 0 ? 2 : 1;
  }, () => answerQuestion(lib, 'uniquehandoff'));
  assert.equal(result.mode, 'direct');
  assert.equal(result.source, second.block_id);
  assert.equal(result.answer, expected);
});
