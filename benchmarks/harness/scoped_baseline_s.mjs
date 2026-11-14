// Explicitly separate S split; no runtime download and no model/provider.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runSubset} from './scoped_baseline.mjs';import {supervise} from './scoped_baseline_launcher.mjs';
const SHA='d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
const SIZE=277383467;
export function verifyBytes(bytes,size,expected){if(bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('dataset size or hash mismatch');return JSON.parse(bytes);}
function worker(file,root){
 const dataset=verifyBytes(fs.readFileSync(file),SIZE,SHA);fs.mkdirSync(root,{recursive:true});const output=path.join(root,`s-smoke-${randomUUID()}`);
 const summary=runSubset(dataset,output,{limit:2,datasetSha:SHA,datasetLabel:'cleaned-S'});console.log(JSON.stringify({output,...summary}));if(summary.errors)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length===5&&process.argv[2]==='--worker')try{worker(process.argv[3],process.argv[4]);}catch(error){console.error(error.message);process.exitCode=1;}
 else if(process.argv.length===4&&process.argv[2]!=='--worker'){const script=fileURLToPath(import.meta.url);supervise({freeBytes:os.freemem,admission:4*1024**3,floor:2*1024**3,timeoutMs:90000,start:()=>spawn(process.execPath,['--max-old-space-size=1024',script,'--worker',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true})}).then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.message);process.exitCode=1;});}
 else{console.error('invalid arguments');process.exitCode=2;}
}
