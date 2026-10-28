/** Scoped planner and bounded evidence bundles over the existing graph. */
import { search, readBlock } from './memoryLaneCore.js';
import { graphSearch } from './graph.js';
import { answerQuestion } from './answer.js';
import { sourceEvidence, conflictingEvidence } from './evidence.js';
import { scopeLibrary, allowExternal, digest } from './access.js';
import { buildTemporalProjection, temporalState } from './temporal.js';
import { jevRank, jevAvailable } from './jevrank.js';

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

/** Select a small, hash-checked session-start digest from the caller's scope. */
export async function recentSelection(library, { limit = 5, query = '', rank = null, available = null } = {}) {
  const cap = Math.max(1, Math.min(20, Number(limit) || 5));
  const candidates = [];
  for (const entry of library.blocks.slice().sort((a, b) => b.lib_id - a.lib_id)) {
    if (candidates.length >= Math.max(cap * 3, 12)) break;
    const block = readBlock(library, entry.lib_id);
    if (!block?.present || block.sha256 !== entry.sha256 || block.fields.anchor_type) continue;
    const body = String(block.body || '').replace(/^#.*$/gm, '').trim();
    if (!body) continue;
    const excerpt = body.length > 320 ? `${body.slice(0, 319).replace(/\s+\S*$/, '')}…` : body;
    candidates.push({ lib_id: entry.lib_id, block_id: entry.block_id, canonical_name: entry.canonical_name,
      lineage: entry.lineage, timestamp: block.fields.timestamp || null, excerpt, sha256: block.sha256 });
  }
  let matches = candidates;
  let jev = { applied: false, reason: 'not requested' };
  const prompt = String(query || '').trim().slice(0, 500)
    || 'Select durable, current working context for the start of a session. Prefer recent active work, decisions, constraints, and open tasks.';
  if (rank && available?.() && candidates.length > 1) {
    const ranked = await rank(library, prompt, candidates.map(c => ({ ...c, excerpt: c.excerpt })), { topN: Math.min(10, candidates.length) });
    if (ranked?.jev?.applied) {
      const byId = new Map(ranked.matches.map((m, i) => [m.block_id, { m, i }]));
      matches = candidates.slice().sort((a, b) => {
        const ar = byId.get(a.block_id), br = byId.get(b.block_id);
        return (br?.m.jev_score ?? -1) - (ar?.m.jev_score ?? -1)
          || (ar?.i ?? Number.MAX_SAFE_INTEGER) - (br?.i ?? Number.MAX_SAFE_INTEGER)
          || b.lib_id - a.lib_id;
      });
      jev = ranked.jev;
    } else if (ranked?.jev) jev = ranked.jev;
  }
  return { mode: 'recent', tier: 0, selection: jev.applied ? 'jev' : 'newest_first',
    blocks: matches.slice(0, cap), jev, latest_timestamp: candidates[0]?.timestamp || null };
}

/** Callers supply a trusted principal; HTTP authentication happens upstream. */
export async function retrieve(library, request, { policy, principal, cache = null, rank = jevRank, available = jevAvailable } = {}) {
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
  if (request.recent === true) {
    result = await recentSelection(scoped, { limit: request.limit, query: request.query,
      rank, available: () => allowExternal(scoped) && available() });
  } else if (request.entity) {
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
