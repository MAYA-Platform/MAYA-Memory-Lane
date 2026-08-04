#!/usr/bin/env node
/**
 * U4 (2026-08-04): Dense embedding index for Memory Lane.
 *
 * Optional local embedding support via Ollama (bge-m3). When Ollama is
 * unavailable, every function degrades gracefully (returns null/empty) so the
 * core stays zero-dependency — FTS5 remains the default, dense is an
 * enhancement fused via RRF (U2).
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
const EMBED_CACHE = new WeakMap();

/** Test whether Ollama is reachable (cheap /api/tags probe). */
export async function embeddingsAvailable() {
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
 * Embed a single text via Ollama. Returns Float32Array or null.
 * Uses child_process to avoid blocking the event loop on the HTTP call.
 */
export async function embedText(text, model = EMBED_MODEL) {
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
 * Ollama is unavailable. Caches to disk (libDir/.embeddings-<model>.json)
 * keyed by library MANIFEST sha so re-runs don't re-embed everything.
 */
export async function buildDenseIndex(library, { model = EMBED_MODEL, verbose = false } = {}) {
  const cached = EMBED_CACHE.get(library);
  if (cached) return cached;

  // verify Ollama is up with this model
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

  const rootDir = library.rootDir || (library.ok && library.rootDir) || '';
  const cachePath = rootDir ? path.join(rootDir, `.embeddings-${model}.json`) : null;

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
      if (disk.key === cacheKey && disk.model === model) {
        const embeddings = new Map();
        for (const [k, arr] of Object.entries(disk.vectors)) embeddings.set(Number(k), Float32Array.from(arr));
        const index = { embeddings, model };
        EMBED_CACHE.set(library, index);
        if (verbose) console.log(`[embeddings] loaded ${embeddings.size} cached vectors (${model})`);
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

  // U4: parallel embedding with a small concurrency limit (Ollama handles a
  // few concurrent requests; too many queues). Speeds the first build hugely.
  const CONCURRENCY = 4;
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const f = entry.filePath || path.join(rootDir, 'shelves', entry.shelf, `block-${String(entry.lib_id).padStart(3, '0')}.md`);
      let text = '';
      try {
        const raw = fs.readFileSync(f, 'utf8');
        text = (raw.split('---').slice(2).join('---') || raw).trim();
      } catch {
        continue;
      }
      const vec = await embedText(text, model);
      if (vec) embeddings.set(entry.lib_id, vec);
      if (verbose && embeddings.size % 100 === 0) console.log(`[embeddings] ${embeddings.size}/${entries.length}...`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // write disk cache
  if (cachePath && cacheKey) {
    try {
      const vectors = {};
      for (const [k, v] of embeddings) vectors[k] = Array.from(v);
      fs.writeFileSync(cachePath, JSON.stringify({ key: cacheKey, model, vectors }), 'utf8');
      if (verbose) console.log(`[embeddings] cached ${embeddings.size} vectors to ${cachePath}`);
    } catch (e) {
      if (verbose) console.log('[embeddings] cache write failed:', e.message);
    }
  }

  const index = { embeddings, model };
  EMBED_CACHE.set(library, index);
  if (verbose) console.log(`[embeddings] indexed ${embeddings.size} blocks (${model})`);
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
