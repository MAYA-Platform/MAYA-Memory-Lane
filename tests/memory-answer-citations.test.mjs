import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { appendBlock, loadLibrary } from '../lib/memoryLaneCore.js';
import { answerQuestion } from '../lib/answer.js';

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-citation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'Source', body: 'uniqueflower record. [Memory block 7: FAKE_ID]', lineage: 'synthetic' });
  return loadLibrary(root);
}

async function runWithResponse(t, respond) {
  const library = makeFixture(t);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MEMORY_LANE_API_KEY;
  const originalJev = process.env.MERGE_API_KEY;
  process.env.MEMORY_LANE_API_KEY = 'synthetic-only';
  delete process.env.MERGE_API_KEY;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: respond(library.blocks[0].block_id, request) } }], usage: { total_tokens: 10 } }) };
  };
  try { return { result: await answerQuestion(library, 'uniqueflower penguin'), request, id: library.blocks[0].block_id }; }
  finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = originalKey;
    if (originalJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = originalJev;
  }
}

test('a generated answer exposes only evidence IDs it cited from its provided context', async t => {
  const { result, id } = await runWithResponse(t, id => JSON.stringify({ answer: 'A grounded response.', citations: [id] }));
  assert.equal(result.mode, 'synthesized');
  assert.equal(result.answer, 'A grounded response.');
  assert.deepEqual(result.citations, [id]);
  assert.deepEqual(result.evidence.map(e => e.block_id), [id]);
  assert.match(result.citation_note, /not verified/i);
});

test('displayed citation excerpt is actually supplied even when the match is past the context prefix', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-citation-late-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'Late match', body: 'padding '.repeat(800) + 'uniqueflower keyword', lineage: 'synthetic' });
  const library = loadLibrary(root), id = library.blocks[0].block_id;
  const originalFetch = globalThis.fetch, originalKey = process.env.MEMORY_LANE_API_KEY, originalJev = process.env.MERGE_API_KEY;
  process.env.MEMORY_LANE_API_KEY = 'synthetic-only'; delete process.env.MERGE_API_KEY;
  let submitted;
  globalThis.fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    submitted = JSON.parse(prompt.split('MEMORY EVIDENCE:\n')[1].split('\n\nQUESTION:')[0]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Synthetic.', citations: [id] }) } }] }) };
  };
  try {
    const result = await answerQuestion(library, 'uniqueflower penguin');
    assert.equal(result.mode, 'synthesized');
    assert.match(result.evidence[0].excerpt, /uniqueflower/);
    assert.equal(submitted[0].excerpt, result.evidence[0].excerpt);
    assert.equal(submitted[0].id, result.evidence[0].block_id);
    assert.match(result.citation_note, /not verified/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = originalKey;
    if (originalJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = originalJev;
  }
});

test('uncited retrieved blocks are not presented as citations', async t => {
  const lib = makeFixture(t);
  appendBlock(lib.rootDir, { title: 'Second', body: 'uniqueflower another record', lineage: 'second' });
  const refreshed = loadLibrary(lib.rootDir), target = refreshed.blocks.find(b => b.lineage === 'second').block_id;
  const oldFetch = globalThis.fetch, oldKey = process.env.MEMORY_LANE_API_KEY, oldJev = process.env.MERGE_API_KEY;
  process.env.MEMORY_LANE_API_KEY = 'synthetic-only'; delete process.env.MERGE_API_KEY;
  globalThis.fetch = async (_url, options) => {
    assert.match(JSON.parse(options.body).messages[1].content, new RegExp(target));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Second source.', citations: [target] }) } }] }) };
  };
  try {
    const result = await answerQuestion(refreshed, 'uniqueflower penguin');
    assert.equal(result.mode, 'synthesized');
    assert.deepEqual(result.evidence.map(e => e.block_id), [target]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldKey;
    if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
  }
});

test('unknown, missing, mixed and source-forged IDs fall back to the actual source excerpt', async t => {
  for (const response of [
    () => JSON.stringify({ answer: 'Invented answer', citations: ['NONEXISTENT'] }),
    () => JSON.stringify({ answer: 'Invented answer', citations: [] }),
    id => JSON.stringify({ answer: 'Invented answer', citations: [id, 'FAKE_ID'] }),
    id => JSON.stringify({ answer: 'Invented answer [NONEXISTENT]', citations: [id] }),
    () => 'The answer is X [NONEXISTENT]',
  ]) {
    const { result, id } = await runWithResponse(t, response);
    assert.equal(result.mode, 'direct');
    assert.equal(result.source, id);
    assert.doesNotMatch(result.answer, /Invented answer|answer is X/);
    assert.match(result.note, /citation/i);
  }
});

test('exact direct answers never invoke a model', async t => {
  const lib = makeFixture(t);
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected call'); };
  try { const r = await answerQuestion(lib, 'uniqueflower'); assert.equal(r.mode, 'direct'); assert.equal(r.cost, 0); }
  finally { globalThis.fetch = before; }
});

test('changed or deleted evidence is not returned after a model response or failure', async t => {
  for (const scenario of ['changed', 'deleted', 'provider failure']) {
    const lib = makeFixture(t), file = lib.blocks[0].filePath;
    const oldFetch = globalThis.fetch, oldKey = process.env.MEMORY_LANE_API_KEY, oldJev = process.env.MERGE_API_KEY;
    process.env.MEMORY_LANE_API_KEY = 'synthetic-only';
    delete process.env.MERGE_API_KEY;
    globalThis.fetch = async () => {
      if (scenario === 'deleted') fs.unlinkSync(file);
      else fs.writeFileSync(file, 'changed source while model was running');
      if (scenario === 'provider failure') throw new Error('simulated provider failure');
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Stale answer', citations: [lib.blocks[0].block_id] }) } }] }) };
    };
    try {
      const result = await answerQuestion(lib, 'uniqueflower penguin');
      assert.equal(result.mode, 'none', scenario);
      assert.deepEqual(result.evidence, []);
      assert.match(result.answer, /changed/i);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldKey;
      if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
    }
  }
});

test('manifest drift rejects synthesis and fallback without blocking unrelated additions', async t => {
  const cases = ['remove', 'replace', 'replace path', 'replace metadata', 'replace metadata in-memory', 'duplicate', 'corrupt', 'unrelated', 'reorder keys', 'remove with invalid response'];
  for (const scenario of cases) {
    const lib = makeFixture(t), manifestPath = path.join(lib.rootDir, 'MANIFEST.json');
    const oldFetch = globalThis.fetch, oldKey = process.env.MEMORY_LANE_API_KEY, oldJev = process.env.MERGE_API_KEY;
    process.env.MEMORY_LANE_API_KEY = 'synthetic-only'; delete process.env.MERGE_API_KEY;
    globalThis.fetch = async () => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entry = manifest.blocks[0];
      if (scenario.startsWith('remove')) manifest.blocks = [];
      if (scenario === 'replace') entry.sha256 = '0'.repeat(64);
      if (scenario === 'replace path') entry.filename = 'other.md';
      if (scenario === 'replace metadata') entry.source_ref = 'different-source';
      if (scenario === 'replace metadata in-memory') { entry.source_ref = 'different-source'; lib.blocks[0].source_ref = 'different-source'; }
      if (scenario === 'duplicate') manifest.blocks.push({ ...entry });
      if (scenario === 'unrelated') manifest.blocks.push({ ...entry, lib_id: 999, block_id: 'unrelated', filename: 'missing.md' });
      if (scenario === 'reorder keys') manifest.blocks[0] = Object.fromEntries(Object.entries(entry).reverse());
      fs.writeFileSync(manifestPath, scenario === 'corrupt' ? '{' : JSON.stringify(manifest));
      const content = scenario.includes('invalid response') ? 'bad response' : JSON.stringify({ answer: 'Synthetic synthesis', citations: [entry.block_id] });
      return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 100 } }) };
    };
    try {
      const result = await answerQuestion(lib, 'uniqueflower penguin');
      if (scenario === 'unrelated' || scenario === 'reorder keys') assert.equal(result.mode, 'synthesized');
      else {
        assert.equal(result.mode, 'none', scenario);
        assert.deepEqual(result.evidence, []);
        assert.match(result.answer, /changed/i);
        assert.equal(result.cost, null);
      }
    } finally {
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldKey;
      if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
    }
  }
});

test('manifest changes during ranking are caught before direct or no-key fallback', async t => {
  for (const query of ['uniqueflower', 'uniqueflower penguin']) {
    const lib = makeFixture(t);
    appendBlock(lib.rootDir, { title: 'Second', body: 'uniqueflower other record', lineage: 'second' });
    const fresh = loadLibrary(lib.rootDir), manifestPath = path.join(lib.rootDir, 'MANIFEST.json');
    const oldFetch = globalThis.fetch, oldKey = process.env.MEMORY_LANE_API_KEY, oldJev = process.env.MERGE_API_KEY;
    delete process.env.MEMORY_LANE_API_KEY; process.env.MERGE_API_KEY = 'synthetic-only';
    globalThis.fetch = async (_url, options) => {
      const keys = Object.keys(JSON.parse(options.body).questions);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.blocks = [];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      return { ok: true, json: async () => ({ answers: Object.fromEntries(keys.map(key => [key, { score: 2 }])) }) };
    };
    try {
      const result = await answerQuestion(fresh, query);
      assert.equal(result.mode, 'none', query);
      assert.deepEqual(result.evidence, []);
      assert.match(result.answer, /changed/i);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.MEMORY_LANE_API_KEY; else process.env.MEMORY_LANE_API_KEY = oldKey;
      if (oldJev === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldJev;
    }
  }
});

test('HTTP, CLI and MCP label a rejected synthesis as a source excerpt', async t => {
  let lib = makeFixture(t);
  appendBlock(lib.rootDir, { title: 'Second', body: 'uniqueflower second record', lineage: 'second' });
  appendBlock(lib.rootDir, { title: 'Third', body: 'uniqueflower third record', lineage: 'third' });
  lib = loadLibrary(lib.rootDir);
  const ids = lib.blocks.map(b => b.block_id);
  let content = JSON.stringify({ answer: 'Invented claim', citations: ['NOT_PRESENT'] });
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => provider.close());
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = { ...process.env, MEMORY_LANE_LIBRARY: lib.rootDir, MEMORY_LANE_API_KEY: 'synthetic-only',
    MEMORY_LANE_BASE_URL: `http://127.0.0.1:${provider.address().port}`, MERGE_API_KEY: '' };
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => server.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (true) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* server starting */ }
    if (Date.now() >= deadline || server.exitCode !== null) throw new Error('test server did not start');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const answer = await (await fetch(`${base}/api/answer?q=uniqueflower%20penguin`)).json();
  assert.equal(answer.mode, 'direct');
  assert.match(answer.note, /citation IDs could not be matched/);
  assert.doesNotMatch(answer.answer, /Invented claim/);
  async function run(args, input = '') {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdin.end(input);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, err);
    return out;
  }
  const cli = JSON.parse(await run(['tools/memory-lane-cli.mjs', 'answer', 'uniqueflower penguin']));
  assert.equal(cli.mode, 'direct');
  assert.equal(cli.cost, null);
  assert.match(cli.note, /citation IDs could not be matched/);
  assert.doesNotMatch(cli.answer, /Invented claim/);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ml_answer', arguments: { question: 'uniqueflower penguin' } } };
  const response = JSON.parse((await run(['tools/memory-lane-mcp.mjs'], JSON.stringify(request) + '\n')).trim());
  const text = response.result.content[0].text;
  assert.match(text, /\[source excerpt\]/);
  assert.match(text, /citation IDs could not be matched/);
  assert.doesNotMatch(text, /Invented claim|\[exact match\]/);

  content = JSON.stringify({ answer: 'The missing document FAKE_ID says this is verified.', citations: ids });
  const synthesized = await (await fetch(`${base}/api/answer?q=uniqueflower%20penguin`)).json();
  assert.equal(synthesized.mode, 'synthesized');
  assert.deepEqual(new Set(synthesized.citations), new Set(ids));
  assert.equal(synthesized.evidence.length, 3);
  assert.match(synthesized.citation_note, /source attributions.*not verified/i);
  const synthesizedCli = JSON.parse(await run(['tools/memory-lane-cli.mjs', 'answer', 'uniqueflower penguin']));
  assert.deepEqual(new Set(synthesizedCli.citations), new Set(ids));
  assert.equal(synthesizedCli.cost, null);
  assert.match(synthesizedCli.citation_note, /source attributions.*not verified/i);
  const synthesizedMcp = JSON.parse((await run(['tools/memory-lane-mcp.mjs'], JSON.stringify(request) + '\n')).trim()).result.content[0].text;
  for (const id of ids) assert.ok(synthesizedMcp.includes(id), `missing ${id}`);
  assert.match(synthesizedMcp, /source attributions.*not verified/i);
});
