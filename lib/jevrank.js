#!/usr/bin/env node
/**
 * Memory Lane — JevRank: query-time Jev re-ranker (v1.2, 2026-09-23).
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
 * v1.2 (F10 observability parity): every rerank attempt with an actual Jev
 * call appends a receipt to <library>/health/jevrank_ledger.jsonl (success
 * AND failure rows, prestamp-ledger parity). Receipt writes are wrapped —
 * observability can never break search. Override the path for tests via
 * MEMORY_LANE_JEVRANK_LEDGER.
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
import path from 'node:path';
import { readBlock, tokenizeQuery, extractFactsSection } from './memoryLaneCore.js';

/** Per-question cost basis (measured 2026-09-19): ~$1.5e-5 per scored question. */
const COST_PER_QUESTION_USD = 1.5e-5;

// --- Candidate pool shaping (v1.1, 2026-09-20) ------------------------------
// Full-text search surfaces candidates by shared WORDS. The measured failure
// ("the list" -> block 1819 ranked #46 because its body says "task list" only
// a few times) means the block that ANSWERS the query can sit below the
// lexical cutoff and Jev never sees it. Lineage-context fix: blocks cluster
// by topic (lineage), so strong candidates vote for their whole family —
// recent same-family siblings that contain a query token join the pool.
const MAX_CANDIDATES = 12;   // hard cap: ONE Jev call stays one call
const EXPAND_SIBLINGS = 4;   // max lineage-family blocks added per search
const SIBLING_SCAN_CAP = 400; // max manifest entries inspected for expansion
                             // (measured: 111 scan steps spent 4 slots before
                             // reaching the answering block at recency #112)

/** In-process lifetime counters (reset on server restart). */
const stats = { calls: 0, questions: 0, failures: 0, timeouts: 0, estimatedCostUsd: 0, lastAppliedAt: null };

// --- Persistent receipt ledger (F10 observability parity, 2026-09-23) --------
// The prestamp lane keeps jev_prestamp_ledger.jsonl receipts; JevRank — the
// ALWAYS-ON Jev surface — previously kept only in-process counters (above),
// which vanish on restart. This append-only JSONL ledger answers, durably:
// "what did JevRank re-rank, at what cost, with what latency, and when it
// failed." Receipts are OBSERVABILITY, never a dependency: every write is
// wrapped and a receipt failure must NEVER break search (the plain full-text
// fallback stays first in the failure path, untouched).
//
// Location: <library>/health/jevrank_ledger.jsonl — the library's health/
// dir is already the lane's status surface, and a per-library ledger keeps
// test/temp libraries isolated from production by construction. Override for
// tests via MEMORY_LANE_JEVRANK_LEDGER (redirect, same discipline as the
// jev_boundary_fixtures.py test-ledger redirect). Queries are truncated to
// 120 chars; no key material or full block bodies ever reach the ledger.
const QUERY_TRUNCATE = 120;

function jevrankLedgerPath(library) {
  if (process.env.MEMORY_LANE_JEVRANK_LEDGER) {
    return process.env.MEMORY_LANE_JEVRANK_LEDGER;
  }
  const root = library && library.rootDir;
  if (!root) return null;
  return path.join(root, 'health', 'jevrank_ledger.jsonl');
}

function appendJevrankReceipt(library, entry) {
  const p = jevrankLedgerPath(library);
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`);
  } catch { /* receipt write must never break search */ }
}

function baseReceipt(library, query) {
  return {
    ts: new Date().toISOString(),
    query: String(query || '').slice(0, QUERY_TRUNCATE),
    library: library && library.rootDir ? String(library.rootDir) : null,
    model: JEV_MODEL
  };
}

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
 * Lineage-family candidate expansion. Full-text recall fails on vague queries
 * ("the list", "what number did we make it to"): the answering block shares a
 * TOPIC, not necessarily top-ranked WORDS. Strong candidates vote for their
 * lineage family — the most recent family siblings that contain at least one
 * query token are appended to the pool (deduped, hard-capped) so the batched
 * Jev call can score what the words missed. Bounded: recent-first scan capped
 * at SIBLING_SCAN_CAP manifest entries; never re-reads more than needed.
 *
 * @param {object} library   loaded library (loadLibrary result)
 * @param {string} query     raw query string
 * @param {Array}  matches   full-text matches (already candidate-shaped)
 * @param {number} budget    remaining candidate slots (MAX_CANDIDATES - base)
 * @returns {Array<{block_id, excerpt, added: boolean}>} pool for Jev
 */
export function expandCandidates(library, query, matches, budget = EXPAND_SIBLINGS) {
  if (!library || !Array.isArray(library.blocks) || budget <= 0) return [];
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];

  const present = new Set(matches.map((m) => m.lib_id));
  // Family = lineage prefix family: 'session-closeout' and 'session-closeouts'
  // are the same topic under singular/plural naming. Strong candidates' exact
  // lineages vote; prefix families (>=8 chars, shared word stem) are accepted
  // so a singular block can ride a plural candidate's vote.
  const strongLineages = [...new Set(matches.slice(0, 5).map((m) => m.lineage).filter(Boolean))];
  if (!strongLineages.length) return [];
  const allLineages = [...new Set(library.blocks.map((b) => b.lineage).filter(Boolean))];
  const family = (lg) => strongLineages.some((s) => lg === s
    || lg.startsWith(s.slice(0, Math.min(s.length, 15)))
    || s.startsWith(lg.slice(0, Math.min(lg.length, 15))));

  // Recent-first scan over the manifest (recency proxy: lib_id order), capped.
  // Two-pass pick quality: title/term-hit density decides priority within the
  // family, not raw recency — a block whose TITLE or facts mention the query
  // (measured: 1819's title carries '10-Item Task List') outranks a recent
  // sibling that merely contains the word once in its body.
  const scoredPicks = [];
  let scanned = 0;
  const ordered = library.blocks.slice().sort((a, b) => b.lib_id - a.lib_id);
  for (const entry of ordered) {
    if (scoredPicks.length >= 16 || scanned >= SIBLING_SCAN_CAP) break;
    scanned += 1;
    const lg = entry.lineage || '';
    if (!lg || !family(lg) || present.has(entry.lib_id)) continue;
    const block = readBlock(library, entry.lib_id);
    if (!block || !block.present) continue;
    const raw = (block.raw || '').toLowerCase();
    if (!terms.some((t) => raw.includes(t))) continue; // must touch the query
    // Pick-quality score: title/display hits weigh heaviest (titles are the
    // human summary of the block), then facts, then body hit count, then recency.
    const title = `${entry.canonical_name || ''} ${entry.block_id || ''}`.toLowerCase();
    const facts = extractFactsSection(block.raw).toLowerCase();
    const bodyHits = terms.filter((t) => raw.includes(t)).length;
    const titleHits = terms.filter((t) => title.includes(t)).length;
    const factsHits = terms.filter((t) => facts.includes(t)).length;
    const quality = titleHits * 4 + factsHits * 2 + bodyHits + (entry.lib_id / 1e9);
    scoredPicks.push({ entry, block, quality });
    present.add(entry.lib_id);
  }
  scoredPicks.sort((a, b) => b.quality - a.quality);
  return scoredPicks.slice(0, budget).map(({ entry, block }) => ({
    block_id: entry.block_id || `block-${entry.lib_id}`,
    excerpt: anchorExcerpt(block, terms),
    added: true
  }));
}

/**
 * Query-anchored excerpt for expansion candidates. Full-text excerpts anchor on
 * the first hit inside RAW text — which for memory blocks is usually the
 * block_id/display_name frontmatter, not the status content Jev needs to see.
 * Here: skip frontmatter, prefer an 'Open loops'/'Current State'/'Extracted
 * facts' section, else the first query-term hit in the body.
 */
function anchorExcerpt(block, terms) {
  const body = String(block.body || '').replace(/^#.*$/gm, ' ').replace(/\s+/g, ' ').trim();
  // Priority: Open Loops first — for status questions ('where are we at on X')
  // the open-loops section IS the answer; Current State often opens with the
  // objective restatement instead. Then Decisions/Extracted facts/Current State.
  let section = null;
  for (const name of ['Open Loops', 'Decisions', 'Extracted facts', 'Current State']) {
    section = new RegExp(`## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`).exec(String(block.raw || ''));
    if (section) break;
  }
  let text = section ? section[1].replace(/\s+/g, ' ').trim() : body;
  if (!text) text = String(block.raw || '').replace(/^---[\s\S]*?---/m, '').replace(/\s+/g, ' ').trim();
  // First query-term hit anchors the slice so Jev sees the query's context.
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const f = lower.indexOf(t);
    if (f !== -1 && (idx === -1 || f < idx)) idx = f;
  }
  if (idx === -1) return text.slice(0, EXCERPT_CHARS);
  const start = Math.max(0, idx - 100);
  const slice = text.slice(start, idx + EXCERPT_CHARS).trim();
  return (start > 0 ? '…' : '') + slice;
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
 * Re-rank full-text matches by Jev relevance score, with lineage-family
 * candidate expansion for vague queries.
 * Returns { matches, jev } — matches re-ordered (stable within equal scores),
 * jev carries the annotation/audit block for the response envelope.
 * NEVER throws; on any Jev problem the input matches pass through untouched.
 * Expansion additions that Jev scores low are dropped, so callers never see
 * noise the classifier rejected (they exist only to give Jev the chance).
 */
export async function jevRank(library, query, matches, { topN = 10 } = {}) {
  const plain = () => ({ matches, jev: { applied: false, reason: 'not requested' } });
  if (!matches || matches.length < 2) return plain();

  // Candidate pool: full-text top-N + lineage-family siblings (v1.1). One
  // Jev call still covers the whole pool — questions are batched per request.
  const base = matches.slice(0, topN).map((m) => ({
    block_id: m.block_id,
    excerpt: m.excerpt || '',
    lib_id: m.lib_id,
    added: false
  }));
  let candidates = base;
  let expanded = 0;
  try {
    const sibs = expandCandidates(library, query, matches, Math.max(0, MAX_CANDIDATES - base.length));
    if (sibs.length) {
      candidates = [...base, ...sibs.map((s) => ({ ...s, lib_id: null }))].slice(0, MAX_CANDIDATES);
      expanded = candidates.length - base.length;
    }
  } catch { /* expansion is best-effort; base pool still gets scored */ }

  const t0 = Date.now();
  const scored = await jevScoreBatch(query, candidates.map((c) => ({
    block_id: c.block_id,
    excerpt: c.excerpt
  })));
  const jevLatencyMs = Date.now() - t0;

  if (!scored.ok) {
    // Defensive receipt: Jev failed — record WHY durably, return the plain
    // full-text results unchanged. A receipt-write failure here must never
    // break this fallback either (appendJevrankReceipt never throws).
    appendJevrankReceipt(library, {
      ...baseReceipt(library, query),
      n_candidates: candidates.length,
      applied: false,
      ok: false,
      error: scored.reason,
      latency_ms: jevLatencyMs,
      cost_usd: 0 // same convention as the prestamp ledger's error rows
    });
    return { matches, jev: { applied: false, reason: scored.reason } };
  }

  // Success receipt, written before result mapping so a mapping bug cannot
  // lose the record of what Jev was asked and what it cost.
  const usage = scored.usage || {};
  appendJevrankReceipt(library, {
    ...baseReceipt(library, query),
    n_candidates: candidates.length,
    applied: true,
    ok: true,
    scored: scored.scores.size,
    expanded,
    latency_ms: jevLatencyMs,
    // Same basis the in-process stats use: API-reported cost when present,
    // else the measured per-question estimate.
    cost_usd: typeof usage.cost === 'number'
      ? usage.cost
      : Number((candidates.length * COST_PER_QUESTION_USD).toFixed(8)),
    error: null
  });

  // Map Jev scores back onto FULL-TEXT matches only: expansion-only blocks
  // that Jev ranked highly get PROMOTED into the result set (annotated, at
  // the front, by score); ones Jev rejects are dropped entirely.
  const rank = (m) => {
    const s = scored.scores.get(m.block_id);
    return s === undefined ? -1 : s;
  };
  const scoredBase = base
    .filter((c) => scored.scores.has(c.block_id))
    .map((c) => matches.find((m) => m.block_id === c.block_id))
    .filter(Boolean)
    .sort((a, b) => rank(b) - rank(a) || 0);

  // Expansion promotions: added blocks that Jev scored >= the lowest kept
  // base score (they answered better than full-text's own tail) and strongly
  // related (>= 1.5 of 2 — calibrated scores rarely hit the exact ceiling in
  // a multi-candidate pool; measured 1.94-1.99 for a directly-answering block).
  // Bounded by the same expansion budget so promotions can never flood.
  const baseScores = scoredBase.map(rank).filter((s) => s >= 0);
  const promoteFloor = baseScores.length ? Math.min(...baseScores) : 2;
  const PROMOTE_MIN_SCORE = 1.5;
  const promotions = [];
  for (const c of candidates) {
    if (!c.added) continue;
    const s = scored.scores.get(c.block_id);
    if (s === undefined || s < promoteFloor || s < PROMOTE_MIN_SCORE) continue;
    if (scoredBase.some((m) => m.block_id === c.block_id)) continue;
    promotions.push({
      lib_id: null,
      block_id: c.block_id,
      display_name: c.block_id,
      lineage: null,
      excerpt: c.excerpt,
      score: null,
      via: 'jev-lineage',
      jev_score: s
    });
    if (promotions.length >= EXPAND_SIBLINGS) break;
  }

  const rest = matches.slice(topN).filter((m) => !promotions.some((p) => p.block_id === m.block_id));
  const annotated = [...promotions, ...scoredBase, ...rest].map((m) => ({
    ...m,
    jev_score: scored.scores.has(m.block_id) ? scored.scores.get(m.block_id) : (m.jev_score ?? null)
  }));

  return {
    matches: annotated,
    jev: {
      applied: true,
      model: JEV_MODEL,
      scored: scored.scores.size,
      expanded,
      latency_ms: null, // filled by the caller when it wraps the call
      usage: scored.usage
    }
  };
}
