#!/usr/bin/env node
/**
 * Memory Lane — graph layer (HippoRAG-patterns-lite, 2026-09-12).
 *
 * A deterministic, zero-LLM knowledge-graph lane over the block library:
 *
 *   1. EXTRACTION  — subject-relation-object triples pulled from block text
 *                    with a fixed relation lexicon and positional rules.
 *                    Same block in, same triples out. No model, no cost.
 *   2. INDEX       — in-memory SQLite `fact_edges` table (with a token
 *                    inverted index) built per loadLibrary, WeakMap-cached
 *                    exactly like the FTS5 index. Files stay the source of
 *                    truth; the graph is a disposable projection.
 *   3. WALK        — bounded retrieval: query tokens match edges (1-hop),
 *                    matched edges expose bridge entities, bridge entities'
 *                    other edges get a dampened boost (2-hop). Caps keep the
 *                    walk O(bounded) no matter how dense the graph is.
 *
 * The walk never replaces lexical search — it fuses with it via reciprocal
 * rank fusion in search() (memoryLaneCore.js). Graph-only hits rescue blocks
 * that share an entity with a matched block but none of the query's words.
 */

import { readBlock, tokenizeQuery } from './memoryLaneCore.js';

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Single-token relation triggers. Two-token relations (verb + preposition)
// are handled by the PREP set below.
const RELATIONS = new Set([
  // copula / possession
  'is', 'are', 'was', 'were', 'has', 'have', 'had',
  // preference / affect
  'likes', 'like', 'loves', 'love', 'enjoys', 'enjoy', 'prefers', 'prefer',
  'hates', 'hate', 'dislikes', 'dislike', 'avoids', 'avoid', 'favorite', 'favourite',
  // routine / state
  'uses', 'use', 'works', 'work', 'lives', 'live', 'owns', 'own', 'plays',
  'play', 'wears', 'wear', 'drives', 'drive', 'eats', 'eat', 'drinks',
  'drink', 'watches', 'watch', 'reads', 'read', 'runs', 'run', 'speaks',
  'speak', 'studies', 'study', 'studied', 'teaches', 'teach', 'taught',
  'learns', 'learn', 'learned', 'manages', 'manage', 'leads', 'lead', 'got', 'get',
  // events / changes
  'leased', 'lease', 'bought', 'buy', 'sold', 'sell', 'rents', 'rent',
  'hired', 'hire', 'fired', 'joined', 'join', 'visited', 'visit', 'met',
  'meet', 'knows', 'know', 'knew', 'recommended', 'recommend', 'recommends',
  'plans', 'plan', 'planned', 'decided', 'decide', 'chose', 'choose',
  'moved', 'move', 'attends', 'attend', 'attended', 'traveled', 'travel',
  'married', 'dated', 'divorced', 'graduated', 'booked', 'book', 'reserved',
  'reserve', 'canceled', 'cancel', 'cancelled', 'completed', 'complete',
  'finished', 'finish', 'started', 'start', 'launched', 'launch', 'shipped',
  'ship', 'adopted', 'adopt', 'named', 'name', 'called', 'call', 'gave',
  'give', 'took', 'take', 'made', 'make', 'found', 'find', 'brought',
  'bring', 'sent', 'send', 'paid', 'pay', 'owes', 'owe', 'borrowed',
  'borrow', 'lent', 'lend', 'fixed', 'fix', 'repaired', 'repair', 'broke',
  'break', 'opened', 'open', 'closed', 'close', 'scheduled', 'schedule',
  'subscribed', 'subscribe', 'donated', 'donate', 'volunteered', 'volunteer',
  'celebrated', 'celebrate', 'missed', 'miss', 'won', 'win', 'lost', 'lose',
  'failed', 'fail', 'passed', 'pass', 'quit', 'kept', 'keep', 'parked', 'park',
  'member', 'friends', 'colleague', 'birthday'
]);

// Prepositions that extend a trigger into a two-token relation
// ("works at", "lives in", "moved to", "friends with", "member of").
const PREPS = new Set(['at', 'for', 'in', 'on', 'to', 'with', 'from', 'of', 'about', 'near']);

// Copula set — triggers the possessive split ("emily sister is katie" ->
// subject=emily, relation=has_sister, object=katie).
const COPULAS = new Set(['is', 'are', 'was', 'were']);

// Words that never deserve to be an edge endpoint on their own.
const SUBJECT_FILLERS = new Set([
  'so', 'and', 'also', 'then', 'well', 'now', 'basically', 'actually',
  'just', 'really', 'very', 'today', 'yesterday', 'tomorrow', 'hey', 'ok',
  'okay', 'yeah', 'yes', 'maybe', 'probably', 'definitely', 'though',
  'although', 'however', 'because', 'since', 'while', 'when', 'if', 'but', 'the', 'a', 'an'
]);

// Clause breakers that end the object phrase.
const OBJECT_BREAKS = new Set([
  'but', 'because', 'since', 'which', 'that', 'however', 'although',
  'though', 'so', 'and', 'or', 'when', 'while', 'if', 'as', 'after',
  'before', '.', ',', ';', ':'
]);

const CLAUSE_PUNCT = /[.,;:!?"()]/g;

function normalizeSubject(tokens) {
  // Drop leading fillers, cap at 3 tokens, normalize 'user' -> 'i'.
  const out = [];
  for (const t of tokens) {
    if (out.length === 0 && SUBJECT_FILLERS.has(t)) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  // Trailing fillers/adverbs ("alex also") are not part of the entity.
  while (out.length && SUBJECT_FILLERS.has(out[out.length - 1])) out.pop();
  if (!out.length) return null;
  const phrase = out.join(' ');
  return (phrase === 'user' || phrase === 'the user') ? 'i' : phrase;
}

function normalizeObject(tokens) {
  // Cut at clause breakers, cap at 6 tokens, trim edge stopwords.
  const out = [];
  for (const t of tokens) {
    if (OBJECT_BREAKS.has(t)) break;
    out.push(t);
    if (out.length >= 6) break;
  }
  while (out.length && SUBJECT_FILLERS.has(out[0])) out.shift();
  while (out.length && (SUBJECT_FILLERS.has(out[out.length - 1]) || out[out.length - 1] === 'the' || out[out.length - 1] === 'a')) out.pop();
  if (!out.length) return null;
  return out.join(' ');
}

/**
 * Extract deterministic (subject, relation, object) triples from a block's
 * raw markdown. Frontmatter is skipped; sentences are split on punctuation
 * and newlines. Returns [{ subject, relation, object }] with at most
 * `maxEdges` unique triples, in first-appearance order.
 */
export function extractTriples(text, { maxEdges = 64 } = {}) {
  const triples = [];
  const seen = new Set();
  const stripped = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const sentences = stripped
    .split(/(?:[.!?]+|\n)+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && s.length < 240);

  for (const sent of sentences) {
    if (triples.length >= maxEdges) break;
    const toks = sent.toLowerCase().replace(CLAUSE_PUNCT, ' ').replace(/'s\b/g, '').split(/\s+/).filter(Boolean);
    if (toks.length < 3 || toks.length > 48) continue;

    // Find ALL relation triggers per sentence (conjunctions carry a second
    // edge: "Alex leased a Civic and loves hiking" -> two triples).
    let vi = -1;
    let found = 0;
    let firstSubject = null;
    let prevObject = null;
    for (let i = 0; i < toks.length && found < 3; i++) {
      if (RELATIONS.has(toks[i])) {
        let r;
        if (i + 1 < toks.length && PREPS.has(toks[i + 1]) && !COPULAS.has(toks[i])) {
          r = `${toks[i]} ${toks[i + 1]}`;
        } else {
          r = toks[i];
        }
        let subj = normalizeSubject(toks.slice(vi === -1 ? 0 : vi + 1, i));
        const obj = normalizeObject(toks.slice(i + 1 + (r.includes(' ') ? 1 : 0)));
        // Conjunction carry-over: "Alex leased a Civic and loves hiking" —
        // the span before the second trigger is the previous object, so the
        // real subject is the sentence's first subject.
        if (firstSubject && (!subj || (prevObject && (prevObject.includes(subj) || subj.includes(prevObject))))) {
          subj = firstSubject;
        }
        if (subj && obj && subj !== obj && subj.length >= 2 && obj.length >= 2) {
          let s = subj, relation = r, o = obj;
          // Possessive copula: "emily sister is katie" -> has_sister edge.
          if (COPULAS.has(r) && s.includes(' ')) {
            const parts = s.split(' ');
            s = parts[0];
            relation = `has_${parts.slice(1).join('_')}`;
            o = normalizeObject(toks.slice(i + 1));
          }
          const key = `${s}|${relation}|${o}`;
          if (!seen.has(key)) {
            seen.add(key);
            triples.push({ subject: s, relation, object: o });
            if (triples.length >= maxEdges) break;
          }
          if (!firstSubject) firstSubject = s;
          prevObject = o;
        }
        found++;
        if (vi === -1) vi = i;
      }
    }
    if (vi === -1) continue;
  }
  return triples;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const GRAPH_CACHE = new WeakMap();

function loadSqlite() {
  try {
    if (process.getBuiltinModule) {
      const mod = process.getBuiltinModule('node:sqlite');
      if (mod && typeof mod.DatabaseSync === 'function') return mod;
    }
  } catch {}
  return null;
}

/**
 * Build (or fetch cached) the fact-edge graph for a library. In-memory
 * SQLite: fact_edges row per triple plus an edge_tokens inverted index so
 * query-time lookups stay O(matched tokens), never a full scan. WeakMap
 * cached per library object — rebuilt on every loadLibrary, never stale.
 */
export function getGraphIndex(library) {
  const cached = GRAPH_CACHE.get(library);
  if (cached) return cached;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE fact_edges (
      edge_id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      lib_id INTEGER NOT NULL
    );
    CREATE TABLE edge_tokens (
      token TEXT NOT NULL,
      edge_id INTEGER NOT NULL,
      field INTEGER NOT NULL
    );
    CREATE INDEX idx_et_token ON edge_tokens(token);
    CREATE INDEX idx_fe_subject ON fact_edges(subject);
    CREATE INDEX idx_fe_object ON fact_edges(object);
  `);
  const insertEdge = db.prepare('INSERT INTO fact_edges (subject, relation, object, lib_id) VALUES (?, ?, ?, ?)');
  const insertTok = db.prepare('INSERT INTO edge_tokens (token, edge_id, field) VALUES (?, ?, ?)');

  const edges = new Map(); // edge_id -> { subject, relation, object, lib_id }
  let edgeCount = 0;
  let blocksWithEdges = 0;

  for (const entry of library.blocks) {
    const block = readBlock(library, entry.lib_id);
    if (!block || !block.present) continue;
    const triples = extractTriples(block.raw);
    if (!triples.length) continue;
    blocksWithEdges++;
    for (const t of triples) {
      const info = insertEdge.run(t.subject, t.relation, t.object, entry.lib_id);
      const eid = Number(info.lastInsertRowid);
      edges.set(eid, { ...t, lib_id: entry.lib_id });
      edgeCount++;
      // Token inverted index: field 0=subject, 1=relation, 2=object.
      const fields = [
        [t.subject, 0],
        [t.relation, 1],
        [t.object, 2]
      ];
      for (const [phrase, field] of fields) {
        const seenTok = new Set();
        for (const tok of tokenizeQuery(phrase)) {
          if (seenTok.has(tok)) continue;
          seenTok.add(tok);
          insertTok.run(tok, eid, field);
        }
      }
    }
  }

  const index = {
    db,
    edges,
    edgeCount,
    blocksWithEdges,
    tokenLookup: db.prepare('SELECT edge_id, field FROM edge_tokens WHERE token = ? LIMIT 500'),
    bySubject: db.prepare('SELECT edge_id FROM fact_edges WHERE subject = ? LIMIT 200'),
    byObject: db.prepare('SELECT edge_id FROM fact_edges WHERE object = ? LIMIT 200'),
    df: (() => {
      const m = new Map();
      for (const row of db.prepare('SELECT token, COUNT(DISTINCT edge_id) AS df FROM edge_tokens GROUP BY token').all()) {
        m.set(row.token, Number(row.df));
      }
      return m;
    })()
  };
  GRAPH_CACHE.set(library, index);
  return index;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

// Walk bounds — the graph can be dense; the walk must not be.
const MAX_CANDIDATE_EDGES = 2000;
const MAX_BRIDGE_ENTITIES = 60;
const MAX_NEIGHBOR_LOOKUPS = 400;
const NEIGHBOR_BOOST = 0.4; // dampened 2-hop contribution
// A token appearing in more than this fraction of edges carries no entity
// signal (e.g. "like", "make") — matching it would flood the walk. The
// absolute floor keeps tiny graphs (tests, fresh libraries) usable.
const SATURATION_FRACTION = 0.05;
const SATURATION_FLOOR = 50;

/**
 * Run the bounded walk for a query. Returns ranked lib_ids with graph
 * scores: [{ lib_id, score }] best-first, plus stats for debugging.
 * Pure graph lane — fusion with FTS happens in search().
 */
export function graphSearch(library, query, { limit = 25, degreeNorm = false, conjunctionBonus = false, neighborBoost = NEIGHBOR_BOOST } = {}) {
  const index = getGraphIndex(library);
  if (!index || !index.edgeCount) return { count: 0, matches: [], stats: { matched: 0, expanded: 0 } };
  const qterms = tokenizeQuery(query);
  if (!qterms.length) return { count: 0, matches: [], stats: { matched: 0, expanded: 0 } };

  // IDF weights: rare tokens are strong entity signal, saturated tokens
  // (present in >5% of edges) are skipped entirely.
  const totalEdges = Math.max(1, index.edgeCount);
  const idf = new Map();
  const kept = [];
  for (const tok of qterms) {
    const df = index.df.get(tok) || 0;
    if (df > SATURATION_FLOOR && df / totalEdges > SATURATION_FRACTION) continue;
    kept.push(tok);
    idf.set(tok, Math.log(1 + totalEdges / (1 + df)));
  }
  if (!kept.length) return { count: 0, matches: [], stats: { matched: 0, expanded: 0 } };

  // 1-hop: edges sharing any kept token with the query. Subject/object
  // matches count double (entity identity beats relation wording), and the
  // token's IDF scales the contribution so rare entities dominate.
  const edgeScores = new Map();
  for (const tok of kept) {
    const w0 = idf.get(tok);
    for (const row of index.tokenLookup.all(tok)) {
      const eid = Number(row.edge_id);
      const w = (row.field === 1 ? 1 : 2) * w0;
      edgeScores.set(eid, (edgeScores.get(eid) || 0) + w);
    }
    if (edgeScores.size >= MAX_CANDIDATE_EDGES) break;
  }

  // 2-hop: endpoints of matched edges are bridge entities; their other
  // edges get a dampened boost even though they share no query token.
  const bridgeEntities = [];
  const seenEntity = new Set();
  const ordered = [...edgeScores.entries()].sort((a, b) => b[1] - a[1]);
  for (const [eid] of ordered) {
    if (bridgeEntities.length >= MAX_BRIDGE_ENTITIES) break;
    const e = index.edges.get(eid);
    if (!e) continue;
    for (const ent of [e.subject, e.object]) {
      if (!seenEntity.has(ent)) {
        seenEntity.add(ent);
        bridgeEntities.push(ent);
      }
    }
  }

  const neighborEdges = new Set();
  let lookups = 0;
  for (const ent of bridgeEntities) {
    if (lookups >= MAX_NEIGHBOR_LOOKUPS) break;
    for (const row of index.bySubject.all(ent)) {
      const eid = Number(row.edge_id);
      if (!edgeScores.has(eid)) neighborEdges.add(eid);
      lookups++;
    }
    for (const row of index.byObject.all(ent)) {
      const eid = Number(row.edge_id);
      if (!edgeScores.has(eid)) neighborEdges.add(eid);
      lookups++;
    }
    if (lookups >= MAX_NEIGHBOR_LOOKUPS) break;
  }

  // Aggregate per block. Optional degree normalization: dense hub blocks
  // (generic assistant chatter) accumulate score from many weak edges; a
  // block that matches with few edges from a big total is noise, one that
  // concentrates its matches is signal.
  const libScores = new Map();
  const libEdgeCount = new Map();
  for (const [eid, sc] of edgeScores) {
    const e = index.edges.get(eid);
    if (!e) continue;
    libScores.set(e.lib_id, (libScores.get(e.lib_id) || 0) + sc);
    libEdgeCount.set(e.lib_id, (libEdgeCount.get(e.lib_id) || 0) + 1);
  }
  for (const eid of neighborEdges) {
    const e = index.edges.get(eid);
    if (!e) continue;
    libScores.set(e.lib_id, (libScores.get(e.lib_id) || 0) + neighborBoost);
    libEdgeCount.set(e.lib_id, (libEdgeCount.get(e.lib_id) || 0) + 1);
  }
  if (degreeNorm) {
    for (const [libId, sc] of libScores) {
      libScores.set(libId, sc / Math.sqrt(Math.max(1, libEdgeCount.get(libId))));
    }
  }
  if (conjunctionBonus) {
    // Blocks matched by MULTIPLE distinct query tokens are far more likely
    // to be on-topic than blocks matched by one token many times.
    const tokSets = new Map();
    for (const [eid] of edgeScores) {
      const e = index.edges.get(eid);
      if (!e) continue;
      if (!tokSets.has(e.lib_id)) tokSets.set(e.lib_id, new Set());
      const set = tokSets.get(e.lib_id);
      for (const tok of kept) {
        const phrase = `${e.subject} ${e.relation} ${e.object}`;
        if (phrase.includes(tok)) set.add(tok);
      }
    }
    for (const [libId, toks] of tokSets) {
      if (toks.size > 1) libScores.set(libId, (libScores.get(libId) || 0) * (1 + 0.5 * (toks.size - 1)));
    }
  }

  const ranked = [...libScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([lib_id, score]) => ({ lib_id, score }));

  return {
    count: ranked.length,
    matches: ranked,
    stats: { matched: edgeScores.size, expanded: neighborEdges.size, edges: index.edgeCount }
  };
}
