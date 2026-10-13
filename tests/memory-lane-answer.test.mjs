import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLibrary, appendBlock } from '../lib/memoryLaneCore.js';
import { answerQuestion, termsPresent } from '../lib/answer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EMPTY_MANIFEST = path.join(ROOT, 'empty-library', 'MANIFEST.json');

function makeTempLibrary() {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ml-answer-'));
  fs.copyFileSync(EMPTY_MANIFEST, path.join(tmp, 'MANIFEST.json'));
  return tmp;
}

test('termsPresent matches content terms, ignores stopwords', () => {
  assert.equal(termsPresent('Alex leased a 2026 Honda Civic.', 'honda civic'), true);
  assert.equal(termsPresent('Alex leased a 2026 Honda Civic.', 'what honda did alex lease'), true);
  assert.equal(termsPresent('Alex likes coffee.', 'quantum physics'), false);
  assert.equal(termsPresent('anything', 'the and or'), true); // all stopwords
});

test('answerQuestion returns none for empty query', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'T', body: 'Alex likes coffee.', lineage: 'auto' });
  const lib = loadLibrary(tmp);
  const r = await answerQuestion(lib, '   ');
  assert.equal(r.mode, 'none');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('answerQuestion returns none for a no-match query', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, { title: 'T', body: 'Alex likes coffee.', lineage: 'auto' });
  const lib = loadLibrary(tmp);
  const r = await answerQuestion(lib, 'quantum physics preferences');
  assert.equal(r.mode, 'none');
  assert.match(r.answer, /No memory found/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('answerQuestion direct mode when content terms are present (free, deterministic)', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, {
    title: 'Civic lease',
    body: 'Alex leased a 2026 Honda Civic in matte black. He prefers dark mode.',
    facts: ['User leased a 2026 Honda Civic in matte black'],
    lineage: 'auto'
  });
  const lib = loadLibrary(tmp);
  // "honda civic" are literal content terms -> direct, free, deterministic.
  const r = await answerQuestion(lib, 'honda civic');
  assert.equal(r.mode, 'direct');
  assert.equal(r.cost, 0);
  assert.ok((r.answer || '').length > 0);
  assert.ok(r.source);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('answerQuestion abstains honestly when Jev key is unavailable (no prose lane)', async () => {
  const tmp = makeTempLibrary();
  appendBlock(tmp, {
    title: 'Positioning',
    body: 'Memory Lane differentiates via chain integrity over Honcho and Mem0.',
    facts: ['Chain integrity is the differentiator over Honcho and Mem0'],
    lineage: 'auto'
  });
  const lib = loadLibrary(tmp);
  // Why is this different from other memory tools: no exact term presence,
  // and in test env there is no Jev key (hermetic env), so there is no prose
  // lane to fall back to. v2 contract: mode none + an honest abstain answer,
  // never a guessed excerpt or a chat-model paraphrase.
  const r = await answerQuestion(lib, 'why is this different from other memory tools');
  assert.equal(r.mode, 'none');
  assert.ok(!r.source, 'abstain must not cite a hit');
  assert.match(r.answer, /No memory found/i);
  assert.ok(r.answer.length > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Server endpoint ---
const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let tmpLibrary;

test.before(async () => {
  tmpLibrary = makeTempLibrary();
  appendBlock(tmpLibrary, { title: 'Civic', body: 'Alex leased a 2026 Honda Civic in matte black.', facts: ['User leased a 2026 Honda Civic'], lineage: 'auto' });
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), MEMORY_LANE_LIBRARY: tmpLibrary },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(() => {
  if (server) server.kill();
  if (tmpLibrary) fs.rmSync(tmpLibrary, { recursive: true, force: true });
});

test('GET /api/answer returns 400 for missing q', async () => {
  const r = await fetch(`${BASE}/api/answer`);
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('GET /api/answer direct mode over HTTP', async () => {
  const r = await fetch(`${BASE}/api/answer?q=honda%20civic`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'direct');
  assert.equal(d.cost, 0);
});

test('GET /api/answer no-match returns none mode over HTTP', async () => {
  const r = await fetch(`${BASE}/api/answer?q=zzzqqqxxx`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'none');
});
