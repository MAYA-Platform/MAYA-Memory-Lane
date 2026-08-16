#!/usr/bin/env node
// hybrid_retrieve.mjs — FTS5 + Vertex embeddings + RRF retrieval for Lane G.
// Usage: node hybrid_retrieve.mjs "<query>" <lib_dir> [top]
// Env: EMBED_PROVIDER=vertex VERTEX_ACCESS_TOKEN=<token>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_CORE = path.resolve(__dirname, '../../lib/memoryLaneCore.js');
const { loadLibrary, search } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));
const { denseSearch, rrf } = await import('file:///' + path.resolve(__dirname, '../../lib/embeddings.js').replace(/\\/g, '/'));

const query = process.argv[2] || '';
const libDir = process.argv[3] || '';
const top = parseInt(process.argv[4] || '5', 10);
const lib = loadLibrary(libDir);
if (!lib.ok) { console.log('[]'); process.exit(0); }
const byLib = new Map(lib.blocks.map((b) => [b.lib_id, b]));

const fts = search(lib, query, { limit: top * 2 }).matches.map((m) => m.lib_id);
let dense = [];
try {
  dense = (await denseSearch(lib, query, { limit: top * 2 })).map((h) => h.lib_id);
} catch { /* dense unavailable */ }
const fused = rrf([fts, dense], { k: 60 }).map((x) => x.lib_id).slice(0, top);

const blocks = [];
for (const lid of fused) {
  const b = byLib.get(lid);
  if (!b) continue;
  const f = path.join(libDir, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
  try {
    const raw = fs.readFileSync(f, 'utf8');
    blocks.push(raw.split('---').slice(2).join('---').slice(0, 2500));
  } catch { /* skip */ }
}
console.log(JSON.stringify(blocks));
