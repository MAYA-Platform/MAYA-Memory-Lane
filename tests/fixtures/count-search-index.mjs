// Instrument synthetic server indexes without touching real libraries.
import fs from 'node:fs';
const getBuiltin=process.getBuiltinModule.bind(process);
const sqlite=getBuiltin('node:sqlite');
if (sqlite) {
  const DatabaseSync=new Proxy(sqlite.DatabaseSync, {construct(target,args,newTarget){
    fs.appendFileSync(process.env.INDEX_COUNT_FILE,'1\n');
    return Reflect.construct(target,args,newTarget);
  }});
  const wrapped={...sqlite,DatabaseSync};
  process.getBuiltinModule=name=>name==='node:sqlite'?wrapped:getBuiltin(name);
}
