#!/usr/bin/env node
/**
 * Memory Lane — sample library generator.
 *
 * Creates a small, deterministic demo Continuity Library so the repo runs
 * out of the box without any real data. It mirrors the exact on-disk format
 * the engine uses: MANIFEST.json, shelves/shelf-NNN/block-NNN.md, shelf and
 * volume manifests, and a SHA-256 chain across blocks.
 *
 * The sample tells a coherent story: 6 micro-blocks (one per session) that
 * get consolidated into a canonical shelf block, which is exactly the 6→1
 * compaction model Memory Lane is built on.
 *
 * Usage:
 *   node tools/make-sample-library.mjs [outputDir]
 *   (default output: ./sample-library)
 *
 * Deterministic: identical output on every run (fixed timestamps, fixed
 * hashes produced from fixed content). Safe to commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'sample-library');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const T = {
  micro: (n, title, subject, body) => `---
artifact_type: memory_block
block_id: cb_sample_${String(n).padStart(4, '0')}
display_name: "${title} — Micro Block ${String(n).padStart(3, '0')}"
block_number: ${n}
status: active
timestamp: "2026-07-2${n}T23:00:00Z"
actor: system
subject: ${subject}
processing_model: generic-llm
processing_provider: local
previous_block: ${n > 1 ? `cb_sample_${String(n - 1).padStart(4, '0')}` : 'none'}
---

# Sample Micro Block ${String(n).padStart(3, '0')} — ${title}

## Session Scope

${body}

## Completed — Do Not Rerun

- Sample session ${n} captured as a micro block.

## Next Pickup

Continue the sample sequence. Block ${n + 1} follows this one.
`,
  consolidated: (prevHash, first, last) => `---
artifact_type: memory_block
block_id: cb_sample_consolidated_0001_0006
display_name: "Consolidated Record 001-006"
block_number: 7
status: active
topic: consolidation
previous_block: cb_sample_0006
previous_hash: ${prevHash}
timestamp: "2026-08-01T00:00:00Z"
purpose: consolidated_shelf_record
actor: system
subject: "6 sample micro-blocks (cb_sample_0001 ... cb_sample_0006) consolidated into 1 canonical shelf block per 6->1 doctrine"
processing_model: generic-llm
processing_provider: local
author: system
consolidates: [cb_sample_0001, cb_sample_0002, cb_sample_0003, cb_sample_0004, cb_sample_0005, cb_sample_0006]
---

# Consolidated Block 007 — Sample Sessions 001-006

## Purpose

Per the 6->1 compaction doctrine, six session micro-blocks (libs ${first}-${last})
are consolidated into this single canonical shelf block. Micro-blocks remain
archived byte-for-byte at blocks/micro-2026-07/ with their SHA-256.

## Chained SHA Table

| Lib | Block | SHA-256 | Shelf |
|---|---|---|---|
| 1 | cb_sample_0001 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |
| 2 | cb_sample_0002 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |
| 3 | cb_sample_0003 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |
| 4 | cb_sample_0004 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |
| 5 | cb_sample_0005 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |
| 6 | cb_sample_0006 | 0000000000000000000000000000000000000000000000000000000000000000 | shelf-001 |

## Consolidated Summary

Six sample sessions consolidated into one canonical library record for lineage
cb_sample, covering libs ${first}-${last}. This is the Memory Lane demo of the
6->1 compaction model: the library grows one shelf block per six sessions,
not one file per session.

## Completed — Do Not Rerun

- 6->1 consolidation of libs ${first}-${last} (this block)
`,
};

const SESSIONS = [
  { title: 'Founder Notes', subject: 'first session of the sample library', body: 'First sample session. The founder captured a set of product notes for the memory layer and filed them as the first micro block. This is the shape every session leaves behind: a sealed record with a fingerprint.' },
  { title: 'Architecture Review', subject: 'second sample session', body: 'Reviewed the memory-layer architecture against the constraint stack. Decision: files stay the source of truth; any index is derived and disposable. This block records the decision and links back to block 001.' },
  { title: 'Budget Pass', subject: 'third sample session', body: 'Audited provider spend and routed more work to local models. The balance picture was captured and filed. Each block carries the fingerprint of the block before it, so the chain reads like a spine.' },
  { title: 'Staff Briefing', subject: 'fourth sample session', body: 'Drafted the weekly team memo for the MAYA staff. The memo board is the default reading surface; the continuity library is the record of how decisions were reached.' },
  { title: 'Public Repo Pass', subject: 'fifth sample session', body: 'Prepared a public product repo for the MAYA-Platform organization. Same quality bar as the rest of the family: README, screenshot, tests, license, security policy.' },
  { title: 'Market Watch', subject: 'sixth sample session', body: 'Logged the market validation notes for the agent-memory category. Six micro-blocks now sit in the chain — the next consolidation pass will fold them into one canonical shelf block.' },
];

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'shelves', 'shelf-001'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'shelves', 'shelf-002'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'blocks', 'micro-2026-07'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'volumes', 'volume-memory-layer'), { recursive: true });

  const entries = [];
  const shelf1 = [];
  let prevHash = null;

  // 1-6: micro blocks on shelf-001, each chained to the previous
  for (let i = 1; i <= 6; i++) {
    const text = T.micro(i, SESSIONS[i - 1].title, SESSIONS[i - 1].subject, SESSIONS[i - 1].body);
    const hash = sha256(text);
    const filename = `block-${String(i).padStart(3, '0')}.md`;
    fs.writeFileSync(path.join(OUT, 'shelves', 'shelf-001', filename), text);
    // archived copy (byte-identical)
    fs.writeFileSync(path.join(OUT, 'blocks', 'micro-2026-07', `cb_sample_${String(i).padStart(4, '0')}.md`), text);
    entries.push({
      lib_id: i,
      canonical_name: `cb_sample_${String(i).padStart(4, '0')}`,
      shelf: 'shelf-001',
      position: i,
      block_id: `cb_sample_${String(i).padStart(4, '0')}`,
      lineage: 'cb_sample',
      volume: 'volume-memory-layer',
      status: 'active',
      revision_version: '0.1',
      sha256: hash,
      prev_block_id: i > 1 ? `cb_sample_${String(i - 1).padStart(4, '0')}` : null,
      prev_sha256: prevHash,
      supersedes_id: null,
      superseded_by_id: null,
      filename
    });
    shelf1.push({
      lib_id: i,
      position: i,
      block_id: `cb_sample_${String(i).padStart(4, '0')}`,
      canonical_name: `cb_sample_${String(i).padStart(4, '0')}`,
      lineage: 'cb_sample',
      revision_version: '0.1',
      status: 'active',
      sha256: hash,
      prev_block_id: i > 1 ? `cb_sample_${String(i - 1).padStart(4, '0')}` : null,
      prev_sha256: prevHash,
      supersedes_id: null,
      superseded_by_id: null,
      filename
    });
    prevHash = hash;
  }

  // 7: consolidated canonical block on shelf-002
  const consText = T.consolidated(prevHash, 1, 6);
  const consHash = sha256(consText);
  fs.writeFileSync(path.join(OUT, 'shelves', 'shelf-002', 'block-007.md'), consText);
  entries.push({
    lib_id: 7,
    canonical_name: 'cb_sample_consolidated_0001_0006',
    shelf: 'shelf-002',
    position: 1,
    block_id: 'cb_sample_consolidated_0001_0006',
    lineage: 'cb_sample',
    volume: 'volume-memory-layer',
    status: 'active',
    revision_version: '1.0',
    sha256: consHash,
    prev_block_id: 'cb_sample_0006',
    prev_sha256: prevHash,
    supersedes_id: null,
    superseded_by_id: null,
    filename: 'block-007.md'
  });

  // Shelf manifests
  fs.writeFileSync(
    path.join(OUT, 'shelves', 'shelf-001', 'shelf-manifest.json'),
    JSON.stringify({ shelf_id: 'shelf-001', block_count: 6, block_range: 'blocks 001-006', blocks: shelf1 }, null, 2)
  );
  fs.writeFileSync(
    path.join(OUT, 'shelves', 'shelf-002', 'shelf-manifest.json'),
    JSON.stringify({
      shelf_id: 'shelf-002',
      block_count: 1,
      block_range: 'blocks 007-007',
      blocks: [{
        lib_id: 7,
        position: 1,
        block_id: 'cb_sample_consolidated_0001_0006',
        canonical_name: 'cb_sample_consolidated_0001_0006',
        lineage: 'cb_sample',
        revision_version: '1.0',
        status: 'active',
        sha256: consHash,
        prev_block_id: 'cb_sample_0006',
        prev_sha256: prevHash,
        supersedes_id: null,
        superseded_by_id: null,
        filename: 'block-007.md'
      }]
    }, null, 2)
  );

  // Volume manifest
  fs.writeFileSync(
    path.join(OUT, 'volumes', 'volume-memory-layer', 'volume-manifest.json'),
    JSON.stringify({
      volume_id: 'volume-memory-layer',
      block_count: 7,
      blocks: entries.map(({ filename, ...rest }) => rest)
    }, null, 2)
  );

  // Master manifest
  const manifest = {
    library: 'memory-lane-library',
    version: '1.0.0',
    schema_version: '1.0',
    schema_description: 'Memory Lane sample library — mirrors the memory-lane-library on-disk format.',
    created: '2026-07-27T00:00:00Z',
    updated: 7,
    total_blocks: 7,
    total_shelves: 2,
    volumes: ['volume-memory-layer'],
    shelves: ['shelf-001', 'shelf-002'],
    blocks: entries,
    lineages: {
      cb_sample: { blocks: [1, 2, 3, 4, 5, 6, 7], volume: 'volume-memory-layer', block_count: 7 }
    }
  };
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

  // Library README
  fs.writeFileSync(
    path.join(OUT, 'LIBRARY_README.md'),
    `# Sample Library\n\nThis is a small, deterministic demo library for Memory Lane.\nIt contains 6 micro-blocks and 1 consolidated shelf block (the 6→1 compaction model).\nEvery block carries a SHA-256 fingerprint and a link to the block before it.\n\nRegenerate with:\n\n\`\`\`bash\nnode tools/make-sample-library.mjs\n\`\`\`\n`
  );

  return { entries, manifest };
}

const result = build();
console.log(`✅ Sample library written to ${OUT}`);
console.log(`   Blocks: ${result.entries.length} (6 micro + 1 consolidated)`);
console.log(`   Chain SHA: ${sha256(fs.readFileSync(path.join(OUT, 'MANIFEST.json'), 'utf8')).slice(0, 16)}…`);
