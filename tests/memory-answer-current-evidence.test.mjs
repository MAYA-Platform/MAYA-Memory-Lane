import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

test('initially selected evidence disappearing during wider search is not silently replaced', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-pre-rerank-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['first', 'second', 'third']) appendBlock(root, {title, body: 'uniqueword original evidence', lineage: title});
  const library = loadLibrary(root);
  const initial = search(library, 'uniqueword').matches;
  const first = library.blocks.find(b => b.lib_id === initial[0].lib_id);
  const originalRead = fs.promises.readFile, oldFetch = globalThis.fetch, oldKey = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic-only';
  let reads = 0, providerCalls = 0;
  fs.promises.readFile = async function (file, ...args) {
    if (file === first.filePath && ++reads === 2) fs.unlinkSync(file);
    return originalRead.call(this, file, ...args);
  };
  globalThis.fetch = async (_url, options) => {
    providerCalls++;
    const questions = JSON.parse(options.body).questions;
    return {ok: true, json: async () => ({answers: Object.fromEntries(Object.keys(questions).map(k => [k, {score: 2}]))})};
  };
  try {
    const result = await answerQuestion(library, 'uniqueword');
    assert.equal(result.mode, 'none');
    assert.match(result.answer, /Memory changed/);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.cost, 0);
    assert.equal(providerCalls, 0);
  } finally {
    fs.promises.readFile = originalRead;
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;
  }
});

test('initial evidence replaced by reranking is still checked after synthesis', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-reranked-initial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['first', 'second', 'third', 'fourth']) appendBlock(root, {title, body: 'uniqueword original evidence', lineage: title});
  const library = loadLibrary(root);
  const initial = search(library, 'uniqueword penguin').matches;
  const first = library.blocks.find(b => b.lib_id === initial[0].lib_id);
  const oldFetch = globalThis.fetch, oldJev = process.env.MERGE_API_KEY, oldMemory = process.env.MEMORY_LANE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic-only'; process.env.MEMORY_LANE_API_KEY = 'synthetic-only';
  let synthesisCalled = false;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.questions) {
      return {ok: true, json: async () => ({answers: Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, {score: i === 0 ? 0 : 2}]))})};
    }
    synthesisCalled = true;
    const context = JSON.parse(body.messages[1].content.split('MEMORY EVIDENCE:\n')[1].split('\n\nQUESTION:')[0]);
    assert.equal(context.some(entry => entry.id === first.block_id), false);
    fs.appendFileSync(first.filePath, '\nchanged while synthesizing');
    return {ok: true, json: async () => ({choices: [{message: {content: JSON.stringify({answer: 'Synthetic answer.', citations: [context[0].id]})}}]})};
  };
  try {
    const result = await answerQuestion(library, 'uniqueword penguin');
    assert.equal(synthesisCalled, true);
    assert.equal(result.mode, 'none');
    assert.match(result.answer, /Memory changed/);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.cost, null);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
    if (oldMemory === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldMemory;
  }
});

test('one changed selected block rejects the whole answer while another survives', async t => {
  for (const scenario of ['changed', 'deleted', 'manifest']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-one-selected-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
    for (const title of ['first', 'second']) appendBlock(root, {title, body: 'uniqueword original evidence', lineage: title});
    const library = loadLibrary(root);
    const matches = search(library, 'uniqueword').matches;
    const first = library.blocks.find(b => b.lib_id === matches[0].lib_id);
    const oldFetch = globalThis.fetch, oldJev = process.env.MERGE_API_KEY, oldMemory = process.env.MEMORY_LANE_API_KEY;
    process.env.MERGE_API_KEY = 'synthetic-only'; process.env.MEMORY_LANE_API_KEY = 'synthetic-only';
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.ok(body.questions, 'must not call synthesis after selected evidence changes');
      if (scenario === 'deleted') fs.unlinkSync(first.filePath);
      else if (scenario === 'changed') fs.appendFileSync(first.filePath, '\nchanged after retrieval');
      else {
        const manifestPath = path.join(root, 'MANIFEST.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.blocks.find(entry => entry.lib_id === first.lib_id).source_ref = 'changed synthetic source';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      return {ok: true, json: async () => ({ answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, {score: 2}])) })};
    };
    try {
      const result = await answerQuestion(library, 'uniqueword');
      assert.equal(result.mode, 'none', scenario);
      assert.match(result.answer, /Memory changed/, scenario);
      assert.equal(result.reason, 'source_changed', scenario);
      assert.deepEqual(result.evidence, [], scenario);
      assert.equal(result.cost, null, scenario);
      assert.equal(calls, 1, scenario);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
      if (oldMemory === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldMemory;
    }
  }
});

test('changed candidates are not used as evidence after ranking', async t => {
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
  assert.equal(answer.mode, 'none');
  assert.match(answer.answer, /Memory changed/);
  assert.deepEqual(answer.evidence, []);
  assert.equal(answer.source, undefined);
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
