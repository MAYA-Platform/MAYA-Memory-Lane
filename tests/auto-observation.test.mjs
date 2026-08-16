import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { observeMessage, readObservations, observationStats, searchObservations } = await import('../lib/observations.js');
const { buildSnapshot, injectForSession } = await import('../lib/injector.js');

function makeLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-obs-test-'));
  fs.mkdirSync(path.join(dir, 'shelves', 'shelf-001'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ version: 'test', total_blocks: 0, blocks: [] }));
  return { rootDir: dir, ok: true, blocks: [] };
}

test('observer captures decisions with high confidence', () => {
  const lib = makeLib();
  const obs = observeMessage(lib, {
    speaker: 'user',
    content: "let's go with the vertex embeddings, that's the plan",
    session_id: 's1',
  });
  assert.ok(obs, 'should capture');
  assert.equal(obs.cls, 'decision');
  assert.equal(obs.confidence, 'high');
});

test('observer captures boundaries', () => {
  const lib = makeLib();
  const obs = observeMessage(lib, {
    speaker: 'user',
    content: "don't ever touch the secure folder without asking me",
    session_id: 's2',
  });
  assert.ok(obs);
  assert.equal(obs.cls, 'boundary');
});

test('observer captures corrections', () => {
  const lib = makeLib();
  const obs = observeMessage(lib, {
    speaker: 'user',
    content: "no, that's wrong — do it like this instead",
    session_id: 's3',
  });
  assert.ok(obs);
  assert.equal(obs.cls, 'correction');
});

test('observer ignores filler (no durable signal)', () => {
  const lib = makeLib();
  const obs = observeMessage(lib, { speaker: 'user', content: 'ok sounds good, thanks!', session_id: 's4' });
  assert.equal(obs, null);
});

test('observer marks state signals ephemeral', () => {
  const lib = makeLib();
  const obs = observeMessage(lib, { speaker: 'user', content: "i'm tired today", session_id: 's5' });
  assert.ok(obs);
  assert.equal(obs.ephemeral, true);
});

test('append dedups the same observation re-captured', () => {
  const lib = makeLib();
  observeMessage(lib, { speaker: 'user', content: 'i prefer the dark theme always', session_id: 's6' });
  observeMessage(lib, { speaker: 'user', content: 'i prefer the dark theme always', session_id: 's6' });
  const all = readObservations(lib);
  const pref = all.filter((o) => o.cls === 'preference');
  assert.equal(pref.length, 1);
});

test('injector returns a compact snapshot within budget', () => {
  const lib = makeLib();
  for (let i = 0; i < 20; i++) {
    observeMessage(lib, { speaker: 'user', content: `decision number ${i}: we're going with option ${i}`, session_id: `sd${i}` });
  }
  const { snapshot, charCount } = buildSnapshot(lib, { budget: 500 });
  assert.ok(snapshot.includes('SESSION SNAPSHOT'));
  assert.ok(charCount <= 500 + 2000, `charCount ${charCount} within budget slack`);
});

test('injector topical boost surfaces topic-matching observations', () => {
  const lib = makeLib();
  observeMessage(lib, { speaker: 'user', content: "we're going with the car GPS tracker install", session_id: 't1' });
  observeMessage(lib, { speaker: 'user', content: "let's use the kitchen reno plan", session_id: 't2' });
  const { snapshot } = buildSnapshot(lib, { topics: ['car'], budget: 2000 });
  assert.ok(snapshot.toLowerCase().includes('car'), 'car topic surfaced');
});

test('injectForSession matches the hosted-service contract shape', () => {
  const lib = makeLib();
  observeMessage(lib, { speaker: 'user', content: 'i am the founder of a startup', session_id: 'i1' });
  const injected = injectForSession(lib);
  assert.ok(typeof injected === 'string');
  assert.ok(injected.includes('SESSION SNAPSHOT'));
  assert.ok(injected.length < 4000);
});

test('observationStats counts by class', () => {
  const lib = makeLib();
  observeMessage(lib, { speaker: 'user', content: "we're going with X", session_id: 'a' });
  observeMessage(lib, { speaker: 'user', content: "don't touch that", session_id: 'b' });
  const stats = observationStats(lib);
  assert.equal(stats.total, 2);
  assert.equal(stats.byClass.decision, 1);
  assert.equal(stats.byClass.boundary, 1);
});

test('searchObservations finds by excerpt term', () => {
  const lib = makeLib();
  observeMessage(lib, { speaker: 'user', content: "my car GPS issue in March was fixed today", session_id: 'g1' });
  const hits = searchObservations(lib, 'car gps');
  assert.ok(hits.length >= 1);
});
