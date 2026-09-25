#!/usr/bin/env node
/**
 * Memory Lane — standalone public server.
 *
 * Serves the Memory Lane web UI and its API endpoints with zero dependencies
 * beyond Node's built-in runtime:
 *
 *   GET /                          -> memory-lane.html
 *   GET /api/status                -> library stats + chain verdict
 *   GET /api/blocks                -> block list (manifest order)
 *   GET /api/recent?n=             -> recent blocks digest (bodies, for session start)
 *   GET /api/blocks/:libId         -> one block (frontmatter + body)
 *   GET /api/chain                 -> full SHA-256 chain verification walk
 *   GET /api/search?q=             -> plain-text search across block bodies
 *                                     (?rerank=jev adds JevRank re-scoring)
 *   GET /api/health                -> capability probe (jev: true|false)
 *                                     + cached chain verdict (intact/status)
 *   GET /api/jevstats              -> JevRank cost receipt (calls + $)
 *   GET /api/resume?phrase=        -> resolve a resume phrase
 *   GET /api/export                -> deterministic JSON export of the library
 *   POST /api/ingest               -> seal a new memory (auto fact extraction)
 *   POST /api/blocks               -> seal a new memory with explicit facts
 *   GET /api/answer?q=             -> answer a question (direct / synthesized /
 *                                     none — the retrieval confidence gate)
 *
 * Write endpoints (v3, 2026-08-05): a library is no longer read-only. POST a
 * transcript (or a hand-written memory) and Memory Lane extracts durable
 * facts via the recommended model (deepseek v4 flash via DeepSeek,
 * falling back to local Ollama), appends a chain-linked block, and returns
 * the new block plus a fresh chain verdict. The same max+1 / prev_sha256
 * semantics as the continuity registrar keep the chain tamper-evident.
 *
 * Ingest body (JSON):
 *   { text, title?, source?, lineage?, facts?, extract? }
 *   - text:    required. Raw transcript or memory text.
 *   - title:   optional block title (defaults to a short auto title).
 *   - source:  optional provenance tag (e.g. 'telegram', 'inbox', 'api').
 *   - lineage: optional lineage name (default 'auto').
 *   - facts:   optional explicit fact list; when present, skips extraction.
 *   - extract: optional bool (default true) — set false to seal raw text
 *              without LLM extraction.
 *
 * The library it reads defaults to ./empty-library (blank first run: your
 * memory lane is empty until you seal records or load the bundled sample)
 * and can be pointed at any real Memory Lane library via the
 * MEMORY_LANE_LIBRARY environment variable. Files are the source of truth;
 * the write endpoints are the sanctioned way to grow the library.
 *
 * Usage:
 *   node server.mjs                    # port 8766, sample library
 *   PORT=9000 MEMORY_LANE_LIBRARY=/path/to/library node server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadLibrary,
  readBlock,
  verifyChain,
  search,
  resolveResume,
  exportLibrary,
  libraryStats,
  appendBlock
} from './lib/memoryLaneCore.js';
import { ingestTranscript } from './lib/extract.js';
import { answerQuestion } from './lib/answer.js';
import { jevRank, jevAvailable, jevStats, resolveJevKey } from './lib/jevrank.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8766);
const DEFAULT_LIBRARY_PATH = path.join(ROOT, 'empty-library');
const SAMPLE_LIBRARY_PATH = path.join(ROOT, 'sample-library');
// A fresh boot is BLANK by default. The bundled sample is only loaded when
// the user explicitly clicks "Load sample" (or MEMORY_LANE_LIBRARY points
// at a real library). A user's clone never sees anyone else's data.
let activeLibraryPath = process.env.MEMORY_LANE_LIBRARY
  ? path.resolve(process.env.MEMORY_LANE_LIBRARY)
  : DEFAULT_LIBRARY_PATH;
const EXTERNAL_LIBRARY = Boolean(process.env.MEMORY_LANE_LIBRARY);
const UI_PATH = path.join(ROOT, 'public', 'memory-lane.html');
const IMAGES_DIR = path.join(ROOT, 'public', 'images');

// ── Write authentication (C2, Packet 10) ─────────────────────────────
// LOCAL write-auth for the write endpoints (/api/write-memory family).
// Token source: MEMORY_LANE_WRITE_TOKEN env first, then <library>/.write_token
// file (mode 0600). No hardcoded secret anywhere. READ endpoints are
// unaffected. Feature-flagged: MEMORY_LANE_WRITE_AUTH=off (default) = log-only
// shadow mode; =on = enforce. Every rejected attempt lands in a shadow log.
const WRITE_AUTH_ENABLED = String(process.env.MEMORY_LANE_WRITE_AUTH || 'off').toLowerCase() === 'on';
const WRITE_AUTH_SHADOW_LOG = path.join(
  process.env.MEMORY_LANE_LIBRARY ? path.resolve(process.env.MEMORY_LANE_LIBRARY) : DEFAULT_LIBRARY_PATH,
  'health', 'write_auth_shadow.log.jsonl'
);
const WRITE_AUTH_REASON = {
  ok: 'ok',
  disabled: 'auth_disabled',           // flag off — shadow-log only
  missing: 'token_missing',            // no token presented
  mismatch: 'token_mismatch',          // wrong token
  unconfigured: 'token_unconfigured',  // no token on server side
  error: 'auth_internal_error'
};
function sha256b(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function resolveWriteToken() {
  const env = process.env.MEMORY_LANE_WRITE_TOKEN;
  if (env && String(env).trim()) return { token: String(env).trim(), from: 'env' };
  const tokPath = path.join(activeLibraryPath, '.write_token');
  try {
    if (fs.existsSync(tokPath)) {
      const tok = fs.readFileSync(tokPath, 'utf8').trim();
      if (tok) return { token: tok, from: 'file' };
    }
  } catch { /* unreadable token file = unconfigured */ }
  return { token: null, from: 'none' };
}
function extractPresentedToken(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  if (h['x-write-token']) return String(h['x-write-token']).trim();
  return null;
}
/**
 * Write-auth gate for the write endpoints.
 * Returns { allow, reason, from, presented } — never throws.
 * Shadow mode (flag off): always allow, but log what WOULD have been rejected.
 */
function checkWriteAuth(req) {
  const presented = extractPresentedToken(req);
  const { token, from } = resolveWriteToken();
  let reason;
  if (!WRITE_AUTH_ENABLED) {
    reason = presented ? WRITE_AUTH_REASON.ok : WRITE_AUTH_REASON.disabled;
  } else if (!token) {
    reason = WRITE_AUTH_REASON.unconfigured; // fail-closed: no token configured = reject all
  } else if (!presented) {
    reason = WRITE_AUTH_REASON.missing;
  } else if (!timingSafeEqualHex(sha256b(presented), sha256b(token))) {
    reason = WRITE_AUTH_REASON.mismatch;
  } else {
    reason = WRITE_AUTH_REASON.ok;
  }
  const allow = reason === WRITE_AUTH_REASON.ok || reason === WRITE_AUTH_REASON.disabled;
  return { allow, reason, from, presented: Boolean(presented) };
}
/** Shadow-log one write-auth decision. Never throws; path redacted. */
function shadowLogWriteAuth({ req, verdict, note }) {
  try {
    fs.mkdirSync(path.dirname(WRITE_AUTH_SHADOW_LOG), { recursive: true });
    fs.appendFileSync(WRITE_AUTH_SHADOW_LOG, JSON.stringify({
      at: new Date().toISOString(),
      remote: req.socket?.remoteAddress || null,
      path: String(req.url || '').split('?')[0],
      method: req.method,
      verdict,
      note: note || null
    }) + '\n', 'utf8');
  } catch { /* logging must never break serving */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

/** Read and JSON-parse a request body (capped at 2 MB). */
function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({ error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ error: 'request error' }));
  });
}

/** Derive a short display title from the first non-empty line of text. */
function deriveTitle(text, max = 72) {
  const first = String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const clean = first.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ');
  return clean.slice(0, max) || 'Memory block';
}

// ── Library cache (t_1768d604) ─────────────────────────────────────────
// getLibrary() used to call loadLibrary() on EVERY request. On a 2137-block
// external library that cost (a) a MANIFEST.json re-read + re-parse per
// request and (b) — the bigger hit — a fresh library object per request,
// which defeated the FTS_CACHE WeakMap in memoryLaneCore.js, so every search
// rebuilt the whole FTS5 index from disk (every block file re-read).
// Measured 2026-09-24: healthy-window search 9.3s; under disk contention
// searches exceeded 60s while /api/health stayed 0.003s (it never touches
// the library).
//
// Fix: cache the loaded library object keyed by path + MANIFEST.json mtime.
// A cache hit costs one stat() instead of a manifest parse + full index
// rebuild. appendBlock() rewrites the manifest on every seal, so any write
// invalidates the cache on the next request — no TTL guessing, no stale
// reads. Mode switches reassign activeLibraryPath, so each path keeps its
// own entry and re-resolves correctly.
const LIB_TTL_MS = 5 * 60 * 1000; // belt-and-suspenders: full reload at most every 5 min
let libraryCache = { key: null, at: 0, lib: null };

function getLibrary() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(path.join(activeLibraryPath, 'MANIFEST.json')).mtimeMs;
  } catch { /* fall through: loadLibrary reports the precise reason */ }
  const key = `${activeLibraryPath}|${mtimeMs}`;
  const now = Date.now();
  if (libraryCache.lib && libraryCache.key === key && now - libraryCache.at < LIB_TTL_MS) {
    return libraryCache.lib;
  }
  const lib = loadLibrary(activeLibraryPath);
  libraryCache = lib.ok ? { key, at: now, lib } : { key: null, at: 0, lib: null };
  return lib;
}

/**
 * Public library label. Never leaks an absolute machine path: the bundled
 * empty and sample libraries are shown by their relative name; an external
 * library is shown as given (it is the user's own path).
 */
function libraryLabel() {
  if (activeLibraryPath === SAMPLE_LIBRARY_PATH) return 'sample-library (bundled)';
  if (activeLibraryPath === DEFAULT_LIBRARY_PATH) return 'empty-library (bundled)';
  const rel = path.relative(ROOT, activeLibraryPath);
  return rel && !rel.startsWith('..') ? rel : activeLibraryPath;
}

/** Current mode: 'empty' | 'sample' | 'external'. */
function currentMode() {
  if (EXTERNAL_LIBRARY) return 'external';
  if (activeLibraryPath === SAMPLE_LIBRARY_PATH) return 'sample';
  return 'empty';
}

// Background chain re-verifier: /api/status NEVER runs verifyChain in the
// request path (see route comment). This timer re-verifies every 30 minutes
// while the event loop is otherwise idle; until its first pass completes the
// status endpoint reports chain.status 'unverified' (honest, not a lie).
//
// C1 (Packet 11): the interval tick itself used to call verifyChain
// SYNCHRONOUSLY on the main event loop — a periodic wedge on 2k+ block
// libraries (Packet 10 measured 30.4s cold; live 2138-block library measured
// 141.5s per shadow-health cycle). The tick now schedules a full verify in a
// DEDICATED WORKER PROCESS (tools/shadow_health.mjs --once) and only applies
// its atomic state file when it completes. The event loop never blocks.
const chainCache = { at: 0, result: null, refreshing: false };
const CHAIN_VERIFY_INTERVAL_MS = 30 * 60 * 1000;
const SHADOW_HEALTH_TOOL = path.join(ROOT, 'tools', 'shadow_health.mjs');
// Freshness contract: a cached verdict older than this is served as STALE,
// never silently HEALTHY (Packet 11 C1 acceptance). 2x interval + slack,
// mirroring shadow_health.mjs's own staleness math.
const CHAIN_STALE_AFTER_MS = CHAIN_VERIFY_INTERVAL_MS * 2 + 60 * 1000;

function chainFreshness() {
  if (!chainCache.result) return 'UNVERIFIED';
  if (!chainCache.at || Date.now() - chainCache.at > CHAIN_STALE_AFTER_MS) return 'STALE';
  return 'CURRENT';
}

function applyShadowState(state) {
  if (!state || typeof state !== 'object') return false;
  const chain = state.chain || {};
  chainCache.result = {
    intact: Boolean(chain.intact),
    status: chain.status || (chain.intact ? 'intact' : 'issues'),
    total: chain.total ?? null,
    okCount: chain.okCount ?? 0,
    issues: chain.issues ?? [],
    hardIssues: chain.hardIssues ?? 0,
    unchecked: chain.unchecked ?? 0,
    // Classify the library-level verdict from the worker's classification.
    // Kept distinct from per-block status so /api/status semantics are
    // unchanged for callers that only read intact/okCount.
    worker_classification: state.classification || null
  };
  chainCache.at = Number(state.at) || Date.now();
  return true;
}

// Seed the cache from the last shadow-health state file if one exists and is
// fresher than what we have (fast boot: no sync verify needed at startup).
function seedChainCacheFromShadowState() {
  try {
    const statePath = process.env.MEMORY_LANE_SHADOW_STATE;
    if (!statePath || !fs.existsSync(statePath)) return;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state && state.chain && Number(state.at) > chainCache.at) applyShadowState(state);
  } catch { /* no seed available; boot stays 'unverified' honestly */ }
}

// Spawn tools/shadow_health.mjs --once as a detached worker. Never blocks the
// event loop; results land in the state file and are applied on completion.
function scheduleBackgroundVerify(reason) {
  if (chainCache.refreshing) return;
  if (!fs.existsSync(SHADOW_HEALTH_TOOL)) return; // tool missing: keep cache, stay honest
  chainCache.refreshing = true;
  const statePath = process.env.MEMORY_LANE_SHADOW_STATE
    || path.join(os.tmpdir(), `memory-lane-chain-state-${process.pid}.json`);
  const libPath = activeLibraryPath;
  const child = spawn(process.execPath, [
    SHADOW_HEALTH_TOOL, '--library', libPath, '--state', statePath, '--once'
  ], { stdio: 'ignore', windowsHide: true });
  child.on('exit', (code) => {
    chainCache.refreshing = false;
    try {
      if (code === 0 && fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        // Only apply results for the library that was active when scheduled.
        if (state && path.resolve(state.library || '') === path.resolve(libPath)) {
          applyShadowState(state);
        }
      }
    } catch { /* keep last known result */ }
  });
  child.on('error', () => { chainCache.refreshing = false; });
}

function backgroundVerifyChain() {
  scheduleBackgroundVerify('interval');
}

/**
 * C1 (Packet 11): O(1) post-write integrity check. Verifies ONLY the block
 * that was just appended, using the same per-block logic verifyChain applies:
 * recompute the file hash vs manifest, confirm the manifest's prev_block_id
 * matches what ingest reported, and confirm the previous block's recorded
 * hash matches the manifest's prev_sha256. One file read + two manifest
 * lookups — constant time regardless of library size. NOT a full-library
 * verify; the background worker owns that.
 */
function checkAppendedBlock(lib, ingestResult) {
  try {
    const entry = lib.blocks.find((b) => b.lib_id === Number(ingestResult.lib_id));
    if (!entry) {
      return { ok: true, verdict: { status: 'missing_from_manifest', lib_id: ingestResult.lib_id } };
    }
    const block = readBlock(lib, entry.lib_id);
    if (!block || !block.present) {
      return { ok: true, verdict: { status: 'missing', lib_id: entry.lib_id, block_id: entry.block_id } };
    }
    const hashOk = block.sha256 === entry.sha256 && entry.sha256 === ingestResult.sha256;
    const prevIdOk = (entry.prev_block_id || null) === (ingestResult.prev_block_id || null);
    let prevHashOk = true;
    if (entry.prev_block_id && entry.prev_sha256) {
      const prevEntry = lib.blocks.find((b) => b.block_id === entry.prev_block_id);
      prevHashOk = !prevEntry || prevEntry.sha256 === entry.prev_sha256;
    }
    const status = hashOk && prevIdOk && prevHashOk ? 'ok'
      : !hashOk ? 'hash_mismatch' : 'link_issue';
    return {
      ok: true,
      verdict: {
        status,
        lib_id: entry.lib_id,
        block_id: entry.block_id,
        hash_ok: hashOk,
        prev_ok: prevIdOk && prevHashOk,
        checked_at: new Date().toISOString()
      }
    };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// C1 (Packet 11): single scheduler — seed from prior shadow state (honest
// restart), kick one worker pass after boot (never blocking listen()), then
// refresh every CHAIN_VERIFY_INTERVAL_MS via the dedicated worker process.
// The old synchronous boot verify is gone: it blocked startup for the full
// verify duration on big libraries.
seedChainCacheFromShadowState();
setTimeout(() => scheduleBackgroundVerify('boot'), 1500);
setInterval(backgroundVerifyChain, CHAIN_VERIFY_INTERVAL_MS);

// Verify the ACTIVE library right now, synchronously. Only the API-switchable
// libraries (sample: 7 blocks, empty: 0) ever call this — both tiny, so the
// switch stays instant while still honoring the verified-chain contract. The
// big external library NEVER gets verified in a request path: it's served
// from the background worker's cached verdict.
function verifyActiveLibraryNow() {
  const lib = loadLibrary(activeLibraryPath);
  if (lib.ok) {
    chainCache.result = verifyChain(lib);
    chainCache.at = Date.now();
  } else {
    chainCache.result = null;
  }
}

const routes = {
  '/api/status': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    // Chain verify re-reads EVERY block file synchronously (~22s at 1800+
    // blocks on HDD, growing) — running it in the request path blocks the whole
    // event loop and wedges every other endpoint behind it (2026-09-18 wave-30
    // incident). NEVER verify in a request: stats come from the manifest, the
    // chain comes from the background re-verifier (setInterval below), which
    // runs when the loop is idle and reports whatever it last completed.
    const stats = {
      totalBlocks: lib.blocks.length,
      totalShelves: lib.totalShelves || new Set(lib.blocks.map((b) => b.shelf)).size,
      lineageCount: new Set(lib.blocks.map((b) => b.lineage).filter(Boolean)).size,
      firstBlock: lib.blocks.length ? Math.min(...lib.blocks.map((b) => b.lib_id)) : null,
      lastBlock: lib.blocks.length ? Math.max(...lib.blocks.map((b) => b.lib_id)) : null,
      chainIntact: chainCache.result ? chainCache.result.intact : null,
      issues: chainCache.result ? chainCache.result.issues : [],
      okCount: chainCache.result ? chainCache.result.okCount : 0
    };
    const chain = chainCache.result || { intact: null, status: 'unverified', total: lib.blocks.length, okCount: 0, issues: [], hardIssues: [], unchecked: [] };
    sendJson(res, 200, {
      ok: true,
      library: libraryLabel(),
      mode: currentMode(),
      stats,
      chain: {
        intact: chain.intact,
        status: chain.status,
        total: chain.total,
        okCount: chain.okCount,
        issues: chain.issues,
        hardIssues: chain.hardIssues,
        unchecked: chain.unchecked,
        freshness: chainFreshness(),
        verifiedAt: chainCache.at ? new Date(chainCache.at).toISOString() : null
      }
    });
  },

  '/api/blocks': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const blocks = lib.blocks
      .slice()
      .sort((a, b) => a.lib_id - b.lib_id)
      .map((b) => ({
        lib_id: b.lib_id,
        block_id: b.block_id,
        canonical_name: b.canonical_name || b.block_id,
        lineage: b.lineage || null,
        shelf: b.shelf,
        status: b.status || 'active',
        sha256: (b.sha256 || '').slice(0, 16),
        prev_block_id: b.prev_block_id || null
      }));
    sendJson(res, 200, { ok: true, count: blocks.length, blocks });
  },

  '/api/recent': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const n = Math.min(Math.max(Number(url.searchParams.get('n') || 5) || 5, 1), 20);
    const recent = lib.blocks
      .slice()
      .sort((a, b) => a.lib_id - b.lib_id)
      .slice(-n)
      .reverse()
      .map((entry) => {
        const block = readBlock(lib, entry.lib_id);
        return {
          lib_id: entry.lib_id,
          block_id: entry.block_id,
          display_name: entry.canonical_name || entry.block_id,
          lineage: entry.lineage || null,
          body: block && block.present ? block.body.slice(0, 300) : '',
          sha256: (entry.sha256 || '').slice(0, 16)
        };
      });
    sendJson(res, 200, { ok: true, count: recent.length, blocks: recent });
  },

  '/api/chain': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    // C1 (Packet 11): /api/chain no longer runs verifyChain synchronously per
    // request — on a 2k+ block library that wedged the event loop for the
    // whole verify (0.45s per call on the SSD fixture; 141.5s on the live
    // HDD library). It now serves the background verifier's cached verdict
    // with an explicit freshness field, and `?deep=1` schedules an on-demand
    // worker pass (async, never in-request) for callers that need the latest
    // truth. Per-block details only come from the cached verdict.
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.searchParams.get('deep') === '1') scheduleBackgroundVerify('deep-request');
    const chain = chainCache.result;
    if (!chain) {
      // No verdict yet: report honestly and schedule, never block.
      scheduleBackgroundVerify('no-cache');
      return sendJson(res, 202, {
        ok: true,
        pending: true,
        freshness: 'UNVERIFIED',
        detail: 'chain verification running in background worker; retry shortly or read /api/health'
      });
    }
    sendJson(res, 200, {
      ok: true,
      intact: chain.intact,
      status: chain.status,
      total: chain.total,
      okCount: chain.okCount,
      issues: chain.issues,
      verifiedRun: chain.verifiedRun ?? null,
      freshness: chainFreshness(),
      verifiedAt: chainCache.at ? new Date(chainCache.at).toISOString() : null,
      // Per-block details come from the worker's classification lists (missing
      // / hash_issues), not a full blocks array — a 2k-entry per-request
      // payload was part of the original wedge cost. Deep per-block truth is
      // one `?deep=1` away via the worker's state file.
      problem_blocks: chain.worker_classification || null
    });
  },

  '/api/blocks/:libId': (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m = /^\/api\/blocks\/(\d+)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { ok: false, error: 'not found' });
    const libId = Number(m[1]);
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const block = readBlock(lib, libId);
    if (!block) return sendJson(res, 404, { ok: false, error: `block ${libId} not in library` });
    sendJson(res, 200, {
      ok: true,
      lib_id: block.lib_id,
      block_id: block.block_id,
      present: block.present,
      fields: block.fields || {},
      body: block.body || null,
      sha256: block.sha256 || null,
      reason: block.reason || null
    });
  },

  '/api/search': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams.get('q') || '';
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const result = search(lib, q);
    // JevRank (opt-in): ?rerank=jev re-scores the top candidates with ONE
    // batched Jev call. Defensive: any Jev problem returns plain full-text
    // results unchanged — the shim can never break search.
    if (url.searchParams.get('rerank') === 'jev') {
      const t0 = Date.now();
      const ranked = await jevRank(lib, q, result.matches, { topN: 10 });
      if (ranked.jev && ranked.jev.applied) ranked.jev.latency_ms = Date.now() - t0;
      sendJson(res, 200, { ok: true, query: q, count: ranked.matches.length, matches: ranked.matches, jev: ranked.jev });
      return;
    }
    sendJson(res, 200, { ok: true, ...result });
  },

  '/api/health': (req, res) => {
    // Capability probe for MCP tools: rerank=jev is offered only when a key
    // resolves. No key material is ever echoed. The chain field surfaces the
    // background verifier's cached verdict (computed at boot, refreshed every
    // 30 min — NEVER in the request path, see /api/status comment) so a
    // broken/missing chain is visible to any caller, not silent. It always
    // describes the currently active library.
    const chain = chainCache.result
      || { intact: null, status: 'unverified', total: null, okCount: 0, issues: 0, hardIssues: 0, unchecked: 0 };
    sendJson(res, 200, {
      ok: true,
      jev: jevAvailable(),
      jev_model: 'typesafe/jev-1.13',
      key_source: process.env.MERGE_API_KEY ? 'env' : (resolveJevKey() ? 'config' : 'none'),
      chain: {
        intact: chain.intact,
        status: chain.status,
        total: chain.total,
        okCount: chain.okCount,
        issues: chain.issues,
        hardIssues: chain.hardIssues,
        unchecked: chain.unchecked,
        freshness: chainFreshness(),
        verifiedAt: chainCache.at ? new Date(chainCache.at).toISOString() : null
      }
    });
  },

  '/api/ready': (req, res) => {
    // Readiness probe that actually EXERCISES the library read path.
    // /api/health answers 0.003s without touching disk (capability probe +
    // cached chain verdict), so it stayed green while searches wedged under
    // disk contention (t_1768d604). This endpoint loads the library and
    // reads one block file — the same path every search/answer runs — so a
    // 200 here means search CAN serve, not just that the process is alive.
    const t0 = Date.now();
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 503, { ok: false, ready: false, reason: lib.reason });
    const probeId = lib.blocks.length ? lib.blocks[lib.blocks.length - 1].lib_id : null;
    const probe = probeId !== null ? readBlock(lib, probeId) : { present: true };
    const ready = Boolean(probe && probe.present);
    sendJson(res, ready ? 200 : 503, {
      ok: ready,
      ready,
      mode: currentMode(),
      library: libraryLabel(),
      totalBlocks: lib.blocks.length,
      probe_block: probeId,
      latency_ms: Date.now() - t0
    });
  },

  '/api/jevstats': (req, res) => {
    // Cost receipt: lifetime Jev call counter since server start. Proves pennies.
    sendJson(res, 200, { ok: true, ...jevStats() });
  },

  '/api/resume': (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const phrase = url.searchParams.get('phrase') || '';
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const result = resolveResume(lib, phrase);
    sendJson(res, 200, { ok: true, ...result });
  },

  '/api/export': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const bundle = exportLibrary(lib);
    sendJson(res, 200, bundle);
  },

  '/api/mode': (req, res) => {
    sendJson(res, 200, { ok: true, mode: currentMode(), library: libraryLabel() });
  },

  '/api/load-sample': (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    }
    if (EXTERNAL_LIBRARY) {
      return sendJson(res, 400, { ok: false, error: 'an external library is configured; sample switching is disabled' });
    }
    activeLibraryPath = SAMPLE_LIBRARY_PATH;
    verifyActiveLibraryNow(); // switch is synchronous + cheap (7 blocks): status stays verified
    sendJson(res, 200, { ok: true, mode: 'sample', library: libraryLabel() });
  },

  '/api/load-empty': (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    }
    if (EXTERNAL_LIBRARY) {
      return sendJson(res, 400, { ok: false, error: 'an external library is configured; sample switching is disabled' });
    }
    activeLibraryPath = DEFAULT_LIBRARY_PATH;
    verifyActiveLibraryNow(); // switch is synchronous + cheap (0 blocks): status stays verified
    sendJson(res, 200, { ok: true, mode: 'empty', library: libraryLabel() });
  },

  /**
   * Shared write handler for POST /api/ingest and POST /api/blocks.
   * Both seal a new memory onto the chain; ingest additionally runs
   * automatic fact extraction unless facts are supplied explicitly.
   */
  '/api/write-memory': async (req, res, { autoExtract = true } = {}) => {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    // C2 write-auth gate (Packet 10): every write POST passes the gate first.
    // Shadow mode (flag off) allows but logs; enforce mode rejects with 401/403.
    const auth = checkWriteAuth(req);
    if (auth.reason !== WRITE_AUTH_REASON.ok || !WRITE_AUTH_ENABLED) {
      shadowLogWriteAuth({ req, verdict: auth.reason, note: `enforced=${WRITE_AUTH_ENABLED}` });
    }
    if (!auth.allow) {
      if (auth.reason === WRITE_AUTH_REASON.missing) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="memory-lane-write"');
      }
      return sendJson(res, auth.reason === WRITE_AUTH_REASON.missing ? 401 : 403, {
        ok: false,
        error: auth.reason === WRITE_AUTH_REASON.missing
          ? 'write authentication required'
          : 'write authentication failed',
        reason: auth.reason
      });
    }
    const body = await readJsonBody(req);
    if (body && body.error) {
      return sendJson(res, 400, { ok: false, error: body.error });
    }
    const text = String((body && body.text) || '').trim();
    if (!text) {
      return sendJson(res, 400, { ok: false, error: 'text is required' });
    }
    if (!EXTERNAL_LIBRARY) {
      // Guard: never write into the bundled demo libraries. A real library
      // must be mounted via MEMORY_LANE_LIBRARY to accept writes.
      return sendJson(res, 400, {
        ok: false,
        error: 'writes are disabled on the bundled demo libraries; mount a library via MEMORY_LANE_LIBRARY'
      });
    }
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });

    const result = await ingestTranscript(activeLibraryPath, {
      title: (body && body.title) || deriveTitle(text),
      body: text,
      source: (body && body.source) || null,
      lineage: (body && body.lineage) || 'auto',
      extract: autoExtract && !(body && Array.isArray(body.facts)),
      facts: (body && body.facts) || null
    });
    if (!result.ok) {
      return sendJson(res, 500, { ok: false, reason: result.reason });
    }
    // C1 (Packet 11): the post-write full verifyChain was the second request
    // path wedge — every write paid a full-library verify (0.6s at 2.2k blocks
    // on SSD; minutes on the live HDD library). Replaced with an O(1)
    // incremental check of JUST the newly appended block against the manifest
    // (hash + prev-link), the same per-block logic verifyChain applies. Full
    // verification remains the background worker's job; the write response
    // reports the incremental verdict plus the cached library verdict with
    // freshness so callers can see both.
    const libAfter = loadLibrary(activeLibraryPath);
    const linkCheck = libAfter.ok
      ? checkAppendedBlock(libAfter, result)
      : { ok: false, reason: libAfter.reason };
    const cachedChain = chainCache.result;
    sendJson(res, result.skipped ? 200 : 201, {
      ok: true,
      skipped: result.skipped || false,
      lib_id: result.lib_id,
      block_id: result.block_id,
      shelf: result.shelf,
      filename: result.filename,
      sha256: result.sha256,
      prev_block_id: result.prev_block_id,
      extraction: result.extraction || null,
      chain: {
        // Incremental verdict for the appended block (O(1), honest about what
        // it covers — it is NOT a full-library verify).
        appended_block: linkCheck.ok ? linkCheck.verdict : { status: 'error', reason: linkCheck.reason },
        library: cachedChain
          ? {
              intact: cachedChain.intact,
              status: cachedChain.status,
              total: cachedChain.total,
              okCount: cachedChain.okCount,
              issues: cachedChain.issues,
              freshness: chainFreshness(),
              note: 'cached from background verify; full re-verify scheduled'
            }
          : null
      }
    });
    // A write changed the library: schedule a fresh background verify so the
    // cached verdict converges to the new truth without blocking anyone.
    scheduleBackgroundVerify('post-write');
  },

  '/api/ingest': (req, res) => routes['/api/write-memory'](req, res, { autoExtract: true }),
  '/api/blocks/write': (req, res) => routes['/api/write-memory'](req, res, { autoExtract: false }),

  '/api/observe': async (req, res) => {
    // POST — run the deterministic Observer over one message (or a batch).
    // Body: { message: "text", speaker?, session_id?, timestamp? } or
    //       { messages: [...] }.
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    if (!activeLibraryPath) {
      return sendJson(res, 400, { ok: false, error: 'a library must be mounted to observe' });
    }
    const body = await readJsonBody(req);
    if (body && body.error) return sendJson(res, 400, { ok: false, error: body.error });
    const { observeMessage } = await import('./lib/observations.js');
    const captures = [];
    const msgs = Array.isArray(body && body.messages) ? body.messages
      : (body && body.message) ? [body] : [];
    for (const m of msgs) {
      if (!m || !m.message) continue;
      const obs = observeMessage(lib, {
        speaker: m.speaker || 'user',
        content: m.message,
        session_id: m.session_id || null,
        message_id: m.message_id || null,
        timestamp: m.timestamp || undefined,
        source_ref: m.source_ref || null,
      });
      if (obs) captures.push(obs);
    }
    const stats = (await import('./lib/observations.js')).observationStats(lib);
    sendJson(res, 200, { ok: true, captured: captures.length, observations: captures, stats });
  },

  '/api/inject': async (req, res) => {
    // GET — return the session-start snapshot (Injector output).
    // Query: ?topics=a,b&pins=x,y&budget=3500
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const { buildSnapshot } = await import('./lib/injector.js');
    const topics = (url.searchParams.get('topics') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const pins = (url.searchParams.get('pins') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const budget = parseInt(url.searchParams.get('budget') || '3500', 10);
    const result = buildSnapshot(lib, { topics, pins, budget });
    sendJson(res, 200, { ok: true, snapshot: result.snapshot, charCount: result.charCount });
  },

  '/api/answer': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) {
      return sendJson(res, 400, { ok: false, error: 'q is required' });
    }
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const result = await answerQuestion(lib, q);
    sendJson(res, 200, { ok: true, ...result });
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const handler = routes[pathname];
    if (handler) {
      // Async route handlers (write endpoints) return a promise.
      const out = handler(req, res);
      if (out && typeof out.catch === 'function') {
        out.catch((err) => {
          if (res.headersSent) return;
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
        });
      }
      return;
    }
    // Pattern routes: /api/blocks/:libId
    const blockMatch = /^\/api\/blocks\/(\d+)$/.exec(pathname);
    if (blockMatch) return routes['/api/blocks/:libId'](req, res);
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  // Static image assets from public/images
  if (pathname.startsWith('/images/')) {
    const filePath = path.join(IMAGES_DIR, path.basename(pathname));
    if (fs.existsSync(filePath)) return sendFile(res, filePath);
    return sendJson(res, 404, { ok: false, error: 'image not found' });
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (!fs.existsSync(UI_PATH)) return sendJson(res, 500, { ok: false, error: 'UI missing' });
    return sendFile(res, UI_PATH);
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Memory Lane running at http://127.0.0.1:${PORT}`);
  console.log(`Library: ${libraryLabel()} (mode: ${currentMode()})`);
  if (EXTERNAL_LIBRARY) {
    console.log('(external library via MEMORY_LANE_LIBRARY; sample switching disabled)');
  } else {
    console.log('(blank first run. Click "Load sample" in the UI to explore the bundled demo.)');
  }
});
