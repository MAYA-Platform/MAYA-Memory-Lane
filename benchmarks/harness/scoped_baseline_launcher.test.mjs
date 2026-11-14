import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {supervise} from './scoped_baseline_launcher.mjs';
const GiB=1024**3;
function child(){const c=new EventEmitter();c.kill=()=>{queueMicrotask(()=>c.emit('close',null,'SIGTERM'));return true;};return c;}
test('low admission blocks spawn',async()=>{let started=false;await assert.rejects(supervise({start:()=>{started=true;},freeBytes:()=>GiB}),/insufficient/);assert.equal(started,false);});
test('deadline and sampled low memory terminate and await close',async()=>{
 await assert.rejects(supervise({start:child,freeBytes:()=>4*GiB,timeoutMs:5}),/deadline/);
 let n=0;await assert.rejects(supervise({start:child,freeBytes:()=>++n===1?4*GiB:GiB,intervalMs:5}),/low memory/);
});
test('unconfirmed exit is reported within bounded cleanup',async()=>{const c=child();c.kill=()=>true;c.unref=()=>{};await assert.rejects(supervise({start:()=>c,freeBytes:()=>4*GiB,timeoutMs:5,cleanupMs:5}),/exit unconfirmed/);});
