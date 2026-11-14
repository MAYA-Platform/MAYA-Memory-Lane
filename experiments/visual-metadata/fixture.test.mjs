import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualMetadataFixture } from './fixture.mjs';

const item = (id, application = 'synthetic-editor') => ({id, application, label:'invented blue diagram', selected:true, source:'synthetic'});

test('explicit opt-in and selection are required; scope isolates operations', () => {
  const f = createVisualMetadataFixture('owner-a');
  assert.equal(f.add('owner-a', item('one')), false);
  assert.equal(f.setOptIn('owner-b', true), false);
  assert.equal(f.setOptIn('owner-a', true), true);
  assert.equal(f.add('owner-a', {...item('one'), selected:false}), false);
  assert.equal(f.add('owner-a', {...item('one'), source:'other'}), false);
  assert.equal(f.add('owner-b', item('one')), false);
  assert.equal(f.add('owner-a', item('one')), true);
  assert.deepEqual(f.search('owner-b','diagram'), []);
  assert.deepEqual(f.search('owner-a','diagram'), [{id:'one', application:'synthetic-editor', label:'invented blue diagram'}]);
  assert.equal(f.setOptIn('owner-a', false), true);
  assert.deepEqual(f.search('owner-a','diagram'), []);
  assert.equal(f.add('owner-a', item('two')), false);
});

test('remove and application exclusion stop lookup and prevent reinsertion in this instance', () => {
  const f = createVisualMetadataFixture('owner-a');
  f.setOptIn('owner-a', true);
  f.add('owner-a', item('one')); f.add('owner-a', item('two','synthetic-browser'));
  assert.equal(f.remove('owner-b','one'), false);
  assert.equal(f.remove('owner-a','one'), true);
  assert.equal(f.add('owner-a',item('one')), false);
  assert.equal(f.exclude('owner-a','synthetic-browser'), true);
  assert.deepEqual(f.search('owner-a','diagram'), []);
  assert.equal(f.add('owner-a',item('two','different')), false);
  assert.equal(f.add('owner-a',item('three','synthetic-browser')), false);
});

test('stored metadata is copied, bounded and does not return arbitrary input fields', () => {
  const f = createVisualMetadataFixture('owner-a'); f.setOptIn('owner-a', true);
  const original = {...item('one'), unrelated:'not stored'};
  assert.equal(f.add('owner-a', original), true);
  original.label = 'changed';
  const found = f.search('owner-a','diagram');
  assert.equal(found[0].label, 'invented blue diagram');
  assert.equal(Object.hasOwn(found[0], 'unrelated'), false);
  found[0].label = 'changed';
  assert.equal(f.search('owner-a','diagram')[0].label, 'invented blue diagram');
  assert.equal(f.add('owner-a', {...item('large'), label:'x'.repeat(201)}), false);
});
