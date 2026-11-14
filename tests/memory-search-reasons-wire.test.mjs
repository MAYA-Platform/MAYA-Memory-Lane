import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendBlock } from '../lib/memoryLaneCore.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-wire-reasons-'));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (let i = 0; i < 27; i++) appendBlock(root, { title: `Synthetic ${i}`, body: `orchidsentinel synthetic ${i}`, lineage: 'synthetic-shared' });
  let calls = 0;
  const decisions = http.createServer((req, res) => {
    calls++; const chunks = [];
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const questions = JSON.parse(Buffer.concat(chunks)).questions;
      const answers = Object.fromEntries(Object.keys(questions).map((key, index) => [key, { score: index >= 10 ? 2 : 1 }]));
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise(resolve => decisions.listen(0, '127.0.0.1', resolve));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    MEMORY_LANE_LIBRARY: root, MEMORY_LANE_MERGE_CONFIG: path.join(root, 'missing-config'),
    MERGE_API_KEY: 'synthetic-key', MEMORY_LANE_DECISIONS_URL: `http://127.0.0.1:${decisions.address().port}/decisions`, PORT: String(port) };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    decisions.closeAllConnections(); await new Promise(resolve => decisions.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 8000;
  while (true) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* wait for fixture */ }
    if (Date.now() > deadline || child.exitCode !== null) throw Error(`Synthetic server unavailable: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return { base, env, calls: () => calls };
}

function mcp(f, method, args, optIn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/memory-lane-mcp.mjs'], { cwd: path.resolve('.'),
      env: { ...f.env, ...(optIn ? { MEMORY_LANE_MCP_JEV_OPT_IN: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Synthetic MCP timed out')); }, 10000);
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code) return reject(Error(err));
      try { resolve(JSON.parse(out).result); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(args ? { params: args } : {}) }) + '\n');
  });
}

test('HTTP explanations are opt-in and preserve reranker promotion attribution', async t => {
  const f = await fixture(t);
  const get = async suffix => (await fetch(`${f.base}/api/search?q=orchidsentinel${suffix}`)).json();
  const plain = await get(''), explained = await get('&explain=1');
  assert.deepEqual(await get('&explain=0'), plain);
  assert.ok(plain.matches.every(row => !Object.hasOwn(row, 'retrieval_reasons')));
  assert.ok(explained.matches.every(row => row.retrieval_reasons.includes('fts')));
  assert.deepEqual(explained.matches.map(({ retrieval_reasons, ...row }) => row), plain.matches);
  assert.equal(f.calls(), 0);
  const reranked = await get('&rerank=jev&explain=1');
  assert.equal(f.calls(), 1); assert.equal(reranked.jev.applied, true);
  assert.ok(reranked.matches.some(row => row.via === 'jev-lineage' && row.retrieval_reasons.includes('jev_lineage')));
});

test('MCP exposes explicit boolean explanations without enabling Jev', async t => {
  const f = await fixture(t), args = { query: 'orchidsentinel', limit: 3 };
  const list = await mcp(f, 'tools/list');
  assert.equal(list.tools.find(tool => tool.name === 'ml_search').inputSchema.properties.explain.type, 'boolean');
  const plain = await mcp(f, 'tools/call', { name: 'ml_search', arguments: args });
  const detailed = await mcp(f, 'tools/call', { name: 'ml_search', arguments: { ...args, explain: true } });
  const falseFlag = await mcp(f, 'tools/call', { name: 'ml_search', arguments: { ...args, explain: false } });
  assert.equal(falseFlag.content[0].text, plain.content[0].text);
  assert.doesNotMatch(plain.content[0].text, /\[retrieval:/);
  assert.match(detailed.content[0].text, /\[retrieval: fts/);
  assert.match(detailed.content[0].text, /not relevance or source truth/); assert.equal(f.calls(), 0);
  const invalid = await mcp(f, 'tools/call', { name: 'ml_search', arguments: { ...args, explain: 'true' } });
  assert.equal(invalid.isError, true); assert.equal(f.calls(), 0);
  const ranked = await mcp(f, 'tools/call', { name: 'ml_search', arguments: { ...args, explain: true, rerank: 'jev' } }, true);
  assert.equal(f.calls(), 1); assert.match(ranked.content[0].text, /\[retrieval: jev_lineage\]/);
});
