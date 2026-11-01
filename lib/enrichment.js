/** Historical enrichment is a separate projection, never a sealed-block edit. */
import { readBlock } from './memoryLaneCore.js';
import { candidatePage } from './extraction-pages.js';
import { jevScoreQuestions } from './jevrank.js';
import { digest, namespaceOf, permitted, auditReceipt } from './access.js';

export async function enrichBlock(library, libId, {
  checkpoint = null, execute = false, maxBatches = 1, policy, principal, score = jevScoreQuestions
} = {}) {
  const block = readBlock(library, libId);
  const entry = library.blocks.find(e => e.lib_id === Number(libId));
  if (!block?.present || block.sha256 !== entry.sha256) throw Error('Source missing or hash mismatch');
  const ns = namespaceOf(block, policy || {});
  if (!permitted(policy, principal, ns)) throw Error('Access denied');
  const initial = candidatePage(block.raw);
  const scope = { source_block_id: block.block_id, source_hash: block.sha256, version: 1 };
  const plan = { ...scope, candidates: initial.total, batches: Math.ceil(initial.total / 30),
    estimated_cost_usd: Number((initial.total * 0.000015).toFixed(8)), cost_basis: 'historical_per_question_estimate', dry_run: true };
  if (!execute) return plan;
  if (!policy.namespaces[ns]?.externalJev) throw Error('External scoring denied');
  if (checkpoint && (checkpoint.source_hash !== block.sha256 || checkpoint.version !== 1)) throw Error('Checkpoint source mismatch');
  const state = checkpoint ? structuredClone(checkpoint) : { ...scope, cursor: 0, facts: [], receipts: [] };
  if (!Array.isArray(state.facts) || !Array.isArray(state.receipts) ||
      !(state.cursor === null || Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor <= initial.total) ||
      state.facts.some(f => f.source_hash !== block.sha256 || !Number.isInteger(f.start) || !Number.isInteger(f.end) ||
        f.start < 0 || f.end <= f.start || f.end > block.raw.length || block.raw.slice(f.start, f.end) !== f.text ||
        f.fact_id !== digest(`${block.sha256}:${f.start}:${f.end}`))) throw Error('Corrupt enrichment checkpoint');
  if (state.cursor === null) return state;
  for (let batch = 0; batch < Math.max(1, Math.min(10, maxBatches)); batch++) {
    const page = candidatePage(block.raw, { cursor: state.cursor });
    auditReceipt(library.rootDir, { type: 'outbound_enrichment', principal, namespace: ns, source_hash: block.sha256, candidates: page.candidates.length });
    const result = await score('', page.candidates.map(c => c.text));
    if (!result.ok || result.scores.size !== page.candidates.length) {
      state.receipts.push({ ok: false, cursor: state.cursor, reason: result.reason || 'partial_scores' });
      return { ...state, interrupted: true };
    }
    state.facts.push(...page.candidates.filter((_c, i) => result.scores.get(String(i)) >= 1)
      .map(c => ({ ...c, source_hash: block.sha256, source_block_id: block.block_id, fact_id: digest(`${block.sha256}:${c.start}:${c.end}`) })));
    state.receipts.push({ ok: true, cursor: state.cursor, scored: page.candidates.length });
    state.cursor = page.next_cursor;
    if (state.cursor === null) break;
  }
  return { ...state, dry_run: false, interrupted: false };
}
