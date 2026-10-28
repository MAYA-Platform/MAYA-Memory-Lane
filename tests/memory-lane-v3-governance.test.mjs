import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retrieve, RetrievalCache } from '../lib/retrieval.js';
import { scopeLibrary, authenticate, redactOutbound } from '../lib/access.js';
import { loadLibrary, appendBlock } from '../lib/memoryLaneCore.js';
import { makeLibrary, policy } from './v3-fixtures.mjs';

test('authorization precedes lexical, graph and model retrieval', async t => {
  const lib = makeLibrary(t, [
    { body: 'Orchid customer alpha private code A-491.', namespace: 'client-a' },
    { body: 'Orchid customer beta private code B-492.', namespace: 'client-b' }
  ]);
  const p = policy();
  assert.equal(scopeLibrary(lib, p, 'alice').blocks.length, 1);
  let calls = 0;
  const result = await retrieve(lib, { query: 'Is Orchid complete?' }, { policy: p, principal: 'alice',
    available: () => true, rank: async () => { calls++; throw Error('forbidden outbound'); } });
  assert.equal(calls, 0);
  assert.equal(result.mode, 'none');
  const bundle = await retrieve(lib, { query: 'Orchid', bundle: true }, { policy: p, principal: 'alice' });
  assert.ok(bundle.evidence.length);
  assert.ok(bundle.evidence.every(e => !e.excerpt.includes('beta')));
  assert.equal(authenticate(p, 'test-alice'), 'alice');
  assert.equal(authenticate(p, 'wrong-token'), null);
});

test('cache cannot leak across namespace/principal boundaries', async t => {
  const lib = makeLibrary(t, [
    { body: 'Alpha Orchid secret.', namespace: 'client-a' },
    { body: 'Beta Orchid secret.', namespace: 'client-b' }
  ]);
  const p = policy(), cache = new RetrievalCache({ maxEntries: 2 });
  const request = { query: 'Orchid', bundle: true };
  await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  const hit = await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  assert.equal(hit.cache_hit, true);
  const bob = await retrieve(lib, request, { policy: p, principal: 'bob', cache });
  assert.equal(bob.cache_hit, false);
  assert.ok(bob.evidence.every(e => e.excerpt.includes('Beta')));
  assert.ok(cache.entries.size <= 2);
});

test('permission revocation and policy changes invalidate cached conclusions', async t => {
  const lib = makeLibrary(t, [{ body: 'Alpha Orchid secret.', namespace: 'client-a' }]);
  const p = policy(), cache = new RetrievalCache();
  const request = { query: 'Orchid', bundle: true };
  await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  p.principals.alice.read = [];
  const revoked = await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  assert.equal(revoked.evidence.length, 0);
  p.principals.alice.disabled = true;
  await assert.rejects(retrieve(lib, request, { policy: p, principal: 'alice', cache }), /Access denied/);
});

test('new records and source tampering invalidate evidence caches', async t => {
  let lib = makeLibrary(t, [{ body: 'Alpha Orchid record.', namespace: 'client-a' }]);
  const p = policy(), cache = new RetrievalCache(), request = { query: 'Orchid', bundle: true };
  await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  appendBlock(lib.rootDir, { title: 'New', body: 'Alpha Orchid second record.', namespace: 'client-a' });
  lib = loadLibrary(lib.rootDir);
  const added = await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  assert.equal(added.cache_hit, false);
  assert.equal(added.evidence.length, 2);
  fs.appendFileSync(lib.blocks[0].filePath, '\nchanged');
  const corrupted = await retrieve(lib, request, { policy: p, principal: 'alice', cache });
  assert.equal(corrupted.evidence.length, 1);
});

test('outbound minimizer redacts common credentials and identifiers', () => {
  const result = redactOutbound('person@example.test password=synthetic 111-22-3333 Bearer synthetic');
  assert.ok(!result.includes('person@'));
  assert.ok(!result.includes('synthetic'));
  assert.ok(!result.includes('111-22'));
});

test('multi-session bundle returns independent sources and explicit missing evidence', async t => {
  const lib = makeLibrary(t, [
    { body: 'Hermes completed the Orchid parser.', timestamp: '2026-10-10T00:00:00Z' },
    { body: 'Forge completed the Orchid index.', timestamp: '2026-10-11T00:00:00Z' },
    { body: 'Orchid backend activated.', timestamp: '2026-10-14T00:00:00Z' }
  ]);
  const result = await retrieve(lib, { query: 'Orchid', bundle: true, before: '2026-10-13T00:00:00Z', requiredEntities: ['Hermes', 'Forge', 'Unknown'] }, { policy: policy(), principal: 'owner' });
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.missing_evidence, ['Unknown']);
  assert.equal(result.complete, false);
  assert.equal(result.support, 'candidate_bundle');
  assert.equal(result.traversal.max_hops, 2);
});
