#!/usr/bin/env node
/**
 * Memory Lane — answer endpoint core (v1, 2026-08-05).
 *
 * The "same % wins" retrieval gate: a question gets an answer, not just a
 * list of hits. Three modes, cheapest first:
 *
 *   direct       — the query's content terms literally appear in the top
 *                  block. Deterministic, free, instant. Returns the excerpt
 *                  with the source block.
 *   synthesized  — no exact term presence. The top 3 blocks are handed to
 *                  deepseek v4 flash (via Merge, ~$0.00004) which answers
 *                  from the evidence or says it doesn't know. Honest RAG.
 *   none         — no matches at all. No LLM call. Returns an honest
 *                  "no memory found" with suggestions.
 *
 * The gate keeps the paid lane for genuine misses: exact hits never cost a
 * token, and the model is only asked when the memory might hold the answer
 * but the exact wording doesn't surface it.
 */

import { search, tokenizeQuery } from './memoryLaneCore.js';
import { resolveExtractConfig } from './extract.js';

export const ANSWER_PROMPT = `You are answering a question from a user's personal memory store. Below are excerpts from memory blocks (sealed session records). Answer the question using ONLY the evidence provided.

RULES:
- If the evidence contains the answer, answer concisely and cite which memory block(s) support it.
- If the evidence does NOT contain the answer, say "No memory found for this." Do NOT invent facts.
- Keep the answer under 120 words.

MEMORY EVIDENCE:
`;

/**
 * Deterministic check: do all content terms of the query appear in the block's
 * raw text? Uses the same tokenizer as search so stopwords don't count.
 */
export function termsPresent(raw, query) {
  const terms = tokenizeQuery(query);
  if (!terms.length) return true; // nothing to check -> treat as present
  const lower = String(raw || '').toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/**
 * Answer a question against a loaded library.
 * Returns { mode, answer, evidence, cost } — mode is 'direct' | 'synthesized' | 'none'.
 */
export async function answerQuestion(library, question, { topN = 3, timeoutMs = 90000 } = {}) {
  const q = String(question || '').trim();
  if (!q) return { mode: 'none', answer: 'Ask a question to search your memory.', evidence: [] };

  const result = search(library, q, { limit: topN });
  if (result.count === 0) {
    return {
      mode: 'none',
      answer: 'No memory found for that. Try different wording, or seal the memory first.',
      evidence: [],
      query: q
    };
  }

  // Read the top blocks' raw text for the deterministic term check.
  const top = result.matches.slice(0, topN);
  const evidence = top.map((m) => ({
    block_id: m.block_id,
    display_name: m.display_name,
    excerpt: m.excerpt,
    score: m.score ?? null
  }));

  const { readBlock } = await import('./memoryLaneCore.js');
  const topRaw = [];
  for (const m of top) {
    const block = readBlock(library, m.lib_id);
    if (block && block.present) topRaw.push({ block_id: m.block_id, raw: block.raw, body: block.body || '' });
  }

  // Direct mode: all content terms present in the top block's raw text.
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
      cost: 0
    };
  }

  // Synthesized mode: build context and ask the model.
  const context = topRaw
    .map((t, i) => `[Memory block ${i + 1}: ${t.block_id}]\n${t.raw.slice(0, 4000)}`)
    .join('\n\n---\n\n');

  try {
    const cfg = resolveExtractConfig();
    if (!cfg.apiKey) {
      // No Merge key — degrade to the best excerpt (free, honest).
      return {
        mode: 'direct',
        answer: evidence[0].excerpt,
        evidence,
        source: evidence[0].block_id,
        query: q,
        note: 'no LLM key configured — returned best excerpt'
      };
    }
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You answer questions from a user\'s memory evidence. Never invent facts.' },
          { role: 'user', content: ANSWER_PROMPT + context + `\n\nQUESTION: ${q}` }
        ],
        temperature: 0.2,
        max_tokens: 500,
        tool_choice: 'none',
        tools: []
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`merge HTTP ${res.status}`);
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let content = (msg && msg.content) || '';
    if (!content.trim() && msg && typeof msg.thinking === 'string') content = msg.thinking;
    const usage = data.usage || {};
    return {
      mode: 'synthesized',
      answer: content.trim() || 'No memory found for this.',
      evidence,
      query: q,
      model: cfg.model,
      cost: usage.total_tokens ? Number((usage.total_tokens * 0.00000004).toFixed(6)) : null
    };
  } catch (err) {
    // LLM failure — degrade to the best excerpt, never fail the request.
    return {
      mode: 'direct',
      answer: evidence[0].excerpt,
      evidence,
      source: evidence[0].block_id,
      query: q,
      note: `synthesis failed (${err.message}) — returned best excerpt`
    };
  }
}
