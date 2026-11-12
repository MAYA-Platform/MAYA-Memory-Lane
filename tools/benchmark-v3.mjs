#!/usr/bin/env node
/** Synthetic offline comparison. No real provider, credentials, or private corpus. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const moduleRoot = args.includes('--module-root') ? path.resolve(value('--module-root')) : path.resolve(import.meta.dirname, '..');
process.env.MERGE_API_KEY = 'offline-benchmark';
process.env.MEMORY_LANE_MERGE_CONFIG = path.join(os.tmpdir(), 'no-benchmark-provider.yaml');
let calls = 0;
// Five milliseconds is a FIXTURE transport delay, never a provider-latency claim.
globalThis.fetch = async (_url, opts) => {
  calls++;
  await new Promise(resolve => setTimeout(resolve, 5));
  const payload = JSON.parse(opts.body);
  const answers = Object.fromEntries(Object.keys(payload.questions).map(tag => [tag, { score: 2 }]));
  return { ok: true, json: async () => ({ answers, usage: { cost: 0 } }) };
};
const core = await import(pathToFileURL(path.join(moduleRoot, 'lib/memoryLaneCore.js')));
const { answerQuestion } = await import(pathToFileURL(path.join(moduleRoot, 'lib/answer.js')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-v3-benchmark-'));
try {
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  const records = [
    { title: 'Vehicle', body: 'Alex leased a Honda Civic in black.' },
    { title: 'Other vehicle', body: 'Alex enjoys Honda motorcycles.' },
    { title: 'Migration', body: 'Orchid Jev-only migration shipped. Production service verified.' },
    { title: 'Large transcript', body: 'Unrelated opening sentence. '.repeat(180) + '\nRelease ticket ZX-582 was approved by the release owner.' },
    { title: 'Parser closeout', body: 'Hermes finished the Orchid parser.' },
    { title: 'Index closeout', body: 'Forge finished the Orchid index.' }
  ];
  for (const r of records) core.appendBlock(root, { ...r, lineage: 'synthetic', timestamp: '2026-10-10T00:00:00Z' });
  const lib = core.loadLibrary(root);
  const workloads = [
    { name: 'exact', query: 'Honda Civic', expected: 'cb_synthetic_001', support: /leased a Honda Civic/ },
    { name: 'paraphrase', query: 'Did we finish the Orchid upgrade?', expected: 'cb_synthetic_003', support: /migration shipped/ },
    { name: 'late_span', query: 'ZX-582', expected: 'cb_synthetic_004', support: /approved by the release owner/ },
    { name: 'no_evidence', query: 'zzzxxyy unavailable evidence', expected: null },
    { name: 'multi_session', query: 'What did Hermes and Forge finish for Orchid?', expected: ['cb_synthetic_005', 'cb_synthetic_006'], support: /parser[\s\S]*index|index[\s\S]*parser/ }
  ];
  const output = { schema_version: 1, corpus: 'synthetic-v1', iterations: 100,
    transport: 'offline score=2 stub; fixed 5ms simulated transport delay; not Jev accuracy',
    observed_cost_usd: 0, actual_provider_calls: 0, workloads: [] };
  for (const item of workloads) {
    const lexical = core.search(lib, item.query, { limit: 10 });
    const expected = Array.isArray(item.expected) ? item.expected : item.expected ? [item.expected] : [];
    const recall = n => expected.length ? expected.filter(id => lexical.matches.slice(0, n).some(m => m.block_id === id)).length / expected.length : null;
    const samples = [], beforeCalls = calls;
    let supported = 0, answered = 0, abstained = 0;
    // One unmeasured warm-up, then identical warm-library workloads for both builds.
    await answerQuestion(lib, item.query);
    for (let i = 0; i < output.iterations; i++) {
      const t0 = performance.now();
      const answer = await answerQuestion(lib, item.query);
      samples.push(performance.now() - t0);
      if (answer.mode === 'none') abstained++;
      else { answered++; if (expected.every(id => answer.evidence.some(e => e.block_id === id)) && item.support.test(answer.answer)) supported++; }
    }
    samples.sort((a, b) => a - b);
    const percentile = p => Number(samples[Math.ceil(p * samples.length) - 1].toFixed(3));
    output.workloads.push({ name: item.name, recall_at_5: recall(5),
      recall_at_10: recall(10),
      evidence_precision: answered ? supported / answered : null, answered, supported, abstained,
      false_positive_rate: item.expected ? null : answered / output.iterations,
      latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      simulated_decision_calls_including_warmup: calls - beforeCalls });
  }
  const { candidateFacts } = await import(pathToFileURL(path.join(moduleRoot, 'lib/extract.js')));
  const transcript = Array.from({ length: 8 }, (_, s) => `## Part ${s + 1}\n` +
    Array.from({ length: 10 }, (_x, i) => `Section ${s + 1} item ${i} was completed successfully.`).join('\n')).join('\n');
  const facts = candidateFacts(transcript);
  output.ingestion = { total_source_sections: 8, sampled_candidates: facts.length,
    sampled_sections: new Set([...facts.join('\n').matchAll(/Section (\d+) item/g)].map(m => m[1])).size };
  const temporalModule = path.join(moduleRoot, 'lib/temporal.js');
  if (fs.existsSync(temporalModule)) {
    const { buildTemporalProjection, temporalState } = await import(pathToFileURL(temporalModule));
    const temporalRoot = path.join(root, 'temporal'); fs.mkdirSync(temporalRoot);
    fs.writeFileSync(path.join(temporalRoot, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
    const events = [
      { state: 'proposed', value: 'planned', at: '2026-10-10T00:00:00Z' },
      { state: 'verified', value: 'done', at: '2026-10-13T00:00:00Z' },
      { state: 'proposed', value: 'future enhancement', at: '2026-10-14T00:00:00Z' }
    ];
    for (const e of events) core.appendBlock(temporalRoot, { title: e.value, timestamp: e.at,
      body: '@temporal ' + JSON.stringify({ entity_id: 'synthetic-upgrade', predicate: 'status', state: e.state, value: e.value }) });
    const tl = core.loadLibrary(temporalRoot);
    const projection = buildTemporalProjection(tl, { authorities: { [tl.blocks[1].sha256]: { authority_level: 3, verified_by: 'fixture-owner' } } });
    const labels = [['2026-10-11T00:00:00Z', 'planned'], ['2026-10-13T12:00:00Z', 'done'], ['2026-10-15T00:00:00Z', 'done']];
    const correct = labels.filter(([asOf, expected]) => temporalState(projection, { entity: 'synthetic-upgrade', asOf }).current?.value === expected).length;
    output.temporal = { supported: true, fixture_cases: labels.length, correct, accuracy: correct / labels.length };
  } else output.temporal = { supported: false, accuracy: null };
  output.chain = { intact: core.verifyChain(lib).intact, blocks: lib.blocks.length };
  const rendered = JSON.stringify(output, null, 2) + '\n';
  if (args.includes('--output')) fs.writeFileSync(value('--output'), rendered);
  process.stdout.write(rendered);
} finally {
  // The target is the mkdtemp directory created above, never a live library.
  fs.rmSync(root, { recursive: true, force: true });
}
