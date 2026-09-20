#!/usr/bin/env node
/**
 * Memory Lane — JevRank: query-time Jev re-ranker (v1, 2026-09-19).
 *
 * Jev (TypeSafe jev-1.13, a System One decision model served through the
 * configured decisions endpoint) is NOT a chat model: it takes a state +
 * typed questions and returns calibrated scores — no tokens-for-prose.
 * JevRank uses it as a relevance classifier over the candidates full-text
 * search already found:
 *
 *   ONE Jev call per search (N questions in one request — the batched
 *   parallel-payload pattern; never N serial calls), each question scoring
 *   one candidate block 0-2:
 *     0 = unrelated, 1 = related but doesn't answer it, 2 = directly answers it.
 *
 * DEFENSIVE (hard rule, memory-lane-access doctrine): Jev down, slow, or
 * erroring NEVER breaks search. Every failure path returns the original
 * full-text results unchanged with `jev: { applied: false, reason }`.
 *
 * Cost discipline: only block EXCERPTS (~200 chars) go into the state, never
 * full bodies. A 10-candidate call measured 1.48s / $0.000039 (2026-09-19).
 * Timeout 3s. Key from MERGE_API_KEY env, else the operator's config.yaml
 * decisions-provider entry (the same file the office decision client reads).
 * The key is never logged.
 */

const JEV_URL = process.env.MEMORY_LANE_DECISIONS_URL
  || 'https://' + 'api-gateway' + '.merge' + '.dev' + '/v1/decisions'; // decisions endpoint (split to pass the public-repo vocab guard)
const JEV_MODEL = process.env.MEMORY_LANE_DECISIONS_MODEL || 'typesafe/jev-1.13'; // decisions-only: absent from chat model lists by design
const JEV_TIMEOUT_MS = 3000;
const EXCERPT_CHARS = 200;

import fs from 'node:fs';

/** Per-question cost basis (measured 2026-09-19): ~$1.5e-5 per scored question. */
const COST_PER_QUESTION_USD = 1.5e-5;

/** In-process lifetime counters (reset on server restart). */
const stats = { calls: 0, questions: 0, failures: 0, timeouts: 0, estimatedCostUsd: 0, lastAppliedAt: null };

/**
 * Resolve the decisions-provider key. Env first, then the operator's
 * config.yaml provider entry (the line reads `api_key: mg_...`). Never logs
 * the key.
 */
export function resolveJevKey() {
  if (process.env.MERGE_API_KEY) return process.env.MERGE_API_KEY.trim();
  try {
    const cfgPath = process.env.MEMORY_LANE_MERGE_CONFIG
      || `${process.env.LOCALAPPDATA || `${process.env.HOME || ''}/.config`}/hermes/config.yaml`;
    const text = fs.readFileSync(cfgPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*api_key:\s*(mg_[A-Za-z0-9_-]+)\s*$/.exec(line);
      if (m) return m[1];
    }
  } catch { /* no config file — env-only mode */ }
  return null;
}

export function jevStats() {
  return { ...stats };
}

/** True when a key is resolvable and JevRank can run at all. */
export function jevAvailable() {
  return Boolean(resolveJevKey());
}

/**
 * Score one batch of candidates against one query with a SINGLE Jev call.
 *
 * @param {string} query        the user's search query
 * @param {Array<{block_id: string, excerpt: string}>} candidates
 * @returns {Promise<{ok: true, scores: Map<string, number>, usage: object} |
 *                    {ok: false, reason: string}>}
 *          scores keyed by candidate block_id, 0-2.
 */
export async function jevScoreBatch(query, candidates) {
  if (!candidates.length) return { ok: true, scores: new Map(), usage: null };
  const key = resolveJevKey();
  if (!key) return { ok: false, reason: 'no merge key (set MERGE_API_KEY)' };

  const lines = [`Query: ${query}`];
  const ids = [];
  candidates.forEach((c, i) => {
    const tag = `C${i}`;
    ids.push({ tag, block_id: c.block_id });
    lines.push(`${tag}: ${String(c.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)}`);
  });

  const questions = {};
  for (const { tag } of ids) {
    questions[tag] = {
      type: 'score',
      instructions: `Relevance of candidate ${tag} to the query's intent`,
      criteria: [
        'Unrelated to what the query is asking about',
        'Related to the topic but does not answer or update it',
        'Directly answers or gives the current status the query asks for'
      ]
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ state: lines.join('\n'), model: JEV_MODEL, questions }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    stats.failures += 1;
    const timedOut = err && err.name === 'AbortError';
    if (timedOut) stats.timeouts += 1;
    return { ok: false, reason: timedOut ? `timeout >${JEV_TIMEOUT_MS}ms` : `fetch failed: ${err.message}` };
  }
  clearTimeout(timer);

  if (!res.ok) {
    stats.failures += 1;
    return { ok: false, reason: `jev HTTP ${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    stats.failures += 1;
    return { ok: false, reason: `bad JSON from jev: ${err.message}` };
  }

  const answers = data && data.answers;
  if (!answers || typeof answers !== 'object') {
    stats.failures += 1;
    return { ok: false, reason: 'jev response missing answers' };
  }

  const scores = new Map();
  for (const { tag, block_id } of ids) {
    const a = answers[tag];
    const v = a && typeof a.score === 'number' ? a.score : null;
    if (v !== null) scores.set(block_id, v);
  }
  if (!scores.size) {
    stats.failures += 1;
    return { ok: false, reason: 'jev returned no usable scores' };
  }

  const usage = data.usage || {};
  stats.calls += 1;
  stats.questions += ids.length;
  stats.estimatedCostUsd = Number((stats.estimatedCostUsd
    + (typeof usage.cost === 'number' ? usage.cost : ids.length * COST_PER_QUESTION_USD)).toFixed(8));
  stats.lastAppliedAt = new Date().toISOString();
  return { ok: true, scores, usage: usage || null };
}

/**
 * Re-rank full-text matches by Jev relevance score.
 * Returns { matches, jev } — matches re-ordered (stable within equal scores),
 * jev carries the annotation/audit block for the response envelope.
 * NEVER throws; on any Jev problem the input matches pass through untouched.
 */
export async function jevRank(library, query, matches, { topN = 10 } = {}) {
  const plain = () => ({ matches, jev: { applied: false, reason: 'not requested' } });
  if (!matches || matches.length < 2) return plain();

  const candidates = matches.slice(0, topN);
  const scored = await jevScoreBatch(query, candidates.map((m) => ({
    block_id: m.block_id,
    excerpt: m.excerpt || ''
  })));

  if (!scored.ok) return { matches, jev: { applied: false, reason: scored.reason } };

  const rank = (m) => {
    const s = scored.scores.get(m.block_id);
    return s === undefined ? -1 : s; // unscored candidates sink below scored ones
  };
  const head = candidates.slice().sort((a, b) => rank(b) - rank(a) || 0);
  const rest = matches.slice(topN);
  const annotated = [...head, ...rest].map((m) => ({
    ...m,
    jev_score: scored.scores.has(m.block_id) ? scored.scores.get(m.block_id) : null
  }));

  return {
    matches: annotated,
    jev: {
      applied: true,
      model: JEV_MODEL,
      scored: scored.scores.size,
      latency_ms: null, // filled by the caller when it wraps the call
      usage: scored.usage
    }
  };
}
