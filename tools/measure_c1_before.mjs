#!/usr/bin/env node
/**
 * C1 (Packet 11) BEFORE-measurement: HEAD server.mjs (sync verify in request
 * path). Boots the pre-C1 server against the live library and records what a
 * caller experienced: /api/chain latency (full sync verify every call) and
 * /api/status latency during that window.
 * Usage: node tools/measure_c1_before.mjs <libraryPath> <port> [outJson]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const libraryPath = path.resolve(process.argv[2] || 'sample-library');
const port = Number(process.argv[3] || 8796);
const outJson = process.argv[4] || null;
const BASE = `http://127.0.0.1:${port}`;
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

async function timedFetch(url) {
  const t0 = nowMs();
  try {
    const r = await fetch(url);
    const body = await r.json();
    return { ms: nowMs() - t0, status: r.status };
  } catch (e) {
    return { ms: nowMs() - t0, status: 0, error: String(e.cause || e).slice(0, 60) };
  }
}

const statePath = path.join(os.tmpdir(), `ml-c1-before-${process.pid}-state.json`);
const srv = spawn(process.execPath, [path.resolve('server.mjs')], {
  env: { ...process.env, PORT: String(port), MEMORY_LANE_LIBRARY: libraryPath, MEMORY_LANE_SHADOW_STATE: statePath },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderrTail = '';
srv.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-1500); });

const results = { tool: 'measure_c1_before', library: libraryPath, port, started_at: new Date().toISOString() };

try {
  // Wait for listen (HEAD boots fast; verify happens per-request).
  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !up) {
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) up = true; } catch {}
    if (!up) await new Promise((res) => setTimeout(res, 100));
  }
  if (!up) throw new Error(`server did not come up; stderr: ${stderrTail}`);
  results.time_to_listen_ms = Date.now() - t0;

  // THE BEFORE NUMBER: /api/chain = full synchronous verifyChain per call.
  results.chain_call = await timedFetch(`${BASE}/api/chain`);
  // /api/status during that same era: verify already done, so this is fast —
  // record it as the no-contention baseline.
  results.status_call_after = await timedFetch(`${BASE}/api/status`);
  // Second chain call (no cache in HEAD): proves it is every-call, not once.
  results.chain_call_2 = await timedFetch(`${BASE}/api/chain`);
  results.ok = true;
} catch (e) {
  results.ok = false;
  results.error = String(e && e.message ? e.message : e);
  results.stderr_tail = stderrTail;
} finally {
  srv.kill();
  try { fs.rmSync(statePath, { force: true }); } catch {}
  const text = JSON.stringify(results, null, 2);
  if (outJson) fs.writeFileSync(path.resolve(outJson), text);
  console.log(text);
  process.exit(results.ok ? 0 : 1);
}
