import test from 'node:test';
import assert from 'node:assert/strict';

// embeddings.js v4 (2026-10-13): the dense-embedding lane is OFF by company
// rule (no local models on the PC, Vertex/Gemini retired). The contract the
// rest of the codebase relies on is the no-provider degradation path:
// available=false, null vectors, lexical-only search. freshImport is kept
// so the cache-busting import trick the rest of the suite knows still works.

function freshImport(env) {
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
  // Cache-busting query string: ESM caches by URL, so each freshImport gets a
  // truly fresh module that captures the env it was imported under.
  const nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
  return import('../lib/embeddings.js?t=' + nonce);
}

test('provider is "none" by company rule (no local models, no vertex)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  assert.equal(mod.EMBED_PROVIDER, 'none');
});

test('embedText returns null (no provider, graceful degradation)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  const v = await mod.embedText('hello world');
  assert.equal(v, null);
});

test('embeddingsAvailable is false (dense lane retired)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: 'vertex', VERTEX_ACCESS_TOKEN: 'dummy-token' });
  // Even with a token present, the lane is off by company rule.
  const avail = await mod.embeddingsAvailable();
  assert.equal(avail, false);
});

test('buildDenseIndex returns null and denseSearch passes lexical order through', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  assert.equal(await mod.buildDenseIndex({ blocks: [] }, { verbose: false }), null);
  const matches = [{ lib_id: 1 }, { lib_id: 2 }];
  assert.deepEqual(mod.denseSearch({}, 'q', matches), matches);
});

test('rrf fuses lists by reciprocal rank (pure math helper kept for harnesses)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  const fused = mod.rrf([[1, 2, 3], [3, 4, 5]], 60);
  assert.equal(fused[0], 3); // rank 2 in list A, rank 1 in list B
});
