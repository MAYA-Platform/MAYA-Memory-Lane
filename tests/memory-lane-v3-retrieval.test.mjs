import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, readBlock, search } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';
import { jevRank, expandCandidates } from '../lib/jevrank.js';

function fixture(t, bodies) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const [i, body] of bodies.entries()) appendBlock(root, { title: `Record ${i}`, body, lineage: 'project-lane' });
  return loadLibrary(root);
}
function rankScores(scores) {
  return async (_lib, _q, matches) => ({ matches: matches.map((m, i) => ({ ...m, jev_score: scores[i] ?? 0 })),
    jev: { applied: true, usage: { cost: 0.001 }, model: 'fixture' } });
}

test('literal fast path makes zero paid requests even with multiple candidates', async t => {
  const lib = fixture(t, ['Alex leased a Honda Civic in black.', 'Alex enjoys Honda motorcycles.']);
  let calls = 0;
  const key = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'offline-test';
  t.after(() => { if (key === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = key; });
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected outbound'); });
  const r = await answerQuestion(lib, 'Honda Civic');
  assert.equal(r.mode, 'direct');
  assert.equal(calls, 0);
  assert.equal(r.cost, 0);
});

test('paraphrase qualifies from typed support without all literal query words', async t => {
  const lib = fixture(t, ['Memory Lane Jev-only migration shipped. Production service verified.']);
  const r = await answerQuestion(lib, 'Did we finish the Memory Lane upgrade?', { available: () => true, rank: rankScores([2]) });
  assert.equal(r.mode, 'jev');
  assert.match(r.answer, /migration shipped/);
  assert.equal(r.cost, 0.001);
});

test('term overlap alone never answers a natural-language completion question', async t => {
  const lib = fixture(t, ['Did we finish the Memory Lane upgrade? This is an unanswered question.']);
  const r = await answerQuestion(lib, 'Did we finish the Memory Lane upgrade?', { available: () => false });
  assert.equal(r.mode, 'none');
});

for (const score of [0, 1, 1.5, 1.99, NaN, 3]) {
  test(`support calibration: non-category score ${score} abstains`, async t => {
    const lib = fixture(t, ['Memory Lane migration might be interesting.']);
    const r = await answerQuestion(lib, 'Is the Memory Lane upgrade complete?', { available: () => true, rank: rankScores([score]) });
    assert.equal(r.mode, 'none');
  });
}

test('buried answer has exact hash and reproducible offsets', async t => {
  const lib = fixture(t, ['Unrelated opening sentence. '.repeat(150) + '\nOrchid ticket ZX-582 was approved by the release owner.']);
  const r = await answerQuestion(lib, 'ZX-582');
  assert.equal(r.mode, 'direct');
  assert.match(r.answer, /approved/);
  const block = readBlock(lib, 1);
  assert.ok(r.evidence[0].spans[0].start > 1000);
  for (const s of r.evidence[0].spans) {
    assert.equal(block.raw.slice(s.start, s.end), s.text);
    assert.equal(s.source_hash, block.sha256);
  }
});

test('conflicting sources abstain and retain evidence', async t => {
  const lib = fixture(t, ['Orchid upgrade completed and verified.', 'Orchid upgrade failed and is incomplete.']);
  const r = await answerQuestion(lib, 'Is Orchid complete?', { available: () => true, rank: rankScores([2, 2]) });
  assert.equal(r.mode, 'none');
  assert.equal(r.evidence.length, 2);
});

test('source hash mismatch is excluded before ranking', async t => {
  const lib = fixture(t, ['Orchid launch key ABC-829.']);
  fs.appendFileSync(lib.blocks[0].filePath, '\nunauthorized mutation');
  const r = await answerQuestion(lib, 'ABC-829');
  assert.equal(r.mode, 'none');
  assert.equal(r.evidence.length, 0);
});

test('lineage promotion retains retrievable identity outside lexical pool', async t => {
  const lib = fixture(t, ['Orchid planned work.', 'Orchid proposed work.', 'Orchid migration shipped and verified.']);
  const matches = search(lib, 'Orchid').matches.filter(m => m.lib_id !== 3);
  const expansion = expandCandidates(lib, 'Orchid', matches);
  assert.equal(expansion[0].lib_id, 3);
  const key = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'offline-test';
  t.after(() => { if (key === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = key; });
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    const answers = Object.fromEntries(Object.keys(payload.questions).map(tag => [tag, { score: tag === 'C2' ? 2 : 1 }]));
    return { ok: true, json: async () => ({ answers }) };
  });
  const r = await jevRank(lib, 'Orchid', matches, { topN: 2 });
  assert.equal(r.matches[0].lib_id, 3);
  assert.equal(readBlock(lib, r.matches[0].lib_id).present, true);
  assert.equal(r.matches[0].lineage, 'project-lane');
  assert.equal(new Set(r.matches.map(m => m.block_id)).size, r.matches.length);
});

for (const reason of ['unavailable', 'timeout']) {
  test(`Jev ${reason} abstains without losing search`, async t => {
    const lib = fixture(t, ['Orchid migration is proposed.']);
    const r = await answerQuestion(lib, 'Is Orchid complete?', { available: () => true,
      rank: async (_l, _q, matches) => ({ matches, jev: { applied: false, reason } }) });
    assert.equal(r.mode, 'none');
    assert.ok(search(lib, 'Orchid').count);
  });
}
