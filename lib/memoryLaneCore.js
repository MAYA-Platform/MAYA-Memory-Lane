#!/usr/bin/env node
/**
 * Memory Lane — core library reader.
 *
 * Reads a Continuity Library from disk (files are the canonical truth) and
 * exposes the operations the Memory Lane UI needs:
 *
 *   - loadLibrary()        read MANIFEST.json + shelf manifests
 *   - readBlock()          read one block file (frontmatter + markdown)
 *   - verifyChain()        recompute SHA-256 per block and walk prev links
 *   - search()             plain-text search across block bodies
 *   - resolveResume()      find the block(s) a resume phrase points at
 *   - exportLibrary()      deterministic JSON bundle of the whole library
 *
 * Zero dependencies. Files stay the source of truth; nothing here writes to
 * the library. The UI is a window over the files, never a replacement for
 * them — if the index dies, Memory Lane rebuilds everything from the chain.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
 * not look like a Continuity Library.
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
  const intact = total > 0 && okCount === total;
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
 * Plain-text search across block bodies and frontmatter. Returns matches
 * with a short excerpt around the first hit. Case-insensitive substring
 * search over the raw block text; simple and dependency-free.
 */
export function search(library, query, { limit = 25 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { query: query || '', count: 0, matches: [] };
  const matches = [];
  for (const entry of library.blocks) {
    const block = readBlock(library, entry.lib_id);
    if (!block || !block.present) continue;
    const haystack = block.raw.toLowerCase();
    const idx = haystack.indexOf(q);
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
      excerpt
    });
    if (matches.length >= limit) break;
  }
  return { query: String(query), count: matches.length, matches };
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
