#!/usr/bin/env node
// fts_retrieve.mjs — FTS5 retrieve top blocks for a query, used by Lane G.
// Usage: node fts_retrieve.mjs "<query>" <lib_dir> [top]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_CORE = path.resolve(__dirname, '../../lib/memoryLaneCore.js');
const { loadLibrary, search } = await import('file:///' + ML_CORE.replace(/\\/g, '/'));

const query = process.argv[2] || '';
const libDir = process.argv[3] || '';
const top = parseInt(process.argv[4] || '3', 10);
const lib = loadLibrary(libDir);
if (!lib.ok) { console.log('[]'); process.exit(0); }
const byLib = new Map(lib.blocks.map((b) => [b.lib_id, b]));
const res = search(lib, query, { limit: top });
const blocks = [];
for (const m of res.matches) {
  const b = byLib.get(m.lib_id);
  if (!b) continue;
  const f = path.join(libDir, 'shelves', b.shelf, `block-${String(b.lib_id).padStart(3, '0')}.md`);
  try {
    const raw = fs.readFileSync(f, 'utf8');
    blocks.push(raw.split('---').slice(2).join('---').slice(0, 2500));
  } catch { /* skip */ }
}
console.log(JSON.stringify(blocks));
