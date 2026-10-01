#!/usr/bin/env node
/**
 * Hermetic test environment preload.
 *
 * The test suite must never touch live model servers. On 2026-10-01 a plain
 * `npm test` run on a machine with Ollama up loaded qwen2.5:3b + bge-m3
 * (~2.9 GB combined) through the suite's live-network paths — lib/extract.js
 * ingest auto-extraction (tests/memory-lane-ingest.test.mjs) and the default
 * local embedding provider in lib/embeddings.js (tests/embeddings-provider.test.mjs).
 * The load pushed free RAM under the ops floor and fired a ram_free_gb
 * CRITICAL alarm (kanban t_35f235d3).
 *
 * This preload pins every network-capable provider to a dead loopback port
 * before any test (or child process it spawns) reads env. Connection-refused
 * fails fast and the suite's graceful-degradation contracts still hold
 * (null embeddings, degraded extraction): 123/123 pass, zero model loads.
 *
 * Wired in via package.json: node --import ./tools/hermetic-env.mjs --test ...
 */

process.env.OLLAMA_URL = 'http://127.0.0.1:1';

// Hosted providers must not be reachable from a test run either.
delete process.env.MEMORY_LANE_API_KEY;
delete process.env.MEMORY_LANE_BASE_URL;
delete process.env.MEMORY_LANE_MODEL;
delete process.env.VERTEX_ACCESS_TOKEN;