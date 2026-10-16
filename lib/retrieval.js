/** Scoped planner and bounded evidence bundles over the existing graph. */
import { search, readBlock } from './memoryLaneCore.js';
import { graphSearch } from './graph.js';
import { answerQuestion } from './answer.js';
import { sourceEvidence, conflictingEvidence } from './evidence.js';
import { scopeLibrary, allowExternal, digest } from './access.js';
import { buildTemporalProjection, temporalState } from './temporal.js';

export class RetrievalCache {
  constructor({ maxEntries = 128 } = {}) { this.maxEntries = Math.max(1, Math.min(1024, maxEntries)); this.entries = new Map(); }
  get(key) {
    const value = this.entries.get(key);
    if (!value) return null;
    this.entries.delete(key); this.entries.set(key, value);
    return structuredClone(value);
  }
  set(key, value) {
    this.entries.delete(key); this.entries.set(key, structuredClone(value));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}

export function evidenceBundle(library, query, { limit = 10, requiredEntities = [], before = null } = {}) {
  const cap = Math.max(1, Math.min(20, Number(limit) || 10));
  if (before && !Number.isFinite(Date.parse(before))) throw Error('Invalid temporal boundary');
  const lexical = search(library, query, { limit: cap });
  const graph = graphSearch(library, query, { limit: cap });
  const ids = [...new Set([...lexical.matches.map(m => m.lib_id), ...graph.matches.map(m => m.lib_id)])].slice(0, cap);
  const evidence = ids.flatMap(id => {
    const entry = library.blocks.find(e => e.lib_id === id);
    const block = readBlock(library, id);
    if (!block?.present || entry.sha256 !== block.sha256 || block.fields.anchor_type) return [];
    const at = block.fields.timestamp;
    if (before && (!Number.isFinite(Date.parse(at)) || Date.parse(at) >= Date.parse(before))) return [];
    return [{ ...sourceEvidence(block, query), observed_at: at || null, support: 'candidate' }];
  }).sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  const missing = requiredEntities.filter(entity => !evidence.some(e => e.excerpt.toLowerCase().includes(String(entity).toLowerCase())));
  return { evidence, missing_evidence: missing, conflicting: conflictingEvidence(evidence),
    complete: missing.length === 0 && evidence.length > 0, support: 'candidate_bundle',
    traversal: { ...graph.stats, max_hops: 2, returned: evidence.length, limit: cap } };
}

/** Callers supply a trusted principal; HTTP authentication happens upstream. */
export async function retrieve(library, request, { policy, principal, cache = null, rank, available } = {}) {
  if (!policy?.principals?.[principal] || policy.principals[principal].disabled) throw Error('Access denied');
  const scoped = scopeLibrary(library, policy, principal);
  // Read source hashes on each request before using conclusions. This also
  // invalidates cache entries when files change without a manifest update.
  const version = digest(JSON.stringify(scoped.blocks.map(b => [b.block_id, b.sha256])));
  const key = digest(JSON.stringify({ query: String(request.query || '').trim().toLowerCase(),
    request, version, root: library.rootDir, policy, principal, model: 'typesafe/jev-1.13', retrieval: 1 }));
  const hit = cache?.get(key);
  if (hit) return { ...hit, cache_hit: true };
  let result;
  if (request.entity) {
    const projection = buildTemporalProjection(scoped, { authorities: policy.authorities || {} });
    result = { tier: 2, temporal: temporalState(projection, request), rejected: projection.rejected };
  } else if (request.bundle) {
    result = { tier: 2, ...evidenceBundle(scoped, request.query, request) };
  } else {
    result = await answerQuestion(scoped, request.query, { rank,
      available: allowExternal(scoped) ? available : () => false });
  }
  // Provider failure/abstention is transient. Never cache it into a conclusion.
  if (result.mode !== 'none') cache?.set(key, result);
  return { ...result, cache_hit: false };
}
