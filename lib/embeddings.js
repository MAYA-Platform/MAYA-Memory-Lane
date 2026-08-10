#!/usr/bin/env node
/**
 * U4 (2026-08-04): Dense embedding index for Memory Lane.
 *
 * Optional embedding support with two providers, selected by EMBED_PROVIDER:
 *   - "local"  (default): Ollama bge-m3 (or EMBED_MODEL), zero-cost, local-first
 *   - "vertex": Vertex AI text-embedding-004 via REST, using a Bearer token
 *               passed in VERTEX_ACCESS_TOKEN (the caller's responsibility to
 *               fetch — e.g. `gcloud auth print-access-token`). Hosted lane for
 *               users without a local model; still zero recurring cost when
 *               riding GCP free tier / welcome credit.
 *
 * When the provider is unavailable, every function degrades gracefully
 * (returns null/empty) so the core stays zero-dependency — FTS5 remains the
 * default, dense is an enhancement fused via RRF (U2).
 *
 * Design notes:
 * - Embeddings are computed per block (body + facts section) at index build.
 * - Query embedding is computed at search time.
 * - Similarity is cosine.
 * - In-memory, per-library, rebuilt on load (matches FTS_CACHE pattern).
 */

import fs from 'node:fs';
import path from 'node:path';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'local';
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || 'project-3c17b3d6-5534-4aee-80f';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_MODEL = process.env.VERTEX_MODEL || 'text-embedding-004';
const VERTEX_TOKEN = process.env.VERTEX_ACCESS_TOKEN || '';
const EMBED_CACHE = new WeakMap();

/** Test whether the active embedding provider is reachable. */
export async function embeddingsAvailable() {
  if (EMBED_PROVIDER === 'vertex') {
    return VERTEX_TOKEN.length > 0;
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('curl', ['-s', '--max-time', '5', `${OLLAMA_URL}/api/tags`], { maxBuffer: 1024 * 1024 });
    const tags = JSON.parse(stdout);
    return !!(tags.models && tags.models.length);
  } catch {
    return false;
  }
}

/**
 * Embed a single text. Uses the active provider (local Ollama or Vertex).
 * Returns Float32Array or null on failure. Vertex requests are sent in
 * batches by buildDenseIndex/embedBatch; this single-text path exists for
 * query embedding and small callers.
 */
export async function embedText(text, model = EMBED_MODEL) {
  if (EMBED_PROVIDER === 'vertex') {
    const res = await embedVertexBatch([String(text).slice(0, 8000)]);
    return res && res.length ? res[0] : null;
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  const body = JSON.stringify({ model, prompt: String(text).slice(0, 8000) });
  try {
    const { stdout } = await execFileP('curl', [
      '-s', '--max-time', '60',
      `${OLLAMA_URL}/api/embeddings`,
      '-d', body,
    ], { maxBuffer: 64 * 1024 * 1024 });
    const d = JSON.parse(stdout);
    if (!d.embedding) return null;
    return Float32Array.from(d.embedding);
  } catch {
    return null;
  }
}

/** Embed a batch of texts via Vertex AI predict endpoint. Returns [Float32Array...] or null. */
async function embedVertexBatch(texts) {
  if (!VERTEX_TOKEN) return null;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const execFileP = promisify(execFile);
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:predict`;
  // text-embedding-004 caps ~2048 tokens/instance and 20000/request:
  // truncate each input to 6000 chars and keep batches small enough that
  // token_count stays under the request limit.
  const body = JSON.stringify({
    instances: texts.map((content) => ({ content: String(content).slice(0, 6000) })),
    parameters: { dimensions: 768 },
  });
  // Windows curl mangles large -d bodies passed as argv; write to a temp file
  // and use -d @file (proven path).
  const dir = mkdtempSync(path.join(tmpdir(), 'vembed-'));
  const bodyFile = path.join(dir, 'body.json');
  writeFileSync(bodyFile, body, 'utf8');
  try {
    const { stdout } = await execFileP('curl', [
      '-s', '--max-time', '120',
      '-X', 'POST', url,
      '-H', `Authorization: Bearer ${VERTEX_TOKEN}`,
      '-H', 'Content-Type: application/json',
      '-d', `@${bodyFile}`,
    ], { maxBuffer: 64 * 1024 * 1024 });
    const d = JSON.parse(stdout);
    if (!d.predictions || !Array.isArray(d.predictions)) {
      if (process.env.VERTEX_DEBUG) console.error('[vembed] no predictions, stdout head:', stdout.slice(0, 300));
      return null;
    }
    return d.predictions.map((p) => Float32Array.from(p.embeddings.values));
  } catch (e) {
    if (process.env.VERTEX_DEBUG) console.error('[vembed] exec error:', e.message);
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Build (or fetch cached) dense index for a library.
 * Returns { embeddings: Map<lib_id, Float32Array>, model } or null when
 * the active provider is unavailable. Caches to disk
 * (.embeddings-<provider>-<model>.json) keyed by library MANIFEST sha so
 * re-runs don't re-embed everything.
 */
export async function buildDenseIndex(library, { model = EMBED_MODEL, verbose = false } = {}) {
  const cached = EMBED_CACHE.get(library);
  if (cached) return cached;

  const provider = EMBED_PROVIDER;
  const cacheModel = provider === 'vertex' ? VERTEX_MODEL : model;

  // verify provider is available
  if (provider === 'vertex') {
    if (!VERTEX_TOKEN) {
      if (verbose) console.log('[embeddings] vertex provider: no VERTEX_ACCESS_TOKEN — dense index disabled');
      return null;
    }
  } else {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileP = promisify(execFile);
    try {
      const { stdout } = await execFileP('curl', ['-s', '--max-time', '10', `${OLLAMA_URL}/api/tags`], { maxBuffer: 1024 * 1024 });
      const tags = JSON.parse(stdout);
      if (!tags.models || !tags.models.some((m) => m.name.startsWith(model))) {
        if (verbose) console.log(`[embeddings] model '${model}' not found in Ollama`);
        return null;
      }
    } catch {
      if (verbose) console.log('[embeddings] Ollama unavailable — dense index disabled');
      return null;
    }
  }

  const rootDir = library.rootDir || (library.ok && library.rootDir) || '';
  const cachePath = rootDir ? path.join(rootDir, `.embeddings-${provider}-${cacheModel}.json`) : null;

  // Disk cache check (keyed by library MANIFEST sha so stale caches are skipped)
  let cacheKey = '';
  try {
    const manifestRaw = fs.readFileSync(path.join(rootDir, 'MANIFEST.json'), 'utf8');
    const { createHash } = await import('node:crypto');
    cacheKey = createHash('sha256').update(manifestRaw).digest('hex').slice(0, 16);
  } catch {}

  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (disk.key === cacheKey && disk.model === cacheModel && disk.provider === provider) {
        const embeddings = new Map();
        for (const [k, arr] of Object.entries(disk.vectors)) embeddings.set(Number(k), Float32Array.from(arr));
        const index = { embeddings, model: cacheModel, provider };
        EMBED_CACHE.set(library, index);
        if (verbose) console.log(`[embeddings] loaded ${embeddings.size} cached vectors (${provider}:${cacheModel})`);
        return index;
      }
    } catch {}
  }

  const embeddings = new Map();
  const entries = library.blocks.filter((b) => {
    const f = b.filePath || path.join(rootDir, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
    try {
      const raw = fs.readFileSync(f, 'utf8');
      return raw.split('---').slice(2).join('---').trim().length >= 20;
    } catch {
      return false;
    }
  });

  const texts = [];
  const entryIds = [];
  for (const entry of entries) {
    const f = entry.filePath || path.join(rootDir, 'shelves', entry.shelf, `block-${String(entry.lib_id).padStart(3, '0')}.md`);
    let text = '';
    try {
      const raw = fs.readFileSync(f, 'utf8');
      text = (raw.split('---').slice(2).join('---') || raw).trim();
    } catch {
      continue;
    }
    texts.push(text);
    entryIds.push(entry.lib_id);
  }

  if (provider === 'vertex') {
    // Vertex: batch 10 texts per request (6000-char slices stay under the
    // 20000-token request cap; 50 would blow past it on full transcripts).
    const BATCH = 10;
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const start = cursor;
        cursor += BATCH;
        const slice = texts.slice(start, start + BATCH);
        const ids = entryIds.slice(start, start + BATCH);
        const vecs = await embedVertexBatch(slice);
        if (vecs) {
          for (let i = 0; i < ids.length; i++) {
            if (vecs[i]) embeddings.set(ids[i], vecs[i]);
          }
        }
        if (verbose && embeddings.size % 200 === 0) console.log(`[embeddings] ${embeddings.size}/${entries.length}...`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } else {
    // Ollama: parallel single embeddings (existing behavior).
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const entryId = entryIds[cursor++];
        const vec = await embedText(texts[cursor - 1], model);
        if (vec) embeddings.set(entryId, vec);
        if (verbose && embeddings.size % 100 === 0) console.log(`[embeddings] ${embeddings.size}/${entries.length}...`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  // write disk cache
  if (cachePath && cacheKey) {
    try {
      const vectors = {};
      for (const [k, v] of embeddings) vectors[k] = Array.from(v);
      fs.writeFileSync(cachePath, JSON.stringify({ key: cacheKey, model: cacheModel, provider, vectors }), 'utf8');
      if (verbose) console.log(`[embeddings] cached ${embeddings.size} vectors to ${cachePath}`);
    } catch (e) {
      if (verbose) console.log('[embeddings] cache write failed:', e.message);
    }
  }

  const index = { embeddings, model: cacheModel, provider };
  EMBED_CACHE.set(library, index);
  if (verbose) console.log(`[embeddings] indexed ${embeddings.size} blocks (${provider}:${cacheModel})`);
  return index;
}

/** Query the dense index. Returns [{ lib_id, score }] sorted desc, or [] if unavailable. */
export async function denseSearch(library, query, { limit = 25, model = EMBED_MODEL } = {}) {
  const index = await buildDenseIndex(library, { model });
  if (!index) return [];
  const qvec = await embedText(query, model);
  if (!qvec) return [];
  const scored = [];
  for (const [libId, vec] of index.embeddings) {
    const s = cosine(qvec, vec);
    if (s > 0.15) scored.push({ lib_id: libId, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Reciprocal Rank Fusion (Graphiti/U2): score += 1/(rank+1) per list. */
export function rrf(resultLists, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of resultLists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const id = item.lib_id ?? item;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + i));
    }
  }
  return [...scores.entries()]
    .map(([lib_id, score]) => ({ lib_id, score }))
    .sort((a, b) => b.score - a.score);
}
