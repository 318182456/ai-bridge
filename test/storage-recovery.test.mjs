import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {Postgres} from '../src/storage/postgres.mjs';import {manageProcess} from '../src/runtime/lifecycle.mjs';
class Client extends EventEmitter{
 constructor(){super();this.releases=[];}
 async query(sql){if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};return{rows:[]};}
 release(destroy){this.releases.push(destroy);this.rejectQuery?.(Error('synthetic closed'));}
}
class Pool extends EventEmitter{constructor(){super();this.lease=new Client();this.clients=[];}async connect(){if(!this.opened){this.opened=true;return this.lease;}const c=new Client();this.clients.push(c);return c;}async end(){}}
test('loss of the PG singleton connection destroys in-flight queries, rejects stale writes and only signals once',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool}).open();let failures=0;db.on('failure',()=>failures++);const c=new Client();c.query=()=>new Promise((_r,reject)=>c.rejectQuery=reject);pool.connect=async()=>c;const query=db.query('synthetic query');const rejected=assert.rejects(query,{code:'storage_unavailable'});await new Promise(r=>setImmediate(r));pool.lease.emit('error',Error('synthetic-private-connection-string'));pool.lease.emit('end');await rejected;assert.equal(failures,1);assert.equal(db.failed,true);assert.deepEqual(c.releases,[true]);await assert.rejects(db.putDocument('state',{}),{code:'storage_unavailable'});await db.close();assert.equal(failures,1);
});
test('a connection acquired after lease failure is destroyed without executing a queued query',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool}).open();let resolveClient;pool.connect=()=>new Promise(r=>resolveClient=r);const work=db.query('must not execute');const rejected=assert.rejects(work,{code:'storage_unavailable'});db.fail();const client=new Client();client.query=()=>assert.fail('stale query ran');resolveClient(client);await rejected;assert.deepEqual(client.releases,[true]);await db.close();
});
function application({hang=false}={}){
 const calls=[],runtime=new EventEmitter(),storage=new EventEmitter();runtime.exit=code=>calls.push('exit:'+code);storage.close=async()=>calls.push('storage.close');const app={storage,logger:{error:(event,fields)=>calls.push(event+':'+fields.code)},server:{close:()=>calls.push('server.close'),closeIdleConnections(){}},tasks:{close(){}},loginManager:{close(){}},browserSync:{close:async()=>{}},catalogRefresh:{close:async()=>{}},store:{pending:Promise.resolve()},backends:{close:()=>hang?new Promise(()=>{}):Promise.resolve()},runner:{close:async()=>calls.push('runner.close')},authVault:{close:async()=>{}}};return{app,runtime,calls};
}
test('lease loss automatically stops accepting requests, cleans providers and exits nonzero for the service supervisor',async()=>{
 const t=application(),controller=manageProcess(t.app,{runtime:t.runtime});t.app.storage.emit('failure');t.app.storage.emit('failure');await controller.stop(0);assert.equal(t.calls.filter(c=>c==='exit:1').length,1);assert.ok(t.calls.indexOf('server.close')<t.calls.indexOf('runner.close'));assert.ok(t.calls.includes('storage.close'));assert.ok(!t.calls.includes('exit:0'));assert.equal(t.calls.filter(c=>c.startsWith('storage.restart_required')).length,1);
});
test('stuck shutdown has a deadline; ordinary signals exit cleanly and failures during shutdown cannot be downgraded',async()=>{
 const hanging=application({hang:true});let deadline;manageProcess(hanging.app,{runtime:hanging.runtime,setTimer:f=>(deadline=f,{unref(){}}),clearTimer(){}});hanging.app.storage.emit('failure');await new Promise(r=>setImmediate(r));deadline();assert.ok(hanging.calls.includes('exit:1'));
 const normal=application(),lifecycle=manageProcess(normal.app,{runtime:normal.runtime});normal.runtime.emit('SIGTERM');await lifecycle.stop(0);assert.ok(normal.calls.includes('exit:0'));
 const changed=application(),late=manageProcess(changed.app,{runtime:changed.runtime});changed.runtime.emit('SIGTERM');changed.app.storage.emit('failure');await late.stop(0);assert.ok(changed.calls.includes('exit:1'));
});
