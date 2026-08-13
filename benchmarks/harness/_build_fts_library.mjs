#!/usr/bin/env node
/**
 * Build a Memory Lane library from LongMemEval dataset for Lane F.
 * Usage: node _build_fts_library.mjs <dataset.json> <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , datasetPath, outDir] = process.argv;
if (!datasetPath || !outDir) { console.error('usage: _build_fts_library.mjs <dataset.json> <outDir>'); process.exit(1); }

const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
fs.rmSync(outDir, { recursive: true, force: true });
const shelfDir = path.join(outDir, 'shelves', 'shelf-001');
fs.mkdirSync(shelfDir, { recursive: true });

const blocks = [];
let libId = 1;
for (const inst of dataset) {
  for (let si = 0; si < inst.haystack_sessions.length; si++) {
    const sess = inst.haystack_sessions[si];
    const sessId = inst.haystack_session_ids[si];
    const body = sess.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
    const blockId = `cb_lme_${inst.question_id.replace(/[^a-z0-9]/gi, '_')}_${si}`;
    const prev = blocks.length ? blocks[blocks.length - 1] : null;
    const text = `---\nartifact_type: memory_block\nblock_id: ${blockId}\nlib_id: ${libId}\nblock_number: ${libId}\nstatus: active\nlineage: longmemeval\nshelf: shelf-001\nsession_id: ${sessId}\nprevious_block: ${prev ? prev.block_id : 'none'}\nprevious_sha: ${prev ? prev.sha256 : 'none'}\n---\n\n${body}\n`;
    const sha = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    fs.writeFileSync(path.join(shelfDir, `block-${String(libId).padStart(3, '0')}.md`), text, { encoding: 'utf8' });
    blocks.push({ lib_id: libId, block_id: blockId, shelf: 'shelf-001', sha256: sha, prev_block_id: prev ? prev.block_id : null, prev_sha256: prev ? prev.sha256 : null });
    libId++;
  }
}
fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify({ version: 'benchmark-v1', total_blocks: blocks.length, blocks }, null, 2), { encoding: 'utf8' });
console.log(`built ${blocks.length} blocks -> ${outDir}`);
