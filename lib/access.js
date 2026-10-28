/** Policy is operator-owned configuration, never accepted from a query body. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBlock } from './memoryLaneCore.js';

export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const policyRequired = new Set();

export function loadAccessPolicy(root) {
  const file = path.join(root, 'access-policy.json');
  if (!fs.existsSync(file)) {
    if (policyRequired.has(path.resolve(root))) throw Error('Access policy missing');
    return null;
  }
  policyRequired.add(path.resolve(root));
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (policy.version !== 1 || !policy.principals || !policy.namespaces) throw Error('Invalid access policy');
  return policy;
}

export function authenticate(policy, token) {
  if (!token || !policy?.principals) return null;
  const hash = digest(token);
  for (const [id, principal] of Object.entries(policy.principals)) {
    if (principal.disabled || !/^[a-f0-9]{64}$/.test(principal.token_sha256 || '')) continue;
    if (crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(principal.token_sha256))) return id;
  }
  return null;
}

export function permitted(policy, principal, namespace, action = 'read') {
  const p = policy?.principals?.[principal];
  return Boolean(p && !p.disabled && policy.namespaces?.[namespace] &&
    Array.isArray(p[action]) && p[action].includes(namespace));
}

export function namespaceOf(block, policy) {
  return block.fields?.namespace || policy.legacyNamespace || 'founder';
}

/** Filter before indexing, graph traversal, ranking, and cache lookup. */
export function scopeLibrary(library, policy, principal) {
  const blocks = library.blocks.filter(entry => {
    const block = readBlock(library, entry.lib_id);
    return block?.present && block.sha256 === entry.sha256 && !block.fields.anchor_type &&
      permitted(policy, principal, namespaceOf(block, policy));
  });
  return { ...library, blocks, totalBlocks: blocks.length,
    manifest: { ...library.manifest, blocks, total_blocks: blocks.length },
    access: { policy, principal } };
}

export function authorizeLocalLibrary(library, token = process.env.MEMORY_LANE_ACCESS_TOKEN) {
  const policy = loadAccessPolicy(library.rootDir);
  if (!policy) return library;
  const principal = authenticate(policy, token);
  if (!principal) throw Error('Authentication required');
  return scopeLibrary(library, policy, principal);
}

export function checkCurrentAccess(library) {
  if (library.access && JSON.stringify(loadAccessPolicy(library.rootDir)) !== JSON.stringify(library.access.policy)) {
    throw Error('Access policy changed; retry');
  }
}

export function allowExternal(library) {
  if (!library.access) return true; // legacy single-owner API retains its contract
  const { policy } = library.access;
  return library.blocks.every(entry => {
    const block = readBlock(library, entry.lib_id);
    return block?.present && policy.namespaces[namespaceOf(block, policy)]?.externalJev === true;
  });
}

/** Minimization is a best-effort additional control; namespace opt-in is primary. */
export function redactOutbound(value) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:Bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/gi, '[credential]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[identifier]');
}

export function auditReceipt(root, event) {
  const dir = path.join(root, 'health');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'v3-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}
