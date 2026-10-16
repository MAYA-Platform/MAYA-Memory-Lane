#!/usr/bin/env node
/** Explicit, authenticated projection/backfill maintenance. Dry-run by default. */
import fs from 'node:fs';
import path from 'node:path';
import { loadLibrary, validateLibraryPathOrExit } from '../lib/memoryLaneCore.js';
import { loadAccessPolicy, authenticate, scopeLibrary, auditReceipt } from '../lib/access.js';
import { buildTemporalProjection } from '../lib/temporal.js';
import { enrichBlock } from '../lib/enrichment.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => flag(name) ? args[args.indexOf(name) + 1] : null;
if (!value('--library') || !value('--token-file')) {
  console.error('Usage: node tools/v3-project.mjs --library <path> --token-file <path> [--backfill <lib-id>] [--execute --approved-cost-usd <budget>]');
  process.exit(2);
}
const root = path.resolve(value('--library'));
validateLibraryPathOrExit(root);
const policy = loadAccessPolicy(root);
const principal = authenticate(policy, fs.readFileSync(path.resolve(value('--token-file')), 'utf8').trim());
if (!principal) throw Error('Authentication required');
const raw = loadLibrary(root);
if (!raw.ok) throw Error('Library unavailable');
const library = scopeLibrary(raw, policy, principal);
const dir = path.join(root, 'projections', 'v3');
function writeProjection(name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.writeFileSync(dest + '.tmp', JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(dest + '.tmp', dest);
}
if (value('--backfill')) {
  const id = Number(value('--backfill'));
  const plan = await enrichBlock(library, id, { policy, principal });
  if (!flag('--execute')) console.log(JSON.stringify(plan, null, 2));
  else {
    const budget = Number(value('--approved-cost-usd'));
    if (!value('--approved-cost-usd') || !Number.isFinite(budget) || budget < plan.estimated_cost_usd) throw Error('Explicit approved budget must cover the dry-run estimate');
    const name = `enrichment-${plan.source_hash}.json`;
    const file = path.join(dir, name);
    let checkpoint = null;
    if (fs.existsSync(file)) checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
    auditReceipt(root, { type: 'backfill_approved_execution', principal, source_hash: plan.source_hash, estimated_cost_usd: plan.estimated_cost_usd, approved_budget_usd: budget });
    const result = await enrichBlock(library, id, { checkpoint, execute: true, maxBatches: 1, policy, principal });
    writeProjection(name, result);
    console.log(JSON.stringify({ source_hash: plan.source_hash, cursor: result.cursor, interrupted: result.interrupted, facts: result.facts.length }));
  }
} else {
  const projection = buildTemporalProjection(library, { authorities: policy.authorities || {} });
  if (flag('--execute')) {
    auditReceipt(root, { type: 'projection_rebuild', principal, source_version: projection.source_version });
    // Principal isolation applies to on-disk projections as well as the cache.
    const { digest } = await import('../lib/access.js');
    writeProjection(`temporal-${digest(principal).slice(0, 16)}.json`, projection);
  }
  console.log(JSON.stringify({ dry_run: !flag('--execute'), version: projection.version,
    events: projection.events.length, rejected: projection.rejected.length, source_version: projection.source_version }));
}
