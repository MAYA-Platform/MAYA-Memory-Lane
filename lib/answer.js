/** Jev selects evidence; only immutable source text can become an answer. */
import { search, readBlock, tokenizeQuery } from './memoryLaneCore.js';
import { jevRank, jevAvailable } from './jevrank.js';
import { sourceEvidence, exactLookup, conflictingEvidence } from './evidence.js';

// Retained public utility; lexical coverage is not evidence support.
export function termsPresent(raw, query) {
  const lower = String(raw || '').toLowerCase();
  return tokenizeQuery(query).every(t => lower.includes(t));
}

export async function answerQuestion(library, question, {
  topN = 3, timeoutMs = 3000, rank = jevRank, available = jevAvailable
} = {}) {
  const q = String(question || '').trim();
  const none = (reason, evidence = [], jev = null) => ({ mode: 'none',
    answer: 'No memory found for that. Supporting evidence is insufficient or conflicting.',
    reason, evidence, query: q, jev, cost: jev?.usage?.cost ?? null });
  if (!q) return none('empty_query');
  const limit = Math.max(1, Math.min(10, Number(topN) || 3));
  const result = search(library, q, { limit: 12 });
  const hydrate = matches => matches.flatMap(m => {
    const entry = library.blocks.find(b => b.lib_id === m.lib_id && b.block_id === m.block_id);
    if (!entry) return [];
    const block = readBlock(library, m.lib_id);
    if (!block?.present || block.sha256 !== entry.sha256) return [];
    return [{ ...m, evidence: sourceEvidence(block, q) }];
  });
  let candidates = hydrate(result.matches);
  if (!candidates.length) return none('no_valid_sources');
  const exact = candidates.filter(c => exactLookup(q, c.evidence));
  if (exact.length === 1 && !conflictingEvidence(candidates.map(c => c.evidence))) {
    const e = exact[0].evidence;
    return { mode: 'direct', answer: e.excerpt, evidence: [e], source: e.block_id,
      query: q, cost: 0, jev: null, tier: 0 };
  }
  let ranked;
  if (available()) {
    try {
      ranked = await rank(library, q, candidates.map(c => ({ ...c,
        excerpt: c.evidence.excerpt })), { topN: 8, timeoutMs });
    } catch { return none('ranking_failed'); }
  }
  if (!ranked?.jev?.applied) return none(ranked?.jev?.reason || 'judgment_unavailable');
  // Score 2 is the typed directly-answers category. Related-topic scores do
  // not support an answer; the offline calibration fixtures pin this boundary.
  candidates = hydrate(ranked.matches).filter(c => c.jev_score === 2);
  if (!candidates.length) return none('insufficient_support', [], ranked.jev);
  const evidence = candidates.slice(0, limit).map(c => c.evidence);
  if (conflictingEvidence(candidates.map(c => c.evidence))) return none('conflicting_evidence', evidence, ranked.jev);
  return { mode: 'jev', answer: evidence.map(e => e.excerpt).join('\n\n'),
    evidence, source: evidence[0].block_id, query: q, jev: ranked.jev,
    cost: ranked.jev.usage?.cost ?? null, tier: evidence.length > 1 ? 2 : 1 };
}
