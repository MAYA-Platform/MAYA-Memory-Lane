import test from 'node:test';
import assert from 'node:assert/strict';
import { jevScoreBatch, jevStats } from '../lib/jevrank.js';

test('attempt telemetry distinguishes unpriced requests from scored responses', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic-test-key';
  const candidates = [{ block_id: 'a', excerpt: 'one' }, { block_id: 'b', excerpt: 'two' }];
  const before = jevStats();
  try {
    assert.equal((await jevScoreBatch('q', candidates, { beforeSend: () => false })).reason, 'source_changed');
    assert.equal(jevStats().attempts, before.attempts);
    assert.equal((await jevScoreBatch('q', candidates, { onAttempt: () => { throw new Error('cancel'); } })).ok, false);
    assert.equal(jevStats().attempts, before.attempts);
    assert.equal(jevStats().unpricedAttempts, before.unpricedAttempts);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal((await jevScoreBatch('q', candidates)).reason, 'jev HTTP 503');
    let stats = jevStats();
    assert.equal(stats.attempts - before.attempts, 1);
    assert.equal(stats.attemptedQuestions - before.attemptedQuestions, 2);
    assert.equal(stats.unpricedAttempts - before.unpricedAttempts, 1);
    assert.equal(stats.calls, before.calls);
    assert.equal(stats.estimatedCostUsd, before.estimatedCostUsd);
    assert.match(stats.costScope, /not a provider billing receipt/);

    for (const response of [
      () => { throw new Error('network'); },
      () => ({ ok: true, json: async () => { throw new Error('invalid'); } }),
      () => ({ ok: true, json: async () => ({}) }),
      () => ({ ok: true, json: async () => ({ answers: {} }) })
    ]) {
      globalThis.fetch = async () => response();
      assert.equal((await jevScoreBatch('q', candidates)).ok, false);
    }
    stats = jevStats();
    assert.equal(stats.attempts - before.attempts, 5);
    assert.equal(stats.unpricedAttempts - before.unpricedAttempts, 5);
    assert.equal(stats.estimatedCostUsd, before.estimatedCostUsd);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { C0: { score: 1 }, C1: { score: 2 } }, usage: { cost: 0.01 } }) });
    assert.equal((await jevScoreBatch('q', candidates)).ok, true);
    stats = jevStats();
    assert.equal(stats.attempts - before.attempts, 6);
    assert.equal(stats.attemptedQuestions - before.attemptedQuestions, 12);
    assert.equal(stats.unpricedAttempts - before.unpricedAttempts, 5);
    assert.equal(stats.calls - before.calls, 1);
    assert.equal(stats.questions - before.questions, 2);
    assert.equal(Number((stats.estimatedCostUsd - before.estimatedCostUsd).toFixed(8)), 0.01);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MERGE_API_KEY;
    else process.env.MERGE_API_KEY = previousKey;
  }
});
