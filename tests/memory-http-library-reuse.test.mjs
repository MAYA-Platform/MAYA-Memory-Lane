import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {appendBlock,loadLibrary} from '../lib/memoryLaneCore.js';

test('HTTP searches reuse unchanged indexes but refresh exact file and manifest changes', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ml-http-reuse-'));
  fs.writeFileSync(path.join(root,'MANIFEST.json'),JSON.stringify({blocks:[]}));
  appendBlock(root,{title:'Fixture',body:'appleword synthetic memory',lineage:'fixture'});
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,
    HOME:root,USERPROFILE:root,TEMP:root,TMP:root,PORT:String(port),MEMORY_LANE_LIBRARY:root,
    MEMORY_LANE_MERGE_CONFIG:path.join(root,'missing-config'),OLLAMA_HOST:'http://127.0.0.1:1',INDEX_COUNT_FILE:path.join(root,'index-count')};
  const child=spawn(process.execPath,['--import',pathToFileURL(path.resolve('tests/fixtures/count-search-index.mjs')).href,path.resolve('server.mjs')],{env,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);
  const opens=()=>fs.existsSync(env.INDEX_COUNT_FILE)?fs.readFileSync(env.INDEX_COUNT_FILE,'utf8').trim().split('\n').length:0;
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`,deadline=Date.now()+8000;
  while(true){try{if((await fetch(`${base}/api/status`)).ok)break;}catch{} if(Date.now()>deadline||child.exitCode!==null)throw Error(`fixture server unavailable: ${stderr}`);await new Promise(r=>setTimeout(r,30));}
  const find=async q=>{const response=await fetch(`${base}/api/search?q=${q}`);assert.equal(response.status,200);return response.json();};
  assert.equal((await find('appleword')).count,1);
  const first=opens();assert.ok(first>=1,'synthetic search should build an index');
  assert.equal((await find('appleword')).count,1);assert.equal(opens(),first,'unchanged source should reuse indexes');
  const file=loadLibrary(root).blocks[0].filePath,stat=fs.statSync(file);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('appleword','pearwords'));fs.utimesSync(file,stat.atime,stat.mtime);
  assert.equal((await find('appleword')).count,0);assert.equal((await find('pearwords')).count,1);
  assert.ok(opens()>first,'changed bytes must rebuild the index even with restored timestamps');
  appendBlock(root,{title:'Second',body:'pearwords newly added',lineage:'second'});
  assert.equal((await find('pearwords')).count,2,'manifest changes must be loaded');
  fs.writeFileSync(path.join(root,'MANIFEST.json'),'{invalid');
  assert.equal((await fetch(`${base}/api/search?q=pearwords`)).status,500,'invalid manifest must not use an old cache');
});
