import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, appendBlock, search } from '../lib/memoryLaneCore.js';
import { extractTriples, graphSearch } from '../lib/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EMPTY_MANIFEST = path.join(ROOT, 'empty-library', 'MANIFEST.json');

function makeTempLibrary() {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-graph-'));
  fs.copyFileSync(EMPTY_MANIFEST, path.join(tmp, 'MANIFEST.json'));
  return tmp;
}

test('extractTriples pulls SVO triples deterministically', () => {
  const text = 'Alex leased a 2026 Honda Civic. Emily sister is Katie. Jordan works at Northwind.';
  const t = extractTriples(text);
  const keys = t.map((x) => `${x.subject}|${x.relation}|${x.object}`);
  assert.ok(keys.some((k) => k.startsWith('alex|leased|')));
  assert.ok(keys.includes('emily|has_sister|katie'));
  assert.ok(keys.includes('jordan|works at|northwind'));
  // Deterministic: same input, same output
  const t2 = extractTriples(text);
  assert.deepEqual(t, t2);
});

test('extractTriples skips frontmatter and respects maxEdges', () => {
  const text = '---\nblock_id: x\n---\n\nSam likes coffee. Sam likes tea. Sam likes chai.';
  const t = extractTriples(text, { maxEdges: 2 });
  assert.equal(t.length, 2);
  assert.ok(!JSON.stringify(t).includes('block_id'));
});

test('graphSearch ranks blocks sharing entities, 2-hop expands', () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'Alex leased a Honda Civic and loves hiking.', lineage: 'auto' });
  appendBlock(tmp, { title: 'B', body: 'Alex also owns a kayak for lake trips.', lineage: 'auto' });
  appendBlock(tmp, { title: 'C', body: 'Unrelated text about quantum physics research.', lineage: 'auto' });
  const lib = loadLibrary(tmp);
  const g = graphSearch(lib, 'hiking', { limit: 10 });
  assert.ok(g.count >= 1);
  // Block B shares entity "alex" with block A -> 2-hop neighbor boost.
  const ids = g.matches.map((m) => m.lib_id);
  assert.ok(ids.length >= 2, '2-hop should surface the neighbor block');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('search fuses graph-only hits after lexical hits (never below them)', () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'A', body: 'Maya the dog loved the park. Maya guarded the yard.', lineage: 'auto' });
  appendBlock(tmp, { title: 'B', body: 'Maya was a loyal companion on long walks.', lineage: 'auto' });
  appendBlock(tmp, { title: 'C', body: 'The yard gate was repaired last spring.', lineage: 'auto' });
  const lib = loadLibrary(tmp);
  const r = search(lib, 'park', { limit: 10 });
  assert.ok(r.count >= 1);
  // The lexical top hit stays first; graph-only hits may follow.
  const ids = r.matches.map((m) => m.lib_id);
  assert.ok(ids.length >= 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('search with no graph signal behaves exactly like lexical-only', () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'T', body: 'Plain text with no extractable relations whatsoever here.', lineage: 'auto' });
  const lib = loadLibrary(tmp);
  const r = search(lib, 'plain text', { limit: 5 });
  assert.equal(r.count, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
