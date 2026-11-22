import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {Postgres} from '../src/storage/postgres.mjs';import {manageProcess} from '../src/runtime/lifecycle.mjs';
class Client extends EventEmitter{
 constructor(pool){super();this.pool=pool;this.released=false;}
 async query(sql){this.pool.queries.push(sql);if(this.pool.failQuery&&sql.startsWith('INSERT'))throw Object.assign(Error('synthetic connection reset'),{code:'ECONNRESET'});return{rows:[]};}
 release(){assert.equal(this.released,false);this.released=true;}
}
class Pool extends EventEmitter{constructor(){super();this.queries=[];}async connect(){if(this.offline)throw Object.assign(Error('synthetic unavailable'),{code:'ECONNREFUSED'});return new Client(this);}async end(){}}
test('idle pool disconnect recovers inside the same storage object and keeps the saved baseline without a singleton lease',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool}).open();let disconnected=0,reconnected=0;db.on('disconnected',()=>disconnected++);db.on('reconnected',()=>reconnected++);const snapshot={synthetic:'retained'};db.saved=snapshot;pool.emit('error',Error('synthetic-private-connection-details'));pool.emit('error',Error('duplicate'));assert.throws(()=>db.assertReady(),{code:'storage_unavailable'});assert.equal(disconnected,1);await db.health();db.assertReady();assert.equal(reconnected,1);assert.equal(db.saved,snapshot);assert.equal(db.lease,undefined);assert.ok(!pool.queries.some(sql=>sql.includes('advisory_lock')));await db.close();
});
test('outage rejects database work; a later health probe reconnects without closing or restarting the application',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool}).open();pool.offline=true;await assert.rejects(db.health(),{code:'storage_unavailable'});assert.throws(()=>db.assertReady(),{code:'storage_unavailable'});assert.equal(db.closed,false);pool.offline=false;await db.health();db.assertReady();await db.putDocument('synthetic',{retained:true});await db.close();await assert.rejects(db.health(),{code:'storage_unavailable'});
});
test('failed writes are not replayed automatically after reconnect',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool}).open();pool.failQuery=true;await assert.rejects(db.putDocument('synthetic',{}),{code:'storage_unavailable'});assert.equal(pool.queries.filter(s=>s.startsWith('INSERT')).length,1);pool.failQuery=false;await db.health();assert.equal(pool.queries.filter(s=>s.startsWith('INSERT')).length,1);await db.putDocument('synthetic',{});assert.equal(pool.queries.filter(s=>s.startsWith('INSERT')).length,2);await db.close();
});
function application({hang=false}={}){
 const calls=[],runtime=new EventEmitter(),storage=new EventEmitter();runtime.exit=code=>calls.push('exit:'+code);storage.close=async()=>calls.push('storage.close');const app={storage,logger:{error:(event,fields)=>calls.push(event+':'+fields.code)},server:{close:()=>calls.push('server.close'),closeIdleConnections(){}},tasks:{close(){}},loginManager:{close(){}},browserSync:{close:async()=>{}},catalogRefresh:{close:async()=>{}},store:{pending:Promise.resolve()},backends:{close:()=>hang?new Promise(()=>{}):Promise.resolve()},runner:{close:async()=>calls.push('runner.close')},authVault:{close:async()=>{}}};return{app,runtime,calls};
}
test('database disconnect does not stop the process; explicit service signals still clean up normally',async()=>{
 const t=application(),controller=manageProcess(t.app,{runtime:t.runtime});t.app.storage.emit('disconnected');assert.equal(t.calls.length,0);t.runtime.emit('SIGTERM');await controller.stop(0);assert.equal(t.calls.filter(c=>c==='exit:0').length,1);assert.ok(t.calls.indexOf('server.close')<t.calls.indexOf('runner.close'));assert.ok(t.calls.includes('storage.close'));
});
test('explicit shutdown remains bounded even if a provider stalls',async()=>{
 const t=application({hang:true});let deadline;const c=manageProcess(t.app,{runtime:t.runtime,setTimer:f=>(deadline=f,{unref(){}}),clearTimer(){}});void c.stop(0);await new Promise(r=>setImmediate(r));deadline();assert.ok(t.calls.includes('exit:0'));
});

test('background retry restores the same process even when nobody calls the health endpoint',async()=>{
 const pool=new Pool(),db=await new Postgres('synthetic',{pool,reconnectMs:5}).open();pool.offline=true;await assert.rejects(db.health(),{code:'storage_unavailable'});const recovered=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('automatic reconnect timeout')),1000);db.once('reconnected',()=>{clearTimeout(timeout);resolve();});});pool.offline=false;await recovered;db.assertReady();assert.equal(db.closed,false);await db.close();assert.equal(db.retryTimer,null);
});
