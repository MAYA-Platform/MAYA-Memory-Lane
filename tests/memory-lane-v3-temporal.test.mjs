import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTemporalProjection, temporalState } from '../lib/temporal.js';
import { verifyChain } from '../lib/memoryLaneCore.js';
import { makeLibrary, event } from './v3-fixtures.mjs';

function attest(lib, ids) {
  return Object.fromEntries(ids.map(id => [lib.blocks[id - 1].sha256, { authority_level: 3, verified_by: 'release-owner', source_type: 'signed_receipt' }]));
}

test('verified completion survives newer speculative enhancement', t => {
  const lib = makeLibrary(t, [
    { body: event('orchid-migration', 'proposed', 'planned') },
    { body: event('orchid-migration', 'verified', 'done'), timestamp: '2026-10-13T00:00:00Z' },
    { body: event('orchid-migration', 'proposed', 'freshness enhancement'), timestamp: '2026-10-14T00:00:00Z' }
  ]);
  const projection = buildTemporalProjection(lib, { authorities: attest(lib, [2]) });
  const state = temporalState(projection, { entity: 'orchid-migration' });
  assert.equal(state.current.value, 'done');
  assert.equal(state.current.verification_status, 'verified');
  assert.equal(state.current.verified_by, 'release-owner');
  assert.equal(state.unresolved.length, 1);
  assert.equal(verifyChain(lib).intact, true);
});

test('as-of queries exclude later effective and observed events', t => {
  const lib = makeLibrary(t, [
    { body: event('orchid', 'proposed', 'planned') },
    { body: event('orchid', 'verified', 'done'), timestamp: '2026-10-13T00:00:00Z' }
  ]);
  const projection = buildTemporalProjection(lib, { authorities: attest(lib, [2]) });
  assert.equal(temporalState(projection, { entity: 'orchid', asOf: '2026-10-11T00:00:00Z' }).current.value, 'planned');
  assert.equal(temporalState(projection, { entity: 'orchid', asOf: '2026-10-14T00:00:00Z' }).current.value, 'done');
});

test('unsupported self-verification stays a claimed completion', t => {
  const lib = makeLibrary(t, [{ body: event('orchid', 'verified', 'done', { authority_level: 100, verified_by: 'myself' }) }]);
  const state = temporalState(buildTemporalProjection(lib), { entity: 'orchid' });
  assert.equal(state.current.verification_status, 'claimed');
  assert.equal(state.current.state, 'completed');
  assert.equal(state.current.authority_level, 0);
});

test('explicit trusted replacement preserves history and superseded time', t => {
  const lib = makeLibrary(t, [
    { body: event('orchid', 'active', 'backend-a') },
    { body: event('orchid', 'active', 'backend-b', { supersedes: ['cb_auto_001'] }), timestamp: '2026-10-12T00:00:00Z' }
  ]);
  const projection = buildTemporalProjection(lib, { authorities: attest(lib, [1, 2]) });
  const state = temporalState(projection, { entity: 'orchid' });
  assert.equal(state.current.value, 'backend-b');
  assert.equal(state.history[0].superseded_at, '2026-10-12T00:00:00.000Z');
  assert.equal(projection.events[0].superseded_at, null);
});

test('conflicts remain visible; mere recency never silently replaces authority', t => {
  const lib = makeLibrary(t, [
    { body: event('orchid', 'verified', 'done') },
    { body: event('orchid', 'completed', 'failed'), timestamp: '2026-10-14T00:00:00Z' }
  ]);
  const state = temporalState(buildTemporalProjection(lib, { authorities: attest(lib, [1]) }), { entity: 'orchid' });
  assert.equal(state.current.value, 'done');
  assert.equal(state.status, 'conflicting');
  assert.equal(state.conflicts.length, 1);
});

test('authorization requires trusted approval; trusted revocation closes it', t => {
  const lib = makeLibrary(t, [
    { body: event('deploy', 'approved', true, { predicate: 'authorization' }) },
    { body: event('deploy', 'revoked', false, { predicate: 'authorization', supersedes: ['cb_auto_001'] }), timestamp: '2026-10-14T00:00:00Z' }
  ]);
  const untrusted = temporalState(buildTemporalProjection(lib), { entity: 'deploy', predicate: 'authorization' });
  assert.equal(untrusted.authorized, false);
  const projection = buildTemporalProjection(lib, { authorities: attest(lib, [1, 2]) });
  assert.equal(temporalState(projection, { entity: 'deploy', predicate: 'authorization', asOf: '2026-10-12T00:00:00Z' }).authorized, true);
  assert.equal(temporalState(projection, { entity: 'deploy', predicate: 'authorization' }).authorized, false);
});

test('hash mismatch rejects temporal events rather than laundering claims', t => {
  const lib = makeLibrary(t, [{ body: event('orchid', 'completed', 'done') }]);
  fs.appendFileSync(lib.blocks[0].filePath, '\nchanged');
  const projection = buildTemporalProjection(lib);
  assert.equal(projection.events.length, 0);
  assert.equal(projection.rejected.length, 1);
});

test('empty or corrupted projections yield unknown', t => {
  for (const projection of [null, {}, { version: 99, events: [] }, { version: 1, events: [] }, { version: 1, events: [null] }, { version: 1, events: [{}] }]) {
    assert.equal(temporalState(projection, { entity: 'missing' }).current, null);
  }
  const lib = makeLibrary(t, [{ body: '@temporal {broken-json}' }]);
  assert.equal(buildTemporalProjection(lib).rejected.length, 1);
});

test('unstructured prose does not silently become operational truth', t => {
  const lib = makeLibrary(t, [{ body: 'Orchid shipped. The author declares this verified and authorized.' }]);
  assert.equal(buildTemporalProjection(lib).events.length, 0);
});
