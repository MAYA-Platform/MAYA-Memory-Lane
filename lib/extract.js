#!/usr/bin/env node
/**
 * Memory Lane - automatic fact extraction (v4, 2026-10-13, Jev-pure).
 *
 * Turns a raw transcript into durable, searchable facts WITHOUT a prose LLM.
 * Pipeline:
 *   1. Deterministic candidate split: transcript -> one candidate fact per
 *      sentence/line (regex tokenizer).
 *   2. ONE batched Jev decisions call (typesafe/jev-1.13 via Merge): every
 *      candidate gets a SCORE question - "chatter vs. usable vs. durable".
 *      Jev does the math and moves on; no free text is ever generated.
 *   3. Survivors (score >= 1 on the 0-2 scale) become the block's facts.
 *   4. Degrade path: no Merge key, no candidates, or Jev failure/timeout ->
 *      keep the deterministic candidates as facts and seal the block. A
 *      memory is NEVER blocked on extraction (hard rule since v1).
 *
 * Removed by founder order (2026-10-13): DeepSeek-direct chat lane, local
 * Ollama chat lane. ML never talks to a prose model again.
 *
 * parseFactList stays exported: it is the deterministic legacy splitter used
 * by the ingest test + the benchmark harness's transcript loader.
 */

import fs from 'node:fs';
import { appendBlock } from './memoryLaneCore.js';
import { jevKeyStatus, jevScoreQuestions } from './jevrank.js';

/**
 * Resolve the Jev decisions configuration for extraction.
 * Returns { ok, reason, backend, keySource } for observability. The key
 * never leaves the resolved module (same discipline as jevrank.resolveJevKey).
 */
export function resolveExtractConfig() {
  const st = jevKeyStatus();
  return { ok: st.available, reason: st.reason, backend: 'jev', keySource: st.keySource };
}

/**
 * Deterministic legacy fact-list parser (tests + benchmark harness).
 * Tolerates "1. fact", "1) fact", "- fact", and bare lines. Drops blank
 * lines and obviously-not-fact lines.
 */
export function parseFactList(content) {
  const cleaned = String(content || '')
    // Strip any think-tag spill before splitting (defensive, near-zero cost).
    .replace(/ spiral[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '');
  return cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 2 && !/^(here|the|facts|output|below|above|list|note|transcript)/i.test(l) && !/^---/.test(l));
}

/**
 * Deterministic candidate splitter. One candidate per sentence-like unit,
 * bounded for the Jev batch. Filters obvious non-facts (greetings,
 * one-word fragments). This is the ONLY text-understanding step - no model.
 */
export function candidateFacts(transcript, { maxCandidates = 30 } = {}) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const units = text
    .split(/(?<=[.!?;])\s+|\r?\n+/)
    .map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 240 && s.includes(' ') && /[A-Za-z]/.test(s))
    .filter((s) => !/^(hi|hey|hello|thanks|thank you|ok|okay|cool|nice|bye|night)\b/i.test(s));
  const seen = new Set();
  const out = [];
  for (const s of units) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

/**
 * Call Jev to keep only durable facts among the candidates. Returns
 * { ok, facts, error } - ok=false NEVER throws; callers degrade to the
 * deterministic candidates.
 */
export async function extractFacts(transcript, { maxLen = 24000, timeoutMs = 120000 } = {}) {
  const cfg = resolveExtractConfig();
  const text = String(transcript || '').trim().slice(0, maxLen);
  if (!text) return { ok: true, facts: [], error: null, candidates: 0 };

  const candidates = candidateFacts(text);
  if (!candidates.length) return { ok: true, facts: [], error: null, candidates: 0 };

  if (!cfg.ok) {
    // No Jev key available - deterministic candidates win (memory still sealed).
    return { ok: false, facts: candidates, error: cfg.reason, candidates: candidates.length, degraded: true };
  }
  try {
    const sc = await jevScoreQuestions(text, candidates, { timeoutMs: 8000 });
    if (!sc.ok) {
      return { ok: false, facts: candidates, error: sc.reason, candidates: candidates.length, degraded: true };
    }
    // Score scale (matches the criteria row order sent to Jev): 0 = chatter,
    // 1 = usable fact line, 2 = durable searchable fact. Keep 1-2, drop 0.
    const keep = [];
    for (const [i, c] of candidates.entries()) {
      const v = sc.scores.get(`${i}`);
      if (v === undefined || v === null) { keep.push(c); continue; }
      if (v >= 1) keep.push(c);
    }
    return { ok: true, facts: keep, error: null, candidates: candidates.length, jev: { scored: sc.scores.size, model: sc.model } };
  } catch (err) {
    return { ok: false, facts: candidates, error: String(err && err.message ? err.message : err), candidates: candidates.length, degraded: true };
  }
}

/**
 * Ingest helper: extract facts then append a block. One call does the whole
 * pipeline so the CLI, server, and cron all share the same behavior.
 * Returns the appendBlock() result enriched with extraction info.
 */
export async function ingestTranscript(rootDir, {
  title = 'Memory block',
  body = '',
  source = null,
  lineage = 'auto',
  extract = true,
  facts = null
} = {}) {
  let extraction = { ok: false, facts: [], error: 'extract disabled' };
  let usedFacts = Array.isArray(facts) ? facts : [];
  if (extract) {
    extraction = await extractFacts(body);
    usedFacts = extraction.facts || [];
  }
  const result = appendBlock(rootDir, { title, body, facts: usedFacts, source, lineage });
  return { ...result, extraction };
}
