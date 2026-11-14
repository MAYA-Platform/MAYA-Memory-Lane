import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {score,precisionAt,runSubset,selectPilot} from './scoped_baseline.mjs';

test('official binary all-gold and multi-hit DCG differ from historical shortcuts',()=>{
 const r=score(['a','b'],['a','c','b'],['a','b','c'],2);assert.equal(r.recall_all,0);assert.equal(r.ndcg_any,0.5);
 assert.equal(score(['b'],['a','b'],['a','b'],2).ndcg_any,1);
 assert.deepEqual(precisionAt(['a'],['a','b'],5),{precision_actual:0.5,precision_returned:2});assert.deepEqual(precisionAt(['a'],[],5),{precision_actual:null,precision_returned:0});
 assert.throws(()=>score(['a'],['a','a'],['a'],5),/invalid session/);
});
test('per-question Continuity Block smoke excludes abstentions and preserves error status',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ml-baseline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const item={question_id:'synthetic',question_type:'fictional',question:'What color is the lantern?',haystack_session_ids:['answer_a','b'],haystack_sessions:[[{role:'user',content:'The lantern is amber.',has_answer:true}],[{role:'user',content:'A river flows.'}]],answer_session_ids:['answer_a']};
 const summary=runSubset([item,{...item,question_id:'synthetic_abs'}],path.join(root,'run'),{limit:2});
 assert.equal(summary.errors,0);assert.equal(summary.printer_scored,1);assert.equal(summary.runner_scored,1);
 const rows=fs.readFileSync(path.join(root,'run','results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assert.equal(rows[0].chain_intact,true);assert.equal(rows[1].excluded_abstention,true);
 assert.equal(typeof rows[0].candidate_count,'number');assert.equal(typeof summary.median_retrieval_ms,'number');assert.equal(typeof summary.p95_retrieval_ms,'number');
 assert.throws(()=>runSubset([item],path.join(root,'too-many'),{limit:6}));
 const err=runSubset([item,{question_id:'broken'}],path.join(root,'bad'),{limit:2});assert.equal(err.errors,1);assert.equal(err.printer_aggregate,null);
});
test('assistant-only answer is renamed noans and excluded by runner aggregate',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ml-official-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const item={question_id:'assistant-only',question:'What color?',haystack_session_ids:['answer_a','answer_b'],answer_session_ids:['answer_a','answer_b'],haystack_sessions:[[{role:'user',content:'Question one',has_answer:false},{role:'assistant',content:'Secret answer',has_answer:true}],[{role:'user',content:'Question two',has_answer:false}]]};
 const summary=runSubset([item],path.join(root,'run'),{limit:1});assert.equal(summary.printer_scored,1);assert.equal(summary.runner_scored,0);
 const row=JSON.parse(fs.readFileSync(path.join(root,'run','results.jsonl'),'utf8'));assert.deepEqual(row.corpus_sessions,['noans_a','noans_b']);assert.deepEqual(row.gold_sessions,[]);assert.equal(row.no_user_target,true);
 const withTarget=structuredClone(item);withTarget.haystack_sessions[1][0].has_answer=true;
 const next=runSubset([withTarget],path.join(root,'run2'),{limit:1});assert.equal(next.runner_scored,1);
 const row2=JSON.parse(fs.readFileSync(path.join(root,'run2','results.jsonl'),'utf8'));assert.deepEqual(row2.gold_sessions,['answer_b']);
});
test('pilot selection is deterministic, balanced by category and independent of scores',()=>{
 const data=[];for(let i=0;i<5;i++)for(const type of ['c','a','b','d','e','f'])data.push({question_id:`${type}-${i}`,question_type:type,ignored_score:99-i});
 data.unshift({question_id:'ignored_abs',question_type:'a'});const selected=selectPilot(data);assert.equal(selected.length,20);assert.deepEqual(selected.map(x=>x.question_id),selectPilot(data).map(x=>x.question_id));
 assert.deepEqual(selected.slice(0,6).map(x=>x.question_type),['a','b','c','d','e','f']);assert.ok(selected.every(x=>!x.question_id.includes('_abs')));
 assert.throws(()=>selectPilot([{question_id:'one',question_type:'a'}]),/insufficient/);
});
