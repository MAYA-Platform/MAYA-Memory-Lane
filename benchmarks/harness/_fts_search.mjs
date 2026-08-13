#!/usr/bin/env node
/**
 * FTS5 search helper for Lane F.
 * Usage: node _fts_search.mjs "<query>" <k> [libraryDir]
 * Prints a JSON array of top-k matches {lib_id, block_id, session_id, excerpt}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , query, kArg, libArg] = process.argv;
const k = parseInt(kArg || '5', 10);
const LIB_DIR = libArg || path.join(__dirname, '..', 'libraries', 'ml-lane-f');

const CORE = 'E:/MAYA_BULK/memory-lane-public-repo/lib/memoryLaneCore.js';
const { loadLibrary, search } = await import('file:///' + CORE.replace(/\\/g, '/'));

const lib = loadLibrary(LIB_DIR);
if (!lib.ok) { console.log(JSON.stringify([])); process.exit(0); }

const r = search(lib, query, { limit: k });

// map lib_id -> session_id from block frontmatter
const sessionMap = {};
for (const b of lib.blocks) {
  const f = path.join(LIB_DIR, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const m = raw.match(/^session_id: (.+)$/m);
    if (m) sessionMap[b.lib_id] = m[1].trim();
  } catch {}
}

const out = r.matches.map((m) => {
  // Prefer the "## Extracted facts" section when present (facts are the
  // high-signal summary; the raw transcript can be 17K+ chars and truncation
  // would bury them). Fall back to the full body.
  let full = '';
  const f = path.join(LIB_DIR, 'shelves', entryShelf(m.lib_id), `block-${String(m.lib_id).padStart(3, '0')}.md`);
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const m2 = raw.split('---');
    const body = (m2.slice(2).join('---') || raw).trim();
    const factsIdx = body.indexOf('## Extracted facts');
    if (factsIdx !== -1) {
      // facts section + a bit of the transcript before it for context
      full = body.slice(Math.max(0, factsIdx - 300), factsIdx + 1600);
    } else {
      full = body;
    }
  } catch {}
  return {
    lib_id: m.lib_id,
    block_id: m.block_id,
    session_id: sessionMap[m.lib_id] || null,
    excerpt: m.excerpt || '',
    body: full.slice(0, 8000),
  };
});
console.log(JSON.stringify(out));

function entryShelf(libId) {
  const e = lib.blocks.find((b) => b.lib_id === libId);
  return e ? e.shelf : 'shelf-001';
}
