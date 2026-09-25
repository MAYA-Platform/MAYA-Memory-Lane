#!/usr/bin/env node
/**
 * C1 (Packet 11) measurement: async background chain verification.
 *
 * Boots server.mjs against a target library on a test port and records:
 *   - time-to-listen (boot must not block on a full chain verify)
 *   - /api/status + /api/chain latency right after boot (chain = 202 PENDING)
 *   - /api/status latency DURING the background verify pass (the wedge-killer
 *     proof: the old code blocked the event loop for the whole verify; the
 *     new code must stay responsive while the worker runs)
 *   - time until the worker lands the verdict (poll /api/chain -> 200)
 *   - the landed verdict (intact/total/okCount) for cross-checking
 *
 * Usage:
 *   node tools/measure_c1_async.mjs <libraryPath> <port> [outJson]
 * Read-only: never writes to the library; worker state goes to a temp file.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const libraryPath = path.resolve(process.argv[2] || path.join(ROOT, 'sample-library'));
const port = Number(process.argv[3] || 8795);
const outJson = process.argv[4] || null;
const BASE = `http://127.0.0.1:${port}`;

const results = {
  tool: 'measure_c1_async',
  library: libraryPath,
  port,
  started_at: new Date().toISOString(),
  boot: {},
  post_boot_latency_ms: {},
  during_verify_latency_ms: {},
  verdict: {}
};

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

async function timedFetch(url) {
  const t0 = nowMs();
  const r = await fetch(url);
  const body = await r.json();
  return { ms: nowMs() - t0, status: r.status, body };
}

async function waitUp(deadlineMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return Date.now() - t0;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 50));
  }
  return -1;
}

const statePath = path.join(os.tmpdir(), `ml-c1-measure-${process.pid}-state.json`);
const t0Wall = Date.now();
const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(port), MEMORY_LANE_LIBRARY: libraryPath, MEMORY_LANE_SHADOW_STATE: statePath },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderrTail = '';
srv.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });

try {
  // 1. Boot: time from spawn to first successful /api/status.
  const tListen = await waitUp();
  results.boot.time_to_listen_ms = tListen;
  if (tListen < 0) throw new Error(`server did not come up; stderr: ${stderrTail}`);

  // 2. Immediate post-boot latencies (chain should be 202 PENDING here).
  for (const ep of ['/api/status', '/api/health', '/api/chain']) {
    results.post_boot_latency_ms[ep] = await timedFetch(`${BASE}${ep}`);
  }

  // 3. During-verify latency: sample /api/status every 5s while the worker
  //    runs. Old code would freeze these; new code must stay low.
  const sampleDeadline = Date.now() + 5 * 60 * 1000;
  let landed = null;
  let sampleCount = 0;
  while (Date.now() < sampleDeadline && !landed) {
    await new Promise((res) => setTimeout(res, 5000));
    const s = await timedFetch(`${BASE}/api/status`);
    if (!landed) {
      sampleCount += 1;
      results.during_verify_latency_ms[`sample_${sampleCount}`] = { endpoint: '/api/status', ms: s.ms };
    }
    const c = await timedFetch(`${BASE}/api/chain`);
    if (c.status === 200) landed = c;
  }
  results.during_verify_latency_ms.sample_count = sampleCount;
  if (!landed) throw new Error(`background verify did not land within 5min; stderr: ${stderrTail}`);
  results.verdict.time_to_verdict_ms = Date.now() - t0Wall;
  results.verdict.body = landed.body;

  // 4. Post-verdict latencies (cached path).
  for (const ep of ['/api/status', '/api/health', '/api/chain']) {
    results.post_verdict_latency_ms = results.post_verdict_latency_ms || {};
    results.post_verdict_latency_ms[ep] = await timedFetch(`${BASE}${ep}`);
  }
  results.finished_at = new Date().toISOString();
  results.ok = true;
} catch (e) {
  results.ok = false;
  results.error = String(e && e.message ? e.message : e);
  results.stderr_tail = stderrTail;
} finally {
  srv.kill();
  try { fs.rmSync(statePath, { force: true }); } catch { /* temp cleanup best-effort */ }
  const text = JSON.stringify(results, null, 2);
  if (outJson) fs.writeFileSync(path.resolve(outJson), text);
  console.log(text);
  process.exit(results.ok ? 0 : 1);
}
