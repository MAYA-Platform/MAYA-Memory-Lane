#!/usr/bin/env node
/**
 * Memory Lane - dense embedding lane (v4, 2026-10-13, OFF by company rule).
 *
 * The dense-embedding lane (local Ollama bge-m3 / Vertex text-embedding-004)
 * was REMOVED by founder order (2026-10-13): no local models run on the PC,
 * and the Vertex/Gemini lane is retired. Every function now degrades to the
 * documented no-provider contract (available=false, null vectors, empty
 * fused lists) so the core stays zero-dependency - FTS5 + JevRank remain
 * the search surface. The API surface is kept intentionally so historical
 * benchmark harnesses and the provider test keep importing cleanly.
 */

/** Provider is "none" until a company-approved dense lane ships. */
export const EMBED_PROVIDER = 'none';

/** True only if a provider is mounted (never today). */
export async function embeddingsAvailable() {
  return false;
}

/** Contract: no provider -> null (callers fuse lexical-only). */
export async function embedText(text, model = null) {
  return null;
}

/** Contract: no provider -> null dense index. */
export async function buildDenseIndex(library, { model = null, verbose = false } = {}) {
  if (verbose) console.log('[embeddings] provider set to "none" by company rule (2026-10-13): dense index disabled');
  return null;
}

/** Contract: no dense index -> plain lexical order passes through. */
export function denseSearch(library, query, matches) {
  return matches;
}

/** Keep the RRF helper (pure math, used by benchmark harnesses). */
export function rrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((libId, rank) => {
      const id = String(libId);
      const inc = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) || 0) + inc);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => Number(id));
}
