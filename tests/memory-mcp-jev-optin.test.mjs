import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendBlock } from '../lib/memoryLaneCore.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-mcp-jev-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks:[]}));
  appendBlock(root, {title:'Synthetic first',body:'syntheticuniqueterm first',lineage:'first'});
  appendBlock(root, {title:'Synthetic second',body:'syntheticuniqueterm second',lineage:'second'});
  let count = 0, fail = false;
  const server = http.createServer((req,res) => {
    count++;
    req.resume();
    req.on('end', () => {
      if (fail) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({answers:{C0:{score:0},C1:{score:2}}}));
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, url:`http://127.0.0.1:${server.address().port}/decisions`, calls:() => count, fail:() => {fail=true;} };
}

function call(f, name, args, optIn) {
  return new Promise((resolve,reject) => {
    const env = {PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR,
      HOME:f.root, USERPROFILE:f.root, LOCALAPPDATA:f.root, MEMORY_LANE_LIBRARY:f.root,
      MEMORY_LANE_MERGE_CONFIG:path.join(f.root,'missing-config'), MERGE_API_KEY:'synthetic-key', MEMORY_LANE_DECISIONS_URL:f.url};
    if (optIn !== undefined) env.MEMORY_LANE_MCP_JEV_OPT_IN = optIn;
    const child = spawn(process.execPath,['tools/memory-lane-mcp.mjs'],{cwd:process.cwd(),env,stdio:['pipe','pipe','pipe']});
    let stdout='', stderr='';
    const timer=setTimeout(() => {child.kill(); reject(new Error('Synthetic MCP call timed out'));},10000);
    child.stdout.on('data',x => {stdout += x;}); child.stderr.on('data',x => {stderr += x;});
    child.on('error',reject);
    child.on('close',code => {clearTimeout(timer); if(code!==0) return reject(new Error(`MCP exited ${code}: ${stderr}`));
      try {resolve(JSON.parse(stdout.trim()).result);} catch(e) {reject(e);} });
    const request = name ? {method:'tools/call',params:{name,arguments:args}} : {method:'tools/list'};
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,...request})+'\n');
  });
}

test('MCP requires both operator opt-in and a per-call Jev request', async t => {
  const f = await fixture(t);
  const list = await call(f,null,{},undefined);
  for (const name of ['ml_search','ml_answer']) {
    const tool = list.tools.find(item => item.name === name);
    assert.deepEqual(tool.inputSchema.properties.rerank.enum, ['none','jev']);
  }
  for (const name of ['ml_search','ml_answer']) {
    const initial = f.calls();
    const queryArg = name === 'ml_search' ? {query:'syntheticuniqueterm'} : {question:'syntheticuniqueterm'};
    for (const [optIn,rerank] of [[undefined,undefined],['1',undefined],[undefined,'jev'],['true','jev'],['1','none']]) {
      const result=await call(f,name,{...queryArg,...(rerank===undefined?{}:{rerank})},optIn);
      assert.notEqual(result.isError,true);
      assert.equal(f.calls(),initial,`${name}: ${optIn} / ${rerank}`);
      if (rerank === 'jev') assert.match(result.content[0].text, /not enabled by the operator/);
    }
    for (const rerank of ['invalid', null, false, 1, {}]) {
      const invalid=await call(f,name,{...queryArg,rerank},'1');
      assert.equal(invalid.isError,true);
      assert.equal(f.calls(),initial);
    }
    const result=await call(f,name,{...queryArg,rerank:'jev'},'1');
    assert.notEqual(result.isError,true);
    assert.equal(f.calls(),initial+1);
  }
});

test('failed authorized Jev request preserves lexical search results', async t => {
  const f=await fixture(t);
  const plain=await call(f,'ml_search',{query:'syntheticuniqueterm'},undefined);
  f.fail();
  const fallback=await call(f,'ml_search',{query:'syntheticuniqueterm',rerank:'jev'},'1');
  assert.equal(f.calls(),1);
  assert.equal(fallback.content[0].text,plain.content[0].text);
});
