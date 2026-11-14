import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search, searchAsync } from '../lib/memoryLaneCore.js';

function library(t, bodies) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-reasons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const [i, body] of bodies.entries()) appendBlock(root, { title: `Synthetic ${i}`, body, lineage: `fixture-${i}` });
  return loadLibrary(root);
}
function withoutReasons(result) {
  return { ...result, matches: result.matches.map(row => { const copy = { ...row }; delete copy.retrieval_reasons; return copy; }) };
}

test('opt-in reasons label actual graph grouping and suggestions without changing results', async t => {
  const lib = library(t, ['Alex leased a Honda Civic and loves hiking.', 'Alex also owns a kayak for lake trips.', 'Unrelated quantum physics.']);
  const baseline = search(lib, 'hiking', { limit: 3 });
  for (const result of [search(lib, 'hiking', { limit: 3, explain: true }), await searchAsync(lib, 'hiking', { limit: 3, explain: true })]) {
    assert.deepEqual(withoutReasons(result), baseline);
    assert.ok(result.matches[0].retrieval_reasons.includes('fts'));
    assert.ok(result.matches[0].retrieval_reasons.includes('graph_cross_boost_group'));
    const graphOnly = result.matches.find(row => row.via === 'graph');
    assert.ok(graphOnly); assert.deepEqual(graphOnly.retrieval_reasons, ['graph_suggestion']);
  }
  assert.ok(baseline.matches.every(row => !Object.hasOwn(row, 'retrieval_reasons')));
  assert.ok(search(lib, 'hiking', { explain: 'true' }).matches.every(row => !Object.hasOwn(row, 'retrieval_reasons')));
});

test('substring fallback and opt-in infix are distinguished from FTS', async t => {
  const lib = library(t, ['ear', 'banana', 'dayhiking notebook']);
  for (const result of [search(lib, 'hiking', { infix: true, explain: true }), await searchAsync(lib, 'hiking', { infix: true, explain: true })]) {
    assert.ok(result.matches.some(row => row.retrieval_reasons.includes('substring')));
    assert.deepEqual(withoutReasons(result), search(lib, 'hiking', { infix: true }));
  }
});

test('scoped library cannot add explanations for excluded records', t => {
  const lib = library(t, ['Alex loves hiking.', 'Alex owns a private kayak.']);
  const allowed = lib.blocks.filter(row => row.lib_id === 1);
  const scoped = { ...lib, blocks: allowed, manifest: { ...lib.manifest, blocks: allowed }, totalBlocks: allowed.length };
  const result = search(scoped, 'hiking', { limit: 5, explain: true });
  assert.ok(result.matches.length > 0); assert.ok(result.matches.every(row => row.lib_id === 1));
  assert.ok(!JSON.stringify(result).includes('private kayak'));
});

test('changed source invalidates prior search evidence and creates fresh reasons', t => {
  const lib = library(t, ['Alex loves hiking.']);
  const first = search(lib, 'hiking', { explain: true }); assert.equal(first.count, 1);
  fs.writeFileSync(lib.blocks[0].filePath, 'Alex loves sailing.');
  assert.equal(search(lib, 'hiking', { explain: true }).count, 0);
  const second = search(lib, 'sailing', { explain: true }); assert.equal(second.count, 1);
  assert.notEqual(second.matches[0].manifest_hash_status, 'match');
});
