#!/usr/bin/env node
/**
 * Memory Lane — core library reader.
 *
 * Reads a Memory Lane library from disk (files are the canonical truth) and
 * exposes the operations the Memory Lane UI needs:
 *
 *   - loadLibrary()        read MANIFEST.json + shelf manifests
 *   - readBlock()          read one block file (frontmatter + markdown)
 *   - verifyChain()        recompute SHA-256 per block and walk prev links
 *   - search()             full-text search across block bodies
 *   - resolveResume()      find the block(s) a resume phrase points at
 *   - exportLibrary()      deterministic JSON bundle of the whole library
 *
 * Zero dependencies. Files stay the source of truth; nothing here writes to
 * the library. The UI is a window over the files, never a replacement for
 * them — if the index dies, Memory Lane rebuilds everything from the chain.
 *
 * Search (v2, 2026-08-04): uses SQLite FTS5 (via built-in node:sqlite) for
 * BM25-ranked full-text search with prefix matching, stopword stripping and
 * quoted-phrase support. Falls back to the original substring scan when
 * node:sqlite is unavailable (Node < 22.5), so the library still works
 * everywhere — just with weaker search.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// FTS5 index cache: WeakMap keyed by the library object, so each loadLibrary
// builds a fresh index and no stale cache can survive a file change.
const FTS_CACHE = new WeakMap();

// Common English stopwords — words that add no retrieval signal. Stripping
// them keeps the FTS query tight (AND-chaining content words is more precise
// than AND-chaining "the"/"did"/"my").
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
  'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'can', 'will', 'would', 'should', 'could',
  'may', 'might', 'must', 'shall', 'do', 'does', 'did', 'have', 'has', 'had',
  'been', 'being', 'am', 'is', 'are', 'was', 'were', 'be', 'get', 'got',
  'how', 'what', 'which', 'who', 'whom', 'whose', 'why', 'where', 'i', 'me',
  'my', 'we', 'us', 'our', 'you', 'your', 'they', 'them', 'their', 'he', 'him',
  'his', 'she', 'her', 'it', 'its', 'this', 'that', 'these', 'those', 'as',
  'didn', 'doesn', 'isn', 'wasn', 'weren', 'haven', 'hasn', 'hadn', 'wouldn',
  'couldn', 'shouldn', 'cant', 'cannot', 'wont', 'dont', 'im', 'ive', 'youre',
  's', 't', 'll', 're', 've', 'ok', 'okay', 'yeah', 'yes', 'sure', 'please',
  'thanks', 'thank', 'hi', 'hello', 'hey'
]);

// FTS5 treats these characters specially; tokens are sanitized to bare
// alphanumerics so user input can never break out of a MATCH expression.
const FTS_SPECIAL = /[^0-9A-Za-z]+/g;

function hasNodeSqlite() {
  return loadSqlite() !== null;
}

function loadSqlite() {
  // Node 22.5+ exposes node:sqlite synchronously via getBuiltinModule.
  // search() is synchronous, so this must be sync too.
  try {
    if (process.getBuiltinModule) {
      const mod = process.getBuiltinModule('node:sqlite');
      if (mod && typeof mod.DatabaseSync === 'function') return mod;
    }
  } catch {}
  return null;
}

/**
 * Tokenize a query into clean FTS terms: lowercase, split on non-alphanumeric,
 * drop stopwords and single characters, keep numbers (dates/years matter).
 * Returns an array of sanitized term strings.
 */
export function tokenizeQuery(query) {
  const raw = String(query || '').toLowerCase().split(FTS_SPECIAL).filter(Boolean);
  const seen = new Set();
  const terms = [];
  for (const t of raw) {
    const clean = t.replace(/[^0-9a-z]+/g, '');
    if (!clean || clean.length < 2) continue;          // drop 1-char noise
    if (STOPWORDS.has(clean)) continue;                 // drop stopwords
    if (seen.has(clean)) continue;                      // dedupe
    seen.add(clean);
    terms.push(clean);
  }
  return terms;
}

/**
 * Build (or fetch cached) FTS5 index for a library. The index is in-memory,
 * per-library, rebuilt on each loadLibrary — never stale, never persisted,
 * zero dependencies (node:sqlite is built into Node 22.5+).
 */
function getFtsIndex(library) {
  const cached = FTS_CACHE.get(library);
  if (cached) return cached;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE VIRTUAL TABLE blocks_fts USING fts5(
      body,
      facts,
      block_id UNINDEXED,
      lib_id UNINDEXED,
      display UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  const insert = db.prepare(
    'INSERT INTO blocks_fts (body, facts, block_id, lib_id, display) VALUES (?, ?, ?, ?, ?)'
  );

  for (const entry of library.blocks) {
    const block = readBlock(library, entry.lib_id);
    if (!block || !block.present) continue;
    // U1 (2026-08-04): Fact-augmented key expansion (K = V + facts, per
    // LongMemEval paper). Extract the "## Extracted facts" section (if any)
    // into a separate FTS column so queries match against the high-signal
    // facts summary, not just the raw transcript. BM25 weighting below keeps
    // facts slightly preferred when both match.
    const facts = extractFactsSection(block.raw);
    // Index raw text + a weighted display line (block_id + canonical_name) so
    // identifier-ish queries match strongly.
    const display = [entry.block_id, entry.canonical_name, entry.lineage]
      .filter(Boolean).join(' ').toLowerCase();
    insert.run(block.raw, facts, entry.block_id, entry.lib_id, display);
  }

  const index = { db, select: db.prepare(
    'SELECT block_id, lib_id, bm25(blocks_fts, 3.0, 5.0, 1.0, 3.0) AS rank ' +
    'FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?'
  ) };
  FTS_CACHE.set(library, index);
  return index;
}

/**
 * U1: Extract the "## Extracted facts" section from a block's raw markdown.
 * Returns the facts text (or empty string). Facts are the LLM-written summary
 * of durable info — indexing them as their own column gives query-time boost.
 */
export function extractFactsSection(raw) {
  const m = /## Extracted facts\s*\n([\s\S]*)$/i.exec(raw || '');
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Build an FTS5 MATCH expression from a raw query string.
 * - quoted "exact phrase" segments become literal phrases
 * - bare terms get a prefix wildcard (term*) for morphological reach
 * - terms are OR-chained (recall-first; BM25 ranks the best block above the
 *   rest). Quoted phrases, when present, are AND-ed with the OR-term group so
 *   an explicit phrase still anchors the query.
 * Returns null when there is nothing searchable left.
 */
export function buildMatchExpression(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  // Extract quoted phrases first.
  const phrases = [];
  const noPhrases = q.replace(/"([^"]+)"/g, (_, p) => {
    const terms = tokenizeQuery(p);
    if (terms.length) phrases.push(`"${terms.join(' ')}"`);
    return ' ';
  });

  const terms = tokenizeQuery(noPhrases).map((t) => `${t}*`);
  const orGroup = terms.length ? `(${terms.join(' OR ')})` : null;
  if (phrases.length && orGroup) return `${phrases.join(' AND ')} AND ${orGroup}`;
  if (phrases.length) return phrases.join(' AND ');
  if (orGroup) return orGroup;
  return null;
}

/** Find the first occurrence of any query term in raw text for the excerpt. */
function findExcerpt(raw, query) {
  const terms = tokenizeQuery(query);
  const lower = raw.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const found = lower.indexOf(t);
    if (found !== -1 && (idx === -1 || found < idx)) idx = found;
  }
  if (idx === -1) return raw.slice(0, 200).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 80);
  const end = Math.min(raw.length, idx + 120);
  let excerpt = raw.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) excerpt = '…' + excerpt;
  if (end < raw.length) excerpt = excerpt + '…';
  return excerpt;
}

/**
 * Search across block bodies. v2: FTS5 BM25 full-text search with prefix
 * matching, stopword stripping and quoted-phrase support; falls back to the
 * original substring scan when node:sqlite is unavailable.
 *
 * Returns { query, count, matches } where each match carries lib_id,
 * block_id, display_name, lineage, excerpt, and an optional score (FTS rank).
 */
export function search(library, query, { limit = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: query || '', count: 0, matches: [] };

  const matches = [];
  const byLib = new Map(library.blocks.map((b) => [b.lib_id, b]));
  const matchExpr = buildMatchExpression(q);

  // --- Primary path: FTS5 ---
  const index = matchExpr ? getFtsIndex(library) : null;
  if (index) {
    try {
      const rows = index.select.all(matchExpr, limit * 4);
      for (const row of rows) {
        const entry = byLib.get(Number(row.lib_id));
        if (!entry) continue;
        const block = readBlock(library, entry.lib_id);
        if (!block || !block.present) continue;
        matches.push({
          lib_id: entry.lib_id,
          block_id: entry.block_id,
          display_name: entry.canonical_name || entry.block_id,
          lineage: entry.lineage || null,
          excerpt: findExcerpt(block.raw, q),
          score: Number(row.rank),
        });
        if (matches.length >= limit) break;
      }
    } catch (err) {
      // FTS error (e.g. malformed expr) — fall through to substring.
      matches.length = 0;
    }
  }

  // --- Fallback / augmentation: substring scan ---
  // When FTS found nothing (or is unavailable), use the deterministic
  // substring scan so exact-phrase queries still land.
  if (matches.length === 0) {
    const ql = q.toLowerCase();
    for (const entry of library.blocks) {
      const block = readBlock(library, entry.lib_id);
      if (!block || !block.present) continue;
      const haystack = block.raw.toLowerCase();
      const idx = haystack.indexOf(ql);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 80);
      const end = Math.min(block.raw.length, idx + q.length + 120);
      let excerpt = block.raw.slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) excerpt = '…' + excerpt;
      if (end < block.raw.length) excerpt = excerpt + '…';
      matches.push({
        lib_id: entry.lib_id,
        block_id: entry.block_id,
        display_name: entry.canonical_name || entry.block_id,
        lineage: entry.lineage || null,
        excerpt,
      });
      if (matches.length >= limit) break;
    }
  }

  return { query: String(query), count: matches.length, matches };
}

/**
 * Parse the YAML frontmatter of a block file (the small subset of YAML the
 * library uses: flat `key: value` lines). Returns { fields, body, raw }.
 */
export function parseBlockFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return { fields: {}, body: text, raw: text };
  }
  const fields = {};
  const fm = match[1];
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  return { fields, body: match[2].trim(), raw: text };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load the library manifest. Returns null (with a reason) if the path does
 * not look like a Memory Lane library.
 */
export function loadLibrary(rootDir) {
  const manifestPath = path.join(rootDir, 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: `MANIFEST.json not found at ${manifestPath}` };
  }
  const manifest = readJsonSafe(manifestPath);
  if (!manifest || !Array.isArray(manifest.blocks)) {
    return { ok: false, reason: 'MANIFEST.json is missing a blocks array' };
  }
  // Enrich each manifest entry with the on-disk filename it should map to.
  const blocks = manifest.blocks.map((b) => {
    const shelf = b.shelf || shelfFor(b.lib_id);
    const filename = b.filename || `block-${String(b.lib_id).padStart(3, '0')}.md`;
    return {
      ...b,
      shelf: shelf,
      filename: filename,
      filePath: path.join(rootDir, 'shelves', shelf, filename)
    };
  });
  return {
    ok: true,
    rootDir,
    manifest,
    blocks,
    totalBlocks: manifest.total_blocks ?? blocks.length,
    totalShelves: manifest.total_shelves ?? 0,
    updated: manifest.updated ?? null,
    version: manifest.version ?? null,
    schemaVersion: manifest.schema_version ?? null
  };
}

/** Default shelf assignment when a manifest entry lacks one. */
function shelfFor(libId) {
  const shelfNum = Math.floor((libId - 1) / 6) + 1;
  return `shelf-${String(shelfNum).padStart(3, '0')}`;
}

/**
 * Read a single block file by lib_id. Returns the parsed block with its
 * computed on-disk SHA-256, or null if the file is missing.
 */
export function readBlock(library, libId) {
  const entry = library.blocks.find((b) => b.lib_id === Number(libId));
  if (!entry) return null;
  if (!fs.existsSync(entry.filePath)) {
    return { ...entry, present: false, reason: `missing: ${entry.filePath}` };
  }
  const text = fs.readFileSync(entry.filePath, 'utf8');
  const { fields, body, raw } = parseBlockFile(text);
  return {
    ...entry,
    present: true,
    fields,
    body,
    raw,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8')
  };
}

/**
 * Verify the SHA-256 chain across the whole library.
 *
 * For every block entry: recompute the hash of the on-disk file and compare
 * with the manifest's recorded sha256. Then walk prev_block_id links and
 * confirm each previous block's hash matches the recorded prev_sha256 where
 * present. Returns a per-block status array plus an overall verdict and the
 * length of the verified run.
 */
export function verifyChain(library) {
  const byLib = new Map(library.blocks.map((b) => [b.lib_id, b]));
  const byBlockId = new Map();
  for (const b of library.blocks) {
    if (b.block_id) byBlockId.set(b.block_id, b);
    if (b.canonical_name && !byBlockId.has(b.canonical_name)) byBlockId.set(b.canonical_name, b);
  }
  const results = [];
  let verifiedRun = 0;

  for (const entry of library.blocks) {
    const block = readBlock(library, entry.lib_id);
    const hashMatch = block && block.present && block.sha256 === entry.sha256;
    let prevOk = null;
    let prevBlock = null;

    if (entry.prev_block_id) {
      prevBlock = byBlockId.get(entry.prev_block_id) || byLib.get(entry.prev_block_id) || null;
      if (!prevBlock) {
        prevOk = { status: 'missing', detail: `prev ${entry.prev_block_id} not in manifest` };
      } else if (entry.prev_sha256) {
        const prevFile = readBlock(library, prevBlock.lib_id);
        prevOk = prevFile && prevFile.present && prevFile.sha256 === entry.prev_sha256
          ? { status: 'ok' }
          : { status: 'mismatch', expected: entry.prev_sha256, actual: prevFile ? prevFile.sha256 : null };
      } else {
        prevOk = { status: 'unchecked', detail: 'no prev_sha256 recorded' };
      }
    }

    const ok = hashMatch && (prevOk === null || prevOk.status === 'ok');
    let status;
    if (ok) {
      status = 'ok';
      verifiedRun += 1;
    } else if (prevOk && prevOk.status === 'unchecked') {
      status = 'unchecked'; // link exists by ID but no recorded hash to compare
    } else {
      status = hashMatch ? 'link_issue' : 'hash_mismatch';
    }
    results.push({
      lib_id: entry.lib_id,
      block_id: entry.block_id,
      lineage: entry.lineage || null,
      shelf: entry.shelf,
      status,
      recordedSha: entry.sha256,
      computedSha: block ? block.sha256 : null,
      present: block ? block.present : false,
      prevBlockId: entry.prev_block_id || null,
      prevCheck: prevOk
    });
  }

  const total = results.length;
  const okCount = results.filter((r) => r.status === 'ok').length;
  const hardIssues = results.filter((r) => r.status !== 'ok' && r.status !== 'unchecked').length;
  const unchecked = results.filter((r) => r.status === 'unchecked').length;
  const issues = total - okCount;
  // An empty library is vacuously intact: nothing to verify, nothing broken.
  const intact = okCount === total;
  // Three-state verdict per MAYA palette doctrine: green (intact),
  // blue (unverifiable links), red (corruption or missing chain entries).
  let status = 'intact';
  if (!intact) status = hardIssues > 0 ? 'issues' : 'unchecked';
  return {
    intact,
    total,
    okCount,
    issues,
    hardIssues,
    unchecked,
    verifiedRun,
    status,
    blocks: results
  };
}

/**
 * Resolve a resume phrase to the block(s) it points at. Tries exact block_id
 * first, then canonical_name, then a case-insensitive substring match across
 * block_id, display_name, and canonical_name.
 */
export function resolveResume(library, phrase) {
  const p = String(phrase || '').trim();
  if (!p) return { found: false, phrase: '', matches: [] };
  const norm = p.toLowerCase();

  const exact = library.blocks.filter(
    (b) => b.block_id === p || b.canonical_name === p || `block ${b.lib_id}` === p.toLowerCase()
  );
  if (exact.length > 0) {
    return { found: true, phrase, matches: exact.map((b) => b.lib_id), blocks: exact };
  }

  const matches = library.blocks.filter(
    (b) =>
      (b.block_id || '').toLowerCase().includes(norm) ||
      (b.canonical_name || '').toLowerCase().includes(norm) ||
      (b.lineage || '').toLowerCase().includes(norm)
  );
  return {
    found: matches.length > 0,
    phrase,
    matches: matches.map((b) => b.lib_id),
    blocks: matches
  };
}

/**
 * Deterministic JSON export of the whole library: manifest summary plus every
 * block (fields, body, recorded + computed hash). Sorted by lib_id so the
 * output is byte-stable across runs.
 */
export function exportLibrary(library) {
  const blocks = library.blocks
    .slice()
    .sort((a, b) => a.lib_id - b.lib_id)
    .map((entry) => {
      const block = readBlock(library, entry.lib_id);
      return {
        lib_id: entry.lib_id,
        block_id: entry.block_id,
        canonical_name: entry.canonical_name || null,
        lineage: entry.lineage || null,
        shelf: entry.shelf,
        status: entry.status || 'active',
        prev_block_id: entry.prev_block_id || null,
        recorded_sha256: entry.sha256 || null,
        computed_sha256: block && block.present ? block.sha256 : null,
        present: block ? block.present : false,
        fields: block ? block.fields : {},
        body: block && block.present ? block.body : null
      };
    });
  return {
    library: {
      version: library.version,
      schemaVersion: library.schemaVersion,
      totalBlocks: library.totalBlocks,
      totalShelves: library.totalShelves,
      updated: library.updated
    },
    exportedAt: new Date().toISOString(),
    blockCount: blocks.length,
    blocks
  };
}

/**
 * Library statistics for the UI header: block count, shelf count, lineage
 * count, first/last block numbers, intact status.
 */
export function libraryStats(library) {
  const chain = verifyChain(library);
  const lineages = new Set(library.blocks.map((b) => b.lineage).filter(Boolean));
  const libIds = library.blocks.map((b) => b.lib_id).sort((a, b) => a - b);
  return {
    totalBlocks: library.blocks.length,
    totalShelves: library.totalShelves || new Set(library.blocks.map((b) => b.shelf)).size,
    lineageCount: lineages.size,
    firstBlock: libIds.length ? libIds[0] : null,
    lastBlock: libIds.length ? libIds[libIds.length - 1] : null,
    chainIntact: chain.intact,
    issues: chain.issues,
    okCount: chain.okCount
  };
}
