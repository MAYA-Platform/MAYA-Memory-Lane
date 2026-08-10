#!/usr/bin/env node
/**
 * observations.js — Observer + Observation Store for Memory Lane.
 *
 * Part of the Auto-Observation pipeline (Observer → Store → Distiller →
 * Injector). This module is Phase 0: deterministic, zero-LLM, zero-dependency.
 *
 * The Observer watches conversation messages and captures *durable signals*
 * (decisions, corrections, preferences, instructions, boundaries, facts,
 * identity, state) as bounded observations. The Store persists them
 * append-only in an auditable JSONL ledger at the library root and exposes an
 * in-memory FTS5 index for search (same pattern as the block store).
 *
 * Privacy rule (from AUTO_OBSERVATION_SPEC.md): observations store bounded
 * excerpts + references, never full transcripts.
 *
 * Signal classes and weights (mirrors the durable-signal taxonomy):
 *   decision/correction/boundary = high; instruction = high;
 *   preference/fact/identity = medium; state = low (never canonized).
 */

import fs from 'node:fs';
import path from 'node:path';

const OBS_FILE = 'observations.jsonl';
const OBS_LEDGER = 'OBSERVATIONS.md';

// ---------------------------------------------------------------------------
// Signal detectors — deterministic phrase patterns. Explicit self-report
// outranks inferred cues. Typos and slang are ignored (proven principle).
// ---------------------------------------------------------------------------

const CLASS_WEIGHTS = {
  decision: 3,
  correction: 3,
  boundary: 3,
  instruction: 3,
  preference: 2,
  fact: 2,
  identity: 2,
  state: 1, // low weight, never canonized
};

const DETECTORS = [
  {
    cls: 'boundary',
    weight: 3,
    patterns: [
      /\bdon'?t (?:touch|ever|go near|open|delete|move|share)\b/i,
      /\boff[- ]limits\b/i,
      /\bnever without (?:asking|checking|permission)\b/i,
      /\bdo not (?:touch|ever|mess with)\b/i,
      /\bkeep (?:that|this) (?:private|secret)\b/i,
    ],
  },
  {
    cls: 'decision',
    weight: 3,
    patterns: [
      /\b(?:we'?re|we are) (?:going|gonna|going to go) with\b/i,
      /\blet'?s (?:go with|do that|use)\b/i,
      /\b(?:decided|decision|going with|we'?ll use|we will use)\b/i,
      /\b(?:that'?s|that is) the (?:plan|call|direction)\b/i,
      /\bok (?:let'?s|we'?ll) (?:do|go|build)\b/i,
    ],
  },
  {
    cls: 'correction',
    weight: 3,
    patterns: [
      /\bno,? (?:do it like|it'?s|actually|that'?s not)\b/i,
      /\bthat'?s wrong\b/i,
      /\bstop (?:doing|that)\b/i,
      /\bnot (?:like|the way) (?:that|this)\b/i,
      /\bdon'?t (?:do it|say) (?:that|like that)\b/i,
      /\b(?:wrong|incorrect|mistake)\b/i,
    ],
  },
  {
    cls: 'instruction',
    weight: 3,
    patterns: [
      /\bfrom now on\b/i,
      /\balways (?:remember|make sure|do|use)\b/i,
      /\bnever (?:do|use|say|forget)\b/i,
      /\bmake sure (?:you|to)\b/i,
      /\bremember to\b/i,
      /\bdo not (?:skip|forget|stop)\b/i,
    ],
  },
  {
    cls: 'preference',
    weight: 2,
    patterns: [
      /\bi (?:prefer|want|like|love|hate|need|really (?:like|want))\b/i,
      /\bi'?d (?:rather|prefer)\b/i,
      /\bnever (?:again|ever)\b/i,
      /\b(?:favorite|favourite) (?:is|was)\b/i,
    ],
  },
  {
    cls: 'identity',
    weight: 2,
    patterns: [
      /\bi'?m (?:a|an|the) (?:founder|builder|developer|engineer|designer|owner|ceo|operator)\b/i,
      /\bi (?:work as|run|build|founded|started|own)\b/i,
      /\bmy (?:role|company|business|job) (?:is|was)\b/i,
      /\bwe are (?:building|a company)\b/i,
    ],
  },
  {
    cls: 'fact',
    weight: 2,
    patterns: [
      /\bi (?:have|got|bought|moved|started|finished|installed|set up|signed up for|created)\b/i,
      /\bmy (?:car|phone|laptop|house|apartment|pet|dog|cat|computer|server|pc)\b/i,
      /\bi (?:live|work|drive|use|own) (?:in|at|on|a|an|the)\b/i,
      /\b(?:today|yesterday|last week|this week) i\b/i,
    ],
  },
  {
    cls: 'state',
    weight: 1,
    patterns: [
      /\bi'?m (?:tired|sick|in pain|exhausted|stressed|broke|hurting|injured|drunk|impaired)\b/i,
      /\bi (?:feel|felt) (?:terrible|awful|great|good|bad)\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Store — append-only JSONL ledger + FTS5 index
// ---------------------------------------------------------------------------

function obsPath(library) {
  const root = library.rootDir || (library.ok && library.rootDir) || '';
  return root ? path.join(root, OBS_FILE) : null;
}

function normalizeExcerpt(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function dedupKey(obs) {
  // class + normalized stem (first 80 chars, punctuation stripped, collapsed) —
  // dedups near-identical captures of the same signal. Extraction is
  // deterministic in the Observer, so re-observing the same signal should
  // collapse to one entry.
  const stem = obs.excerpt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${obs.cls}:${stem}`;
}

/**
 * Observe one message. Deterministic, inline, cheap (<100ms).
 * Returns the observation or null if no durable signal was detected.
 */
export function observeMessage(library, { speaker, content, session_id, message_id, timestamp, source_ref }) {
  const text = String(content || '');
  if (text.trim().length < 8) return null;

  const hits = [];
  for (const d of DETECTORS) {
    for (const p of d.patterns) {
      const m = p.exec(text);
      if (m) {
        hits.push({ cls: d.cls, weight: d.weight, idx: m.index });
        break; // one match per class per message is enough
      }
    }
  }
  if (!hits.length) return null;

  // Highest-weight class wins when multiple hit (decision over fact, etc.)
  hits.sort((a, b) => b.weight - a.weight || a.idx - b.idx);
  const cls = hits[0].cls;

  const obs = {
    timestamp: timestamp || new Date().toISOString(),
    speaker: speaker || 'unknown',
    session_id: session_id || null,
    message_id: message_id || null,
    cls,
    weight: CLASS_WEIGHTS[cls],
    excerpt: normalizeExcerpt(text),
    confidence: hits[0].weight >= 3 ? 'high' : hits[0].weight === 2 ? 'medium' : 'low',
    source_ref: source_ref || null,
  };

  // State signals are captured but marked ephemeral — never canonized.
  if (cls === 'state') obs.ephemeral = true;

  appendObservation(library, obs);
  return obs;
}

/** Append an observation to the ledger (dedup on normalized content). */
export function appendObservation(library, obs) {
  const file = obsPath(library);
  if (!file) return false;
  // dedup: read recent keys (last 500 entries) and skip if this is a near-duplicate
  const existing = readObservations(library);
  const seen = new Set(existing.slice(-500).map(dedupKey));
  if (seen.has(dedupKey(obs))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obs) + '\n', 'utf8');
  return true;
}

/** Read all observations from the ledger, oldest first. */
export function readObservations(library) {
  const file = obsPath(library);
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Count observations by class. */
export function observationStats(library) {
  const obs = readObservations(library);
  const byClass = {};
  for (const o of obs) byClass[o.cls] = (byClass[o.cls] || 0) + 1;
  return { total: obs.length, byClass };
}

/**
 * Search observations (in-memory FTS5 or substring fallback).
 * Returns [{ timestamp, cls, excerpt, session_id, source_ref, score }].
 */
export function searchObservations(library, query, { limit = 10 } = {}) {
  const obs = readObservations(library);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return obs.slice(-limit).reverse();
  const scored = [];
  for (const o of obs) {
    const hay = (o.excerpt + ' ' + (o.cls || '') + ' ' + (o.source_ref || '')).toLowerCase();
    let score = 0;
    for (const term of q.split(/\s+/)) {
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ ...o, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Write a human-readable observation ledger (audit surface). */
export function writeObservationLedger(library) {
  const root = library.rootDir || (library.ok && library.rootDir) || '';
  if (!root) return null;
  const obs = readObservations(library);
  const byClass = observationStats(library);
  const lines = [
    '# Observations ledger (auto-captured durable signals)',
    '',
    `Total: ${byClass.total}`,
    '',
    '| # | When | Class | Confidence | Excerpt |',
    '|---|---|---|---|---|',
  ];
  obs.slice(-200).forEach((o, i) => {
    const excerpt = o.excerpt.slice(0, 90).replace(/\|/g, '\\|');
    lines.push(`| ${i + 1} | ${o.timestamp.slice(0, 16)} | ${o.cls} | ${o.confidence} | ${excerpt} |`);
  });
  const out = path.join(root, OBS_LEDGER);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  return out;
}

export { CLASS_WEIGHTS, DETECTORS };
