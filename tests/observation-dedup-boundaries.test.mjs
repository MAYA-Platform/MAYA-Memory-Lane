import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeMessage, readObservations } from '../lib/observations.js';

function library(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-boundary-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, ok: true, blocks: [] };
}

test('separate speaker labels do not suppress each other', t => {
  const lib = library(t);
  const content = 'I prefer concise updates';
  observeMessage(lib, { speaker: 'user', session_id: 'one', content });
  observeMessage(lib, { speaker: 'assistant', session_id: 'one', content });
  assert.deepEqual(readObservations(lib).map(o => o.speaker), ['user', 'assistant']);
});

test('shared maximum-length prefix does not suppress a later observation', t => {
  const lib = library(t);
  const prefix = 'I prefer ' + 'x'.repeat(240);
  observeMessage(lib, { speaker: 'user', content: prefix + ' first suffix' });
  observeMessage(lib, { speaker: 'user', content: prefix + ' corrected suffix' });
  const records = readObservations(lib);
  assert.equal(records.length, 2);
  assert.ok(records.every(o => o.excerpt.length === 240));
});

test('same short speaker content remains deduplicated across sessions', t => {
  const lib = library(t);
  observeMessage(lib, { speaker: 'user', session_id: 'one', content: 'I prefer concise updates' });
  observeMessage(lib, { speaker: 'user', session_id: 'two', content: 'I prefer concise updates' });
  assert.equal(readObservations(lib).length, 1);
});
