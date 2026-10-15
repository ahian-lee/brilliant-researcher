import {renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

interface AtomicWriteOperations {
 write:typeof writeFileSync;
 rename:typeof renameSync;
 unlink:typeof unlinkSync;
 wait:(milliseconds:number)=>void;
}
const operations:AtomicWriteOperations={write:writeFileSync,rename:renameSync,unlink:unlinkSync,wait:milliseconds=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);}};

/** Windows readers can briefly deny replacement. Never remove the last good file. */
export function atomicWriteFileSync(target:string,content:string,io:AtomicWriteOperations=operations){
 const temporary=`${target}.${randomUUID()}.tmp`;
 try{
  io.write(temporary,content);
  const delays=[10,25,50,100,200,400];
  for(let attempt=0;;attempt++){
   try{io.rename(temporary,target);return;}
   catch(error){if(!['EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=delays.length)throw error;io.wait(delays[attempt]);}
  }
 }finally{
  try{io.unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
}
