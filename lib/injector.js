#!/usr/bin/env node
/**
 * injector.js — Injector for the Auto-Observation pipeline.
 *
 * At session start, answer: "what matters right now?" — select the most
 * relevant observations and derived facts into a compact distilled snapshot.
 *
 * Selection scoring (from AUTO_OBSERVATION_SPEC.md §4.4):
 *   - Recency  — what changed recently
 *   - Salience — class weight (decision/correction/boundary > preference > state)
 *   - Entity match — derived facts matching session topics / pinned context
 *   - User pins — explicit "always remember this"
 *
 * Budget: a compact distilled snapshot (~2–4K chars), never raw history.
 *
 * IMPORTANT: the output contract is drop-in identical to the hosted service's
 * injection (peer card + recent salient signals). Swapping the hosted service
 * for this injector requires NO runtime changes on the consumer side.
 */

import { readObservations, CLASS_WEIGHTS } from './observations.js';

const DEFAULT_BUDGET = 3500;

function recencyScore(ts, now = Date.now()) {
  if (!ts) return 0;
  const ageMs = now - new Date(ts).getTime();
  if (ageMs < 0) return 1;
  // decay: 1 at t=0 -> ~0.1 at 30 days
  return Math.max(0, 1 - ageMs / (30 * 24 * 3600 * 1000));
}

function salienceScore(obs) {
  return CLASS_WEIGHTS[obs.cls] || 1;
}

/**
 * Select the top observations for a session-start snapshot.
 * Returns { snapshot, selected: [...] } where snapshot is the compact string.
 */
export function buildSnapshot(library, {
  topics = [],
  pins = [],
  budget = DEFAULT_BUDGET,
  now = Date.now(),
  includeDerived = true,
  derived = null,
} = {}) {
  const obs = readObservations(library);
  const selected = [];

  // 1. Pins always win.
  const pinnedSet = new Set(pins.map((p) => p.toLowerCase()));
  for (const o of obs) {
    const ex = o.excerpt.toLowerCase();
    if (pinnedSet.size && [...pinnedSet].some((p) => ex.includes(p))) {
      selected.push({ ...o, why: 'pinned' });
    }
  }

  // 2. Score the rest by recency + salience + topic match.
  const topicTerms = topics
    .map((t) => String(t).toLowerCase())
    .filter((t) => t.length > 2);
  for (const o of obs) {
    if (selected.includes(o)) continue;
    const ex = o.excerpt.toLowerCase();
    const topicHit = topicTerms.length && topicTerms.some((t) => ex.includes(t));
    const score = recencyScore(o.timestamp, now) * 0.5 + salienceScore(o) * 0.3 + (topicHit ? 2.0 : 0);
    selected.push({ ...o, why: topicHit ? 'topic' : 'salient', score });
  }

  // 3. Sort: pins first, then score desc, then recency.
  selected.sort((a, b) => {
    if (a.why === 'pinned' && b.why !== 'pinned') return -1;
    if (b.why === 'pinned' && a.why !== 'pinned') return 1;
    return (b.score || 0) - (a.score || 0) || (recencyScore(b.timestamp, now) - recencyScore(a.timestamp, now));
  });

  // 4. Budget pack: fill until the char budget, skipping ephemeral state by default.
  const parts = [];
  let used = 0;
  for (const o of selected) {
    if (o.ephemeral && !pins.includes(o.cls)) continue;
    const line = `[${o.cls}] ${o.excerpt}`;
    if (used + line.length > budget) break;
    parts.push(line);
    used += line.length + 1;
  }

  let snapshot = parts.length
    ? 'SESSION SNAPSHOT (from memory):\n' + parts.join('\n')
    : 'SESSION SNAPSHOT (from memory): (no durable signals captured yet)';

  // 5. Derived facts (profile-level memory) — highest value, appended if room.
  if (includeDerived && derived && derived.length) {
    const derivedBlock = '\n\nDERIVED PROFILE:\n' + derived.slice(0, 10).map((d) => '- ' + d).join('\n');
    if (used + derivedBlock.length <= budget + 2000) {
      snapshot += derivedBlock;
    }
  }

  return { snapshot, selected, charCount: snapshot.length };
}

/**
 * The hosted-service-compatible injection: a single string a consumer can drop
 * into context. Contract is identical to Honcho's peer context injection.
 */
export function injectForSession(library, opts = {}) {
  const { snapshot } = buildSnapshot(library, opts);
  return snapshot;
}

export { DEFAULT_BUDGET };
