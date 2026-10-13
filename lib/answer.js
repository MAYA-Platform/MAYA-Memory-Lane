#!/usr/bin/env node
/**
 * Memory Lane - answer endpoint core (v2, 2026-10-13, Jev-only).
 *
 * The "same % wins" retrieval gate: a question gets an answer, not just a
 * list of hits. Modes, cheapest first:
 *
 *   direct       - the query's content terms literally appear in the top
 *                  block. Deterministic, free, instant. Returns the block's
 *                  own text with the source block.
 *   jev          - no exact term presence, but Jev (typesafe/jev-1.13, the
 *                  System-One decision model served through Merge) ranked a
 *                  specific block first for THIS question's intent. We return
 *                  THAT BLOCK's own text verbatim. Jev does the deciding; no
 *                  LLM ever writes prose for memory - a paraphrase is where
 *                  a memory system starts hallucinating (founder rule,
 *                  2026-10-13).
 *   none         - no matches at all, or Jev's pick shares no content terms
 *                  with the question (honest abstain, no prose, no hit).
 *
 * There is NO synthesized/prose lane and NO deepseek/ollama fallback lane:
 * removed by founder order (2026-10-13). Jev is the only model near the
 * answer path - one batched decisions call, milliseconds, calibrated, and
 * structurally incapable of inventing sentences.
 */

import { search, readBlock, tokenizeQuery } from './memoryLaneCore.js';
import { jevRank, jevAvailable } from './jevrank.js';

/**
 * Deterministic check: do all content terms of the query appear in the
 * block's raw text? Uses the same tokenizer as search so stopwords don't
 * count. (Kept here - the answer test + MCP import it from answer.js.)
 */
export function termsPresent(raw, query) {
  const terms = tokenizeQuery(query);
  if (!terms.length) return true; // nothing to check -> treat as present
  const lower = String(raw || '').toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/**
 * Answer a question against a loaded library.
 * Returns { mode, answer, evidence, cost } - mode is 'direct' | 'jev' | 'none'.
 */
export async function answerQuestion(library, question, { topN = 3, timeoutMs = 45000 } = {}) {
  const q = String(question || '').trim();
  if (!q) return { mode: 'none', answer: 'Ask a question to search your memory.', evidence: [] };

  let result = search(library, q, { limit: topN });
  if (result.count === 0) {
    return {
      mode: 'none',
      answer: 'No memory found for that. Try different wording, or seal the memory first.',
      evidence: [],
      query: q
    };
  }

  // JevRank pass (defensive): when a Merge key is available, re-score the top
  // candidates with ONE batched Jev decisions call so ambiguous queries land
  // the block that actually answers the question, not just the one sharing
  // its words. This fixes the measured direct-mode false positive ("the
  // list" landing a soul file because the word "list" appears in it). Any
  // Jev problem keeps the plain full-text order - never breaks the answer.
  let jevInfo = null;
  if (jevAvailable() && result.matches.length >= 2) {
    try {
      // Re-search wider so Jev has a real candidate pool - the answer path
      // only fetches topN matches, which starves the re-ranker.
      const wide = search(library, q, { limit: Math.max(topN, 10) });
      const ranked = await jevRank(library, q, wide.matches, { topN: Math.max(topN, 5) });
      if (ranked.jev && ranked.jev.applied) {
        result = { ...result, matches: ranked.matches.slice(0, Math.max(result.matches.length, topN)) };
        jevInfo = { scored: ranked.jev.scored, model: ranked.jev.model, applied: true };
      }
    } catch { /* never break the answer path */ }
  }

  // Read the top blocks' raw text for the deterministic term check.
  const top = result.matches.slice(0, topN);
  const evidence = top.map((m) => ({
    block_id: m.block_id,
    display_name: m.display_name,
    excerpt: m.excerpt,
    score: m.score ?? null
  }));

  const topRaw = [];
  for (const m of top) {
    const block = readBlock(library, m.lib_id);
    if (block && block.present) topRaw.push({ block_id: m.block_id, raw: block.raw, body: block.body || '' });
  }

  // Tier 1 - direct: all content terms present in the top block's raw text.
  if (topRaw.length && termsPresent(topRaw[0].raw, q)) {
    // Answer with the parsed BODY (no frontmatter noise), trimmed; fall back
    // to the excerpt if the body is empty.
    const body = topRaw[0].body.trim();
    const answer = body ? body.slice(0, 600) : evidence[0].excerpt;
    return {
      mode: 'direct',
      answer,
      evidence,
      source: evidence[0].block_id,
      query: q,
      cost: 0,
      jev: jevInfo
    };
  }

  // Tier 2 - Jev pick: no exact term presence, but Jev's ordering names a
  // specific block as the best answer for this question's intent. Return
  // that block's own text verbatim (never a model-written paraphrase).
  // Failsafe: if Jev did not actually run, or its top pick shares no content
  // terms with the question, abstain honestly instead of serving noise.
  if (jevInfo && topRaw.length) {
    const terms = tokenizeQuery(q);
    const answered = terms.length
      ? topRaw.filter((t) => terms.every((term) => t.raw.toLowerCase().includes(term)))
      : topRaw;
    if (answered.length) {
      const picked = answered[0];
      const body = picked.body.trim();
      return {
        mode: 'jev',
        answer: body ? body.slice(0, 600) : picked.raw.slice(0, 600),
        evidence,
        source: picked.block_id,
        query: q,
        cost: 0,
        jev: jevInfo
      };
    }
  }

  // Tier 3 - honest abstain. Nothing in memory answers it. Explicitly NOT
  // handed to a prose model.
  return {
    mode: 'none',
    answer: 'No memory found for that. Jev found no block that answers it - try different wording, or seal the memory first.',
    evidence,
    query: q,
    jev: jevInfo
  };
}
