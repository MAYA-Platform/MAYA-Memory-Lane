import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { candidatePage } from '../lib/extraction-pages.js';
import { candidateFacts } from '../lib/extract.js';
import { enrichBlock } from '../lib/enrichment.js';
import { FreshnessAnchors } from '../lib/freshness.js';
import { loadLibrary, readBlock, verifyChain, appendBlock } from '../lib/memoryLaneCore.js';
import { makeLibrary, policy } from './v3-fixtures.mjs';

function tracker(t, lib, p, opts = {}) {
  const anchors = new FreshnessAnchors({ root: lib.rootDir, namespace: 'founder', principal: 'owner', getPolicy: () => p, ...opts });
  t.after(() => anchors.close());
  return anchors;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('section paging covers every candidate, retains spans and removes duplicates', () => {
  const text = '# First\n' + Array.from({ length: 42 }, (_, i) => `Orchid release item ${i} completed on 2026-10-13.`).join('\n') + '\n# Last\nFinal tail milestone was verified.\nFinal tail milestone was verified.';
  const all = [];
  let cursor = 0;
  do { const page = candidatePage(text, { cursor, limit: 7 }); all.push(...page.candidates); cursor = page.next_cursor; } while (cursor !== null);
  assert.equal(all.length, 43);
  assert.equal(all.at(-1).section, 'Last');
  assert.ok(all.some(c => c.dates.includes('2026-10-13')));
  for (const c of all) assert.equal(text.slice(c.start, c.end), c.text);
  assert.ok(candidateFacts(text).at(-1).includes('Final tail'));
});

test('long sentences survive bounded chunking instead of being dropped', () => {
  const text = 'Orchid release scope ' + 'contains detailed operational context '.repeat(60);
  const page = candidatePage(text, { limit: 100 });
  assert.ok(page.candidates.length > 1);
  assert.ok(page.candidates.every(c => c.text.length <= 400));
  for (const c of page.candidates) assert.equal(text.slice(c.start, c.end), c.text);
});

test('backfill dry run incurs zero calls and does not change canonical bytes', async t => {
  const lib = makeLibrary(t, [{ body: 'Orchid release candidate was completed.' }]);
  let calls = 0;
  const before = fs.readFileSync(lib.blocks[0].filePath, 'utf8');
  const plan = await enrichBlock(lib, 1, { policy: policy(), principal: 'owner', score: async () => { calls++; } });
  assert.equal(plan.dry_run, true);
  assert.equal(calls, 0);
  assert.ok(plan.estimated_cost_usd > 0);
  assert.equal(fs.readFileSync(lib.blocks[0].filePath, 'utf8'), before);
});

test('enrichment resumes exactly at failed batch without duplicated source spans', async t => {
  const lib = makeLibrary(t, [{ body: Array.from({ length: 70 }, (_, i) => `Orchid task ${i} finished successfully.`).join('\n') }]);
  const p = policy(); p.namespaces.founder.externalJev = true;
  let calls = 0;
  const score = async (_context, candidates) => {
    calls++;
    if (calls === 2) return { ok: false, reason: 'fixture timeout', scores: new Map() };
    return { ok: true, scores: new Map(candidates.map((_c, i) => [String(i), 2])) };
  };
  const first = await enrichBlock(lib, 1, { policy: p, principal: 'owner', execute: true, maxBatches: 3, score });
  assert.equal(first.interrupted, true);
  assert.equal(first.cursor, 30);
  const second = await enrichBlock(lib, 1, { policy: p, principal: 'owner', execute: true, maxBatches: 3, checkpoint: first, score });
  assert.equal(second.cursor, null);
  assert.equal(new Set(second.facts.map(f => f.fact_id)).size, second.facts.length);
  assert.ok(second.facts.length >= 70);
  assert.equal(verifyChain(lib).intact, true);
});

test('nonblocking open, five-hour wake, close relationship and retry dedup', async t => {
  const lib = makeLibrary(t), p = policy(), anchors = tracker(t, lib, p);
  const message = { sessionId: 'session-one', timestamp: '2026-10-16T00:00:00Z', runtime: 'test', sketch: 'email person@example.test password=synthetic' };
  assert.equal(anchors.observe(message).queued, true);
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 0);
  await tick(); await tick();
  anchors.flush();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  anchors.observe(message); await tick(); await tick();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  // Replaying a durable pending retry must return the original sealed source hash.
  const block = readBlock(loadLibrary(lib.rootDir), 1);
  const anchor = JSON.parse(/^@anchor (.+)$/m.exec(block.raw)[1]);
  anchors.queue.push({ anchor, attempts: 0 }); anchors.flush();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  anchors.accept({ sessionId: 'session-one', timestamp: '2026-10-16T04:59:59Z' }); anchors.flush();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  anchors.accept({ sessionId: 'session-one', timestamp: '2026-10-16T09:59:59Z' }); anchors.flush();
  const wake = readBlock(loadLibrary(lib.rootDir), 2);
  assert.equal(wake.fields.anchor_type, 'WAKE');
  assert.ok(wake.body.includes('18000000'));
  const closed = appendBlock(lib.rootDir, { title: 'Closeout', body: 'Orchid session tasks completed.', namespace: 'founder' });
  anchors.accept({ sessionId: 'session-one', timestamp: '2026-10-16T10:00:00Z', closeBlockId: closed.block_id }); anchors.flush();
  const library = loadLibrary(lib.rootDir);
  assert.equal(library.blocks.length, 4);
  assert.equal(verifyChain(library).intact, true);
  assert.ok(!block.body.includes('person@'));
  assert.ok(!block.body.includes('password='));
  const close = JSON.parse(/^@anchor (.+)$/m.exec(readBlock(library, 4).raw)[1]);
  assert.equal(close.open_id, anchor.anchor_id);
});

test('session activity survives restart without a false wake', t => {
  const lib = makeLibrary(t), p = policy(), one = tracker(t, lib, p);
  one.accept({ sessionId: 's', timestamp: '2026-10-16T00:00:00Z' }); one.flush();
  one.accept({ sessionId: 's', timestamp: '2026-10-16T04:00:00Z' }); one.close();
  const two = tracker(t, lib, p);
  two.accept({ sessionId: 's', timestamp: '2026-10-16T06:00:00Z' }); two.flush();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
});

test('revoked anchor permission fails closed and writes a failure receipt', t => {
  const lib = makeLibrary(t), p = policy(), anchors = tracker(t, lib, p, { maxAttempts: 1 });
  anchors.accept({ sessionId: 's', timestamp: '2026-10-16T00:00:00Z' });
  p.principals.owner.write = [];
  anchors.flush();
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 0);
  assert.ok(fs.readFileSync(path.join(lib.rootDir, 'health', 'v3-audit.jsonl'), 'utf8').includes('anchor_failed'));
  assert.equal(anchors.queue.length, 0);
});

test('competing writers fail safely without overwriting a sealed chain', t => {
  const lib = makeLibrary(t, [{ body: 'Orchid original source.' }]);
  const lock = path.join(lib.rootDir, '.append.lock');
  fs.writeFileSync(lock, '');
  const denied = appendBlock(lib.rootDir, { title: 'Competing', body: 'Must not overwrite.' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'writer_busy');
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  fs.unlinkSync(lock);
  assert.equal(appendBlock(lib.rootDir, { title: 'Serialized', body: 'Appended safely.' }).ok, true);
  assert.equal(verifyChain(loadLibrary(lib.rootDir)).intact, true);
});
