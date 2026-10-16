import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendBlock, loadLibrary } from '../lib/memoryLaneCore.js';
import { digest } from '../lib/access.js';

export function makeLibrary(t, records = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-v3-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const [i, record] of records.entries()) appendBlock(root, {
    title: `Synthetic record ${i}`, timestamp: '2026-10-10T00:00:00Z', namespace: 'founder', ...record
  });
  return loadLibrary(root);
}

export function policy() {
  return { version: 1, legacyNamespace: 'founder',
    namespaces: { founder: { externalJev: false }, 'client-a': { externalJev: false }, 'client-b': { externalJev: false } },
    principals: { owner: { token_sha256: digest('test-owner'), read: ['founder', 'client-a', 'client-b'], write: ['founder'] },
      alice: { token_sha256: digest('test-alice'), read: ['client-a'], write: ['client-a'] },
      bob: { token_sha256: digest('test-bob'), read: ['client-b'], write: [] } }, authorities: {} };
}

export function event(entity, state, value, extra = {}) {
  return '@temporal ' + JSON.stringify({ entity_id: entity, predicate: 'status', state, value, ...extra });
}
