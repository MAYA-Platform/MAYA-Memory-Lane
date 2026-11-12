import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceBundle, retrieve } from '../lib/retrieval.js';
import { makeLibrary, policy } from './v3-fixtures.mjs';

test('before filtering can recover an older record beyond the output limit', t => {
  const lib = makeLibrary(t, [
    { body: 'Orchid project decision', timestamp: '2026-06-01T00:00:00Z' },
    { body: 'Orchid project decision', timestamp: '2025-06-01T00:00:00Z' }
  ]);
  const result = evidenceBundle(lib, 'Orchid', { limit: 1, before: '2026-01-01T00:00:00Z' });
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0].observed_at, /^2025-/);
  assert.equal(result.complete, false);
  assert.equal(result.traversal.candidate_limit_per_lane, 5);
  assert.equal(result.traversal.temporal_coverage, 'bounded-candidates-not-exhaustive');
});

test('an exhausted time-filter candidate window is explicitly non-exhaustive', t => {
  const records = Array.from({ length: 5 }, (_, i) => ({
    body: `Orchid Orchid Orchid Orchid recent record ${i}`, timestamp: '2026-06-01T00:00:00Z'
  }));
  records.push({ body: 'Orchid old record', timestamp: '2025-06-01T00:00:00Z' });
  const result = evidenceBundle(makeLibrary(t, records), 'Orchid', { limit: 1, before: '2026-01-01T00:00:00Z' });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.traversal.temporal_coverage, 'bounded-candidates-not-exhaustive');
});

test('scoped temporal bundle excludes other namespaces and reports partial coverage', async t => {
  const lib = makeLibrary(t, [
    { body: 'Orchid allowed record', namespace: 'client-a', timestamp: '2025-01-01T00:00:00Z' },
    { body: 'Orchid other client record', namespace: 'client-b', timestamp: '2025-01-01T00:00:00Z' }
  ]);
  const result = await retrieve(lib, { query: 'Orchid', bundle: true, before: '2026-01-01T00:00:00Z' },
    { policy: policy(), principal: 'alice' });
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0].excerpt, /allowed/);
  assert.equal(result.complete, false);
  assert.equal(result.traversal.temporal_coverage, 'bounded-candidates-not-exhaustive');
});

test('non-temporal bundles retain their existing shape and completion semantics', t => {
  const lib = makeLibrary(t, [{ body: 'Orchid release record', timestamp: '2025-01-01T00:00:00Z' }]);
  const result = evidenceBundle(lib, 'Orchid', { limit: 1, requiredEntities: ['Orchid'] });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.complete, true);
  assert.equal(Object.hasOwn(result.traversal, 'temporal_coverage'), false);
});
