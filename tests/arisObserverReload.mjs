// Read-only observer picks up explicitly registered projects without a restart.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
const fixture=mkdtempSync(resolve('var/observer-reload-'));
const config=join(fixture,'projects.json');
for(const name of ['first','second']) mkdirSync(join(fixture,name));
const write=projects=>writeFileSync(config,JSON.stringify({projects}));
write([{id:'first',root:'first'}]);
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.execPath,['upstream/aris/integrations/dashboard/server.mjs',config,String(port)],{stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
const api=async()=>await fetch(`http://127.0.0.1:${port}/api/projects`);
try {
  let response;
  for(let i=0;i<60;i++) {
    try{response=await api();if(response.ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(response?.status,200,logs);
  assert.equal((await response.json()).projects.length,1);
  write([{id:'first',root:'first'},{id:'second',root:'second'}]);
  response=await api();assert.equal(response.status,200);
  assert.deepEqual((await response.json()).projects.map(p=>p.id),['first','second']);
  writeFileSync(config,'{bad');
  assert.equal((await api()).status,500,'Malformed new registration must surface a readable error');
  write([{id:'second',root:'second'}]);
  response=await api();assert.equal(response.status,200);
  assert.deepEqual((await response.json()).projects.map(p=>p.id),['second']);
  const journal=await fetch(`http://127.0.0.1:${port}/api/project-journal?projectId=second`).then(r=>r.json());
  assert.equal(journal.scope,'project');
  assert.equal(journal.project_id,'second');
  assert.deepEqual(journal.events,[]);
  const denied=await fetch(`http://127.0.0.1:${port}/api/projects`,{method:'POST'});
  assert.equal(denied.status,405);
  console.log('PASS observer reload: add/remove, malformed file recovery, read-only endpoint; no model calls');
}finally{
  if(child.exitCode===null && child.signalCode===null) {
    const stopped=new Promise(resolve=>child.once('exit',resolve));
    child.kill();await stopped;
  }
  rmSync(fixture,{recursive:true,force:true});
}
