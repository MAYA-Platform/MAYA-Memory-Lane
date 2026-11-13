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

test('status distinguishes passed, failed, and unavailable cached chain checks', async () => {
  const html = fs.readFileSync(new URL('../public/memory-lane.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', className: '',
      classList: { add() {}, remove() {} }, addEventListener() {} });
    return elements.get(id);
  };
  let chain = { intact: true, status: 'intact', total: 7, okCount: 7 };
  const fetch = async url => ({ ok: true, json: async () => url === '/api/status'
    ? { mode: 'sample', stats: { totalBlocks: 7, totalShelves: 1, lineageCount: 1 },
        library: 'synthetic', chain }
    : { blocks: [] } });
  const context = vm.createContext({ document: { getElementById: element }, window: {}, fetch, URL, Blob });
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('verdict').className, 'verdict good');
  assert.match(element('verdictText').textContent, /checks passed: 7\/7/);
  chain = { intact: false, status: 'issues', total: 7, okCount: 3 };
  await vm.runInContext('loadStatus()', context);
  assert.equal(element('verdict').className, 'verdict bad');
  assert.match(element('verdictText').textContent, /found issues: 3\/7/);
  chain = { intact: false, status: 'unchecked', total: 7, okCount: 3 };
  await vm.runInContext('loadStatus()', context);
  assert.equal(element('verdict').className, 'verdict neutral');
  assert.match(element('verdictText').textContent, /checks incomplete: 3\/7/);
  chain = { intact: null, status: 'unverified', total: 7, okCount: 3 };
  await vm.runInContext('loadStatus()', context);
  assert.equal(element('verdict').className, 'verdict neutral');
  assert.match(element('verdictText').textContent, /incomplete or unavailable: 3\/7/);
  const contradictions = [
    { intact: true, status: 'unchecked', total: 7, okCount: 7 },
    { intact: false, status: 'intact', total: 7, okCount: 7 },
    { intact: true, status: 'intact', total: 7, okCount: 3 },
    { intact: true, status: 'intact', total: 6, okCount: 6 },
    { intact: true, status: 'intact', total: '7', okCount: 7 },
    { intact: true, status: 'intact', total: 7, okCount: -1 },
    { intact: true, status: 'intact', total: 7, okCount: 1.5 },
    { intact: true, status: 'intact', total: 7 },
    { intact: true, status: 'intact', total: 7, okCount: 7, unchecked: 1 },
    { intact: true, status: 'intact', total: 7, okCount: 7, hardIssues: -1 },
  ];
  for (const inconsistent of contradictions) {
    chain = inconsistent;
    await vm.runInContext('loadStatus()', context);
    assert.equal(element('verdict').className, 'verdict neutral', JSON.stringify(inconsistent));
  }
  chain = { intact: true, status: 'intact', total: 7, okCount: 7, hardIssues: 1 };
  await vm.runInContext('loadStatus()', context);
  assert.equal(element('verdict').className, 'verdict bad');
  chain = { intact: true, status: 'issues', total: 7, okCount: 7 };
  await vm.runInContext('loadStatus()', context);
  assert.equal(element('verdict').className, 'verdict bad');
});
