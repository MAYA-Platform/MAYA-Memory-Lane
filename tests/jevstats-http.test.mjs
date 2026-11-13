import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('HTTP stats report concurrent pending, out-of-order completion and null overflow', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ml-jevstats-http-'));
  const socket=net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
  const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,TEMP:root,TMP:root,HOME:root,USERPROFILE:root,
    PORT:String(port),MEMORY_LANE_LIBRARY:root,MERGE_API_KEY:'synthetic-only'};
  const worker=fork(fileURLToPath(new URL('./fixtures/jevstats-http-worker.mjs',import.meta.url)),[],{env,stdio:['ignore','ignore','pipe','ipc']});
  const wait = () => new Promise((resolve,reject) => {
    const timer=setTimeout(() => finish(new Error('synthetic worker timed out')),10000);
    const onMessage=value => finish(null,value);
    const onExit=() => finish(new Error('synthetic worker exited'));
    const finish=(error,value) => { clearTimeout(timer); worker.off('message',onMessage); worker.off('exit',onExit); error ? reject(error) : resolve(value); };
    worker.once('message',onMessage); worker.once('exit',onExit);
  });
  const command = async value => { const promise=wait(); worker.send(value); return promise; };
  const stats = () => new Promise((resolve,reject) => http.get(`http://127.0.0.1:${port}/api/jevstats`,res => { let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}}); }).on('error',reject));
  try {
    await wait();
    let state;
    for(let i=0;i<100;i++) { try { state=await stats(); break; } catch { await new Promise(resolve=>setTimeout(resolve,20)); } }
    assert.ok(state);
    await command('start'); state=await stats();
    assert.equal(state.attempts,2); assert.equal(state.pendingAttempts,2); assert.equal(state.unpricedAttempts,0); assert.equal(state.estimatedCostUsd,0);
    await command('second-success'); state=await stats();
    assert.equal(state.pendingAttempts,1); assert.equal(state.calls,1); assert.equal(state.estimatedCostUsd,0.25);
    await command('first-fail'); state=await stats();
    assert.equal(state.pendingAttempts,0); assert.equal(state.unpricedAttempts,1); assert.equal(state.failures,1);
    await command('overflow'); state=await stats();
    assert.equal(state.estimatedCostUsd,null); assert.equal(state.pendingAttempts,0); assert.equal(state.unpricedAttempts,1);
  } finally {
    worker.kill(); await new Promise(resolve=>worker.exitCode!==null ? resolve() : worker.once('exit',resolve));
    const rel=path.relative(os.tmpdir(),root); if(!rel||rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('unsafe temporary path');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
