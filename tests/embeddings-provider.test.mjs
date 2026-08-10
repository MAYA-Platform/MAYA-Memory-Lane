import test from 'node:test';
import assert from 'node:assert/strict';

// embeddings.js reads provider config from env at import time, so each test
// spawns a fresh import with the env it needs. We only test the parts that
// don't hit the network: provider selection, availability gating, and the
// graceful-degradation contract (returns null / empty when unavailable).

function freshImport(env) {
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
  // Cache-busting query string: ESM caches by URL, so each freshImport gets a
  // truly fresh module that captures the env it was imported under.
  const nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
  return import('../lib/embeddings.js?t=' + nonce);
}

test('default provider is local (Ollama)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  // No Ollama guaranteed in CI; the contract is graceful null, not throw.
  const v = await mod.embedText('hello world');
  // Either a vector (Ollama up) or null (Ollama down) — never a throw.
  assert.ok(v === null || v instanceof Float32Array);
});

test('vertex provider without token returns null (graceful degradation)', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: 'vertex', VERTEX_ACCESS_TOKEN: '' });
  const avail = await mod.embeddingsAvailable();
  assert.equal(avail, false);
  const v = await mod.embedText('hello world');
  assert.equal(v, null);
});

test('vertex provider with token reports available', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: 'vertex', VERTEX_ACCESS_TOKEN: 'dummy-token' });
  const avail = await mod.embeddingsAvailable();
  assert.equal(avail, true);
});

test('rrf fuses lists by reciprocal rank', async () => {
  const mod = await freshImport({ EMBED_PROVIDER: '' });
  const fused = mod.rrf([[1, 2, 3], [3, 4, 5]], { k: 60 });
  assert.equal(fused[0].lib_id, 3); // rank 2 in list A, rank 1 in list B
});
