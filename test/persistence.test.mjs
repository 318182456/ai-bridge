import test from 'node:test';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {AuthVault} from '../src/storage/auth-vault.mjs';
import {Postgres} from '../src/storage/postgres.mjs';
import {Store} from '../src/store.mjs';
import {accountDirectory} from '../public/js/components/account-directory.mjs';

const mockStorage=()=>{const rows=new Map();return{rows,profile:async(k,id)=>rows.get(k+id)||null,putProfile:async(k,id,archive,metadata)=>rows.set(k+id,{archive,metadata,checksum:createHash('sha256').update(archive).digest('hex')})};};
test('credential snapshots restore a missing keyring and retain last valid backup when sync fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-bridge-vault-test-')),storage=mockStorage(),vault=new AuthVault(storage,root),id='a_'+'1'.repeat(16),home=vault.path('agy',id),key=join(home,'.local/share/keyrings/login.keyring');
 try{
  await mkdir(join(home,'.local/share/keyrings'),{recursive:true});await writeFile(key,'synthetic-encrypted-keyring');await mkdir(join(home,'.gemini/antigravity-cli/log'),{recursive:true});await writeFile(join(home,'.gemini/antigravity-cli/log/trace'),'synthetic-runtime-log');await writeFile(join(home,'settings.json'),'synthetic-private-config');vault.mark('agy',id);assert.equal(await vault.capture('agy',id,{strict:true}),true);
  await rm(key);assert.equal(await vault.restore('agy',id),true);assert.equal(await readFile(key,'utf8'),'synthetic-encrypted-keyring');
  const paths=await vault.validate(storage.rows.get('agy'+id).archive);assert.ok(!paths.some(p=>p.includes('/log/')));
  const before=storage.rows.get('agy'+id).checksum;storage.putProfile=async()=>{throw Error('synthetic unavailable database');};vault.mark('agy',id);await writeFile(key,'synthetic-new-keyring');assert.equal(await vault.capture('agy',id),false);assert.equal(storage.rows.get('agy'+id).checksum,before);assert.equal(vault.status().unsynced_profiles,1);assert.equal(await readFile(key,'utf8'),'synthetic-new-keyring');
  await assert.rejects(vault.restore('agy','../escape'),{status:400});
 }finally{await vault.close();await rm(root,{recursive:true,force:true});}
});
test('account directory merges explicit links once but never merges matching display names',()=>{
 const native=[{id:'a_1',name:'same',enabled:true,models:[],requests:2,successes:2,failures:0,total_tokens:8,token_reports:2},{id:'a_2',name:'same',enabled:true,models:[]}];
 const google=[{id:'g_1',label:'same',agy_account_id:'a_1',enabled:true,models:[],usage:{aist:{requests:3,successes:2,failures:1,total_tokens:10,reports:2}}},{id:'g_2',label:'same',enabled:false,name:'Robin display',models:[],robin_models:[{id:'robin-only'}]}];
 const rows=accountDirectory(native,google);assert.equal(rows.length,3);assert.equal(rows.filter(a=>a.native?.id==='a_1').length,1);assert.equal(rows[0].requests,5);assert.equal(rows[0].total_tokens,18);assert.equal(rows.at(-1).id,'a_2');assert.equal(rows[1].model_count,1);assert.equal(rows[1].name,'Robin display');
});

test('PostgreSQL persists normalized state and snapshots across restart, recovers live connections and preserves rollback',{skip:!process.env.PG_TEST_URL},async()=>{
 const url=process.env.PG_TEST_URL,root=await mkdtemp(join(tmpdir(),'ai-bridge-pg-test-'));let db=await new Postgres(url).open();
 try{
  const store=await new Store(root,db).init();const a=await store.create({name:'synthetic-pg-account'});await store.createKeys([{name:'synthetic-key',value:'synthetic-private-api-key-123456789'}]);
  await store.event({id:'event-one',status:400,code:'synthetic_error'});await db.putDocument('google-grant/g_test',{synthetic_refresh:'synthetic-value'});
  const second=await new Postgres(url).open();await second.close();const failed={...structuredClone(store.state),accounts:[...store.state.accounts,{name:'invalid-no-id'}]};await assert.rejects(db.saveState(failed),{code:'storage_unavailable'});
  await db.close();db=await new Postgres(url).open();const reopened=await new Store(root,db).init();assert.equal(reopened.state.accounts.length,1);assert.equal(reopened.state.accounts[0].id,a.id);assert.equal(reopened.state.keys.length,1);assert.equal(reopened.state.events.length,1);assert.equal((await db.document('google-grant/g_test')).synthetic_refresh,'synthetic-value');
  const vault=new AuthVault(db,root),home=vault.path('agy',a.id);await mkdir(home,{recursive:true});await writeFile(join(home,'settings.json'),'synthetic-profile');vault.mark('agy',a.id);assert.equal(await vault.capture('agy',a.id,{strict:true}),true);await vault.close();
  await db.close();db=await new Postgres(url).open();await db.loadState();await rm(home,{recursive:true});const restored=new AuthVault(db,root);assert.equal(await restored.restore('agy',a.id),true);assert.equal(await readFile(join(home,'settings.json'),'utf8'),'synthetic-profile');await restored.forget('agy',a.id);assert.equal(await db.profile('agy',a.id),null);assert.equal(await restored.restore('agy',a.id),false);await restored.close();
  // Use the current storage after restart for the deletion check.
  reopened.storage=db;
  reopened.state.events=[];await reopened.save();assert.equal((await db.query('SELECT count(*)::int AS count FROM ai_bridge.request_events')).rows[0].count,0);
  // Terminate only an idle connection owned by this isolated test service. The app PID must stay alive.
  await db.close();const control=new pg.Pool({connectionString:url,max:1});let child;
  const start=async()=>{const p=fork(new URL('./fixtures/storage-process.mjs',import.meta.url),[],{env:{...process.env,DATABASE_URL:url,STORAGE_BACKEND:'postgresql',DATA_DIR:join(root,'supervised'),ADMIN_PASSWORD:'synthetic-recovery-password-12345',API_KEY:'synthetic-recovery-api-key-12345'},stdio:['ignore','ignore','ignore','ipc']});child=p;return await Promise.race([once(p,'message').then(([v])=>v),once(p,'exit').then(()=>{throw Error('recovery child exited before ready');}),new Promise((_r,reject)=>{const timer=setTimeout(()=>reject(Error('recovery child startup timed out')),15000);timer.unref();})]);};
  try{
   const before=await start();assert.equal(before.accounts,1);assert.equal(child.pid,before.process);
   const base='http://127.0.0.1:'+before.port;const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'synthetic-recovery-password-12345'})});const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal(login.status,200);
   await control.query('SELECT pg_terminate_backend($1)',[before.pid]);
   let status=0;const until=Date.now()+5000;while(Date.now()<until){status=(await fetch(base+'/health')).status;if(status===200)break;await new Promise(r=>setTimeout(r,50));}assert.equal(status,200);assert.equal(child.exitCode,null);assert.equal(child.pid,before.process);
   const accounts=await(await fetch(base+'/api/accounts',{headers:{cookie}})).json();assert.equal(accounts.accounts.length,1);assert.equal(accounts.accounts[0].id,a.id);assert.equal(accounts.accounts[0].name,'synthetic-pg-account');
   const other=await new Postgres(url).open();await other.close();assert.equal((await control.query('SELECT pg_backend_pid() AS pid')).rows.length,1);
   const ended=once(child,'exit');child.kill('SIGTERM');assert.equal((await ended)[0],0);child=null;
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}await control.end();}
  db=await new Postgres(url).open();const fresh=await new Store(root,db).init();assert.equal(fresh.state.accounts[0].id,a.id);assert.equal(fresh.state.keys.length,1);assert.equal((await db.document('google-grant/g_test')).synthetic_refresh,'synthetic-value');

 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});

test('suspended validation never overwrites the last verified credential snapshot',async()=>{const root=await mkdtemp(join(tmpdir(),'ai-bridge-reauth-snapshot-')),storage=mockStorage(),vault=new AuthVault(storage,root),id='g_'+'d'.repeat(24),home=vault.path('google',id);try{await mkdir(home,{recursive:true});await writeFile(join(home,'Preferences'),'synthetic-old');vault.mark('google',id);await vault.capture('google',id,{strict:true});const before=storage.rows.get('google'+id).checksum;vault.unmark('google',id);await writeFile(join(home,'Preferences'),'synthetic-unverified');assert.equal(await vault.capture('google',id),false);assert.equal(storage.rows.get('google'+id).checksum,before);await vault.restore('google',id,{force:true});assert.equal(await readFile(join(home,'Preferences'),'utf8'),'synthetic-old');}finally{await vault.close();await rm(root,{recursive:true,force:true});}});
