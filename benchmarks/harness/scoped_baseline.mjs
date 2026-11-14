// Scoped LongMemEval oracle baseline. One genuine Continuity Block library per question.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {appendBlock,loadLibrary,search,verifyChain} from '../../lib/memoryLaneCore.js';

const DATASET_SHA='821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c';
export const OFFICIAL_REVISION='9e0b455f4ef0e2ab8f2e582289761153549043fc';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Transcribes official eval_utils.py: binary all-gold recall and its DCG
// discount (first two positions have gain 1). Assumes unique corpus IDs.
export function score(gold,retrieved,corpus,k){
 if(new Set(corpus).size!==corpus.length||new Set(retrieved).size!==retrieved.length||retrieved.some(id=>!corpus.includes(id)))throw Error('invalid session ranking');
 const relevant=new Set(gold),top=retrieved.slice(0,k),all=gold.every(id=>top.includes(id));
 const gain=i=>i===0?1:1/Math.log2(i+1);
 const ideal=corpus.filter(id=>relevant.has(id)).length;
 let idcg=0,dcg=0;for(let i=0;i<Math.min(k,ideal);i++)idcg+=gain(i);
 top.forEach((id,i)=>{if(relevant.has(id))dcg+=gain(i);});
 return {recall_all:Number(all),ndcg_any:idcg?dcg/idcg:0};
}
export function precisionAt(gold,retrieved,k){const top=retrieved.slice(0,k);return {precision_actual:top.length?top.filter(id=>gold.includes(id)).length/top.length:null,precision_returned:top.length};}

export function runOne(instance,root){
 const start=performance.now();
 if(!instance||typeof instance.question_id!=='string'||typeof instance.question!=='string'||!Array.isArray(instance.haystack_session_ids)||!Array.isArray(instance.haystack_sessions)||instance.haystack_session_ids.length!==instance.haystack_sessions.length||!Array.isArray(instance.answer_session_ids))throw Error('invalid instance');
 const original=instance.haystack_session_ids;if(new Set(original).size!==original.length||instance.answer_session_ids.some(id=>!original.includes(id)))throw Error('invalid corpus');
 const users=instance.haystack_sessions.map(turns=>{if(!Array.isArray(turns)||turns.some(t=>typeof t?.role!=='string'||typeof t?.content!=='string'))throw Error('invalid session');return turns.filter(t=>t.role==='user');});
 const corpus=original.map((id,i)=>{if(typeof id!=='string')throw Error('invalid session ID');if(!id.includes('answer'))return id;if(users[i].some(t=>typeof t.has_answer!=='boolean'))throw Error('missing answer annotation');return users[i].every(t=>!t.has_answer)?id.replaceAll('answer','noans'):id;});
 if(new Set(corpus).size!==corpus.length)throw Error('transformed session collision');
 const gold=corpus.filter(id=>id.includes('answer'));
 const noUserTarget=!users.some(turns=>turns.some(t=>t.has_answer===true));
 fs.mkdirSync(root,{recursive:false});fs.writeFileSync(path.join(root,'MANIFEST.json'),JSON.stringify({blocks:[]}));
 const byLib=new Map();
 for(let i=0;i<corpus.length;i++){
  const added=appendBlock(root,{title:`Session ${i+1}`,body:users[i].map(t=>t.content).join(' '),lineage:'longmemeval',timestamp:'2026-01-01T00:00:00.000Z'});
  if(!added.ok||added.skipped||byLib.has(added.lib_id))throw Error('block ingestion failed');byLib.set(added.lib_id,corpus[i]);
 }
 const ingestMs=performance.now()-start,lib=loadLibrary(root);if(!lib.ok)throw Error('library load failed');
 const chain=verifyChain(lib);if(!chain.intact)throw Error('chain verification failed');
 const retrievalStart=performance.now(),found=search(lib,instance.question,{limit:10});
 const retrieved=found.matches.map(m=>byLib.get(m.lib_id));if(retrieved.some(id=>id===undefined))throw Error('unmapped result');
 const retrievalMs=performance.now()-retrievalStart;
 const scores={};for(const k of [5,10])scores[k]={...score(gold,retrieved,corpus,k),...precisionAt(gold,retrieved,k)};
 return {question_id:instance.question_id,question_type:instance.question_type,excluded_abstention:instance.question_id.includes('_abs'),no_user_target:noUserTarget,original_answer_session_ids:instance.answer_session_ids,gold_sessions:gold,retrieved_sessions:retrieved,corpus_sessions:corpus,corpus_count:corpus.length,candidate_count:retrieved.length,chain_intact:chain.intact,ingest_ms:ingestMs,retrieval_ms:retrievalMs,scores};
}

function runSelected(selected,outputRoot,{datasetSha=null,datasetLabel='synthetic',scope='bounded smoke, not benchmark',selection='first-in-file'}={}){
 fs.mkdirSync(outputRoot,{recursive:false});const rows=[];
 for(let i=0;i<selected.length;i++)try{rows.push(runOne(selected[i],path.join(outputRoot,`question-${i+1}`)));}catch(error){rows.push({question_id:selected[i]?.question_id||null,error:String(error.message)});}
 const valid=rows.filter(r=>!r.error&&!r.excluded_abstention),runnerValid=valid.filter(r=>!r.no_user_target),errors=rows.filter(r=>r.error).length;
 const aggregate=group=>errors||!group.length?null:Object.fromEntries([5,10].map(k=>{const p=group.map(r=>r.scores[k].precision_actual).filter(n=>n!==null);return [k,{recall_all:group.reduce((a,r)=>a+r.scores[k].recall_all,0)/group.length,ndcg_any:group.reduce((a,r)=>a+r.scores[k].ndcg_any,0)/group.length,precision_actual:p.length?p.reduce((a,n)=>a+n,0)/p.length:null,precision_questions:p.length}];}));
 const elapsed=valid.map(r=>r.retrieval_ms).sort((a,b)=>a-b),median=elapsed.length?(elapsed[Math.floor((elapsed.length-1)/2)]+elapsed[Math.floor(elapsed.length/2)])/2:null;
 const summary={scope,selection,dataset:datasetLabel,dataset_sha256:datasetSha,scorer_revision:OFFICIAL_REVISION,core_sha256:sha(fs.readFileSync(fileURLToPath(new URL('../../lib/memoryLaneCore.js',import.meta.url)))),instances:rows.length,printer_scored:valid.length,runner_scored:runnerValid.length,errors,median_retrieval_ms:errors?null:median,p95_retrieval_ms:errors||!elapsed.length?null:elapsed[Math.ceil(.95*elapsed.length)-1],printer_aggregate:aggregate(valid),runner_aggregate:aggregate(runnerValid)};
 fs.writeFileSync(path.join(outputRoot,'results.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});fs.writeFileSync(path.join(outputRoot,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;
}
export function runSubset(dataset,outputRoot,{limit=2,datasetSha=null,datasetLabel='synthetic'}={}){
 if(!Array.isArray(dataset)||!Number.isSafeInteger(limit)||limit<1||limit>5||dataset.length<limit)throw Error('smoke limit must be 1..5');
 return runSelected(dataset.slice(0,limit),outputRoot,{datasetSha,datasetLabel});
}
// Fixed, deterministic type round-robin in dataset order; no score-based selection.
export function selectPilot(dataset){
 if(!Array.isArray(dataset))throw Error('invalid dataset');
 const groups=new Map();for(const r of dataset){if(typeof r?.question_type!=='string'||typeof r?.question_id!=='string')throw Error('invalid dataset entry');if(r.question_id.includes('_abs'))continue;if(!groups.has(r.question_type))groups.set(r.question_type,[]);groups.get(r.question_type).push(r);}
 const keys=[...groups.keys()].sort(),selected=[];for(let round=0;selected.length<20;round++){let added=0;for(const key of keys){const item=groups.get(key)[round];if(item&&selected.length<20){selected.push(item);added++;}}if(!added)throw Error('insufficient pilot cases');}
 if(new Set(selected.map(r=>r.question_id)).size!==20)throw Error('duplicate pilot ID');return selected;
}
export function runPilot(dataset,outputRoot,{datasetSha=null,datasetLabel='synthetic'}={}){
 return runSelected(selectPilot(dataset),outputRoot,{datasetSha,datasetLabel,scope:'20-case stratified pilot, not benchmark',selection:'non-abstention, alphabetical question type round-robin, original dataset order'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{if(process.argv.length!==4)throw Error('expected dataset file and output parent');const [dataset,root]=process.argv.slice(2),bytes=fs.readFileSync(dataset);if(sha(bytes)!==DATASET_SHA)throw Error('dataset hash mismatch');fs.mkdirSync(root,{recursive:true});const dir=path.join(root,`smoke-${randomUUID()}`);const summary=runSubset(JSON.parse(bytes),dir,{datasetSha:DATASET_SHA,datasetLabel:'cleaned-oracle'});console.log(JSON.stringify({output:dir,...summary}));if(summary.errors)process.exitCode=1;}catch(error){console.error(error.message);process.exitCode=1;}
}
