// Bounded, sampled smoke supervisor. Not a hard OS memory or process-tree limit.
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const GiB=1024**3;
export async function supervise({start,freeBytes,timeoutMs=30000,intervalMs=500,cleanupMs=3000,admission=3*GiB,floor=1.5*GiB}){
 if(freeBytes()<admission)throw Error('insufficient memory');
 const child=start();let stopReason=null,stopError=null,deadline,monitor,cleanup;
 try{return await new Promise((resolve,reject)=>{
  let childError=null;
  const stop=reason=>{if(stopReason)return;stopReason=reason;try{if(!child.kill())stopError=Error('termination request failed');}catch(error){stopError=error;}
   cleanup=setTimeout(()=>{child.unref?.();reject(new Error(`${reason}; child exit unconfirmed`,{cause:stopError||undefined}));},cleanupMs);};
  child.on('error',error=>{childError=error;});
  child.once('close',(code,signal)=>{if(stopReason)reject(new Error(stopReason,{cause:stopError||childError||undefined}));else if(childError)reject(childError);else if(code!==0)reject(Error(`smoke failed (${code??signal})`));else resolve({status:'completed'});});
  deadline=setTimeout(()=>stop('smoke deadline exceeded'),timeoutMs);
  monitor=setInterval(()=>{try{if(freeBytes()<floor)stop('low memory');}catch{stop('memory check failed');}},intervalMs);
 });}finally{clearTimeout(deadline);clearInterval(monitor);clearTimeout(cleanup);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const script=fileURLToPath(new URL('./scoped_baseline.mjs',import.meta.url));
 if(process.argv.length!==4){console.error('expected dataset file and output parent');process.exitCode=2;}
 else supervise({freeBytes:os.freemem,start:()=>spawn(process.execPath,[script,...process.argv.slice(2)],{stdio:'inherit',windowsHide:true})}).then(r=>console.log(JSON.stringify(r)),error=>{console.error(error.message);process.exitCode=1;});
}
