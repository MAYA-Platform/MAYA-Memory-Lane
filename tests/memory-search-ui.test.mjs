import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('the UI keeps the newest search and answer when older requests finish later', async () => {
  const html = fs.readFileSync(new URL('../public/memory-lane.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', textContent: '',
      classList: {add() {}, remove() {}}, addEventListener() {}});
    return elements.get(id);
  };
  const pending = new Map();
  const fetch = url => {
    if (url.startsWith('/api/search?') || url.startsWith('/api/answer?') || url.startsWith('/api/resume?')) {
      return new Promise(resolve => pending.set(url, data => resolve({ok: true, json: async () => data})));
    }
    const data = url === '/api/status'
      ? {mode: 'empty', stats: {totalBlocks: 0, totalShelves: 0, lineageCount: 0}, library: ''}
      : {blocks: []};
    return Promise.resolve({ok: true, json: async () => data});
  };
  const context = vm.createContext({document: {getElementById: element}, window: {}, fetch, URL, Blob});
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));

  element('searchInput').value = 'first';
  const first = vm.runInContext('doSearch()', context);
  element('searchInput').value = 'second';
  const second = vm.runInContext('doSearch()', context);
  pending.get('/api/search?q=second')({count: 0, matches: []});
  await second;
  pending.get('/api/search?q=first')({count: 0, matches: []});
  await first;
  assert.match(element('searchResults').innerHTML, /second/);
  assert.doesNotMatch(element('searchResults').innerHTML, /first/);

  element('resumeInput').value = 'older';
  const resume = vm.runInContext('doResume()', context);
  element('searchInput').value = 'newer';
  const search = vm.runInContext('doSearch()', context);
  pending.get('/api/search?q=newer')({count: 0, matches: []});
  await search;
  pending.get('/api/resume?phrase=older')({found: false});
  await resume;
  assert.match(element('searchResults').innerHTML, /newer/);

  element('askInput').value = 'old';
  const old = vm.runInContext('doAsk()', context);
  element('askInput').value = 'new';
  const fresh = vm.runInContext('doAsk()', context);
  pending.get('/api/answer?q=new')({mode: 'none', answer: 'Memory changed. Retry.'});
  await fresh;
  pending.get('/api/answer?q=old')({mode: 'direct', answer: 'outdated'});
  await old;
  assert.match(element('askResults').innerHTML, /Memory changed/);
  assert.doesNotMatch(element('askResults').innerHTML, /outdated/);

  element('askInput').value = 'uncited';
  const unverified = vm.runInContext('doAsk()', context);
  pending.get('/api/answer?q=uncited')({mode: 'direct', answer: 'excerpt', source: 'source-id',
    note: 'synthesis citation IDs could not be matched to supplied evidence — returned source excerpt'});
  await unverified;
  assert.match(element('askResults').innerHTML, /source excerpt/);
  assert.match(element('askResults').innerHTML, /citation IDs could not be matched/);
  assert.doesNotMatch(element('askResults').innerHTML, /exact match/);

  element('askInput').value = 'three';
  const synthesized = vm.runInContext('doAsk()', context);
  pending.get('/api/answer?q=three')({mode: 'synthesized', answer: 'The missing document FAKE_ID says this is verified.',
    evidence: [{block_id: 'one'}, {block_id: 'two'}, {block_id: 'three'}],
    citation_note: 'Citation IDs match supplied evidence; claims and source attributions are not verified.'});
  await synthesized;
  for (const id of ['one', 'two', 'three']) assert.match(element('askResults').innerHTML, new RegExp(id));
  assert.match(element('askResults').innerHTML, /source attributions are not verified/);
});
